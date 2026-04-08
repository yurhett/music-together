import { timingSafeEqual } from 'node:crypto'
import type { AudioQuality, RoomListItem, User } from '@music-together/shared'
import { nanoid } from 'nanoid'
import type { RoomData } from '../repositories/types.js'
import { roomRepo } from '../repositories/roomRepository.js'
import { chatRepo } from '../repositories/chatRepository.js'
import { config } from '../config.js'
import { scheduleDeletion, cancelDeletionTimer } from './roomLifecycleService.js'
import { consumeRejoinTicket } from './rejoinTicketService.js'
import { estimateCurrentTime } from './syncService.js'
import { updateVoteThreshold } from './voteService.js'
import { logger } from '../utils/logger.js'
import type { TypedServer } from '../middleware/types.js'
import { getOrCreateRadioConductor, destroyRadioConductor, getRadioConductor } from './radioConductor.js'
import { playNextTrackInRoom, cleanupRoom as cleanupPlayerRoom } from './playerService.js'

// Re-export from their new homes so existing `roomService.xxx()` callers
// in controllers don't need import changes.
export { toPublicRoomState, toPublicRoomStateForOwner } from '../utils/roomUtils.js'
export { broadcastRoomList } from './roomLifecycleService.js'

// ---------------------------------------------------------------------------
// Conductor (hostId) election — auto-selects the highest priority online user
// ---------------------------------------------------------------------------

/**
 * 从在线用户中选出最高优先级的 conductor（播放主持）。
 * 优先级：owner > admin > member（按加入顺序）。
 * 若 conductor 变更且正在播放，刷新 playState 时间戳以确保
 * 新 conductor 的首次 report 不被 validateConductorReport 拒绝。
 */
function electConductor(room: RoomData): boolean {
  const prev = room.hostId
  const candidate =
    room.users.find((u) => u.role === 'owner') ?? room.users.find((u) => u.role === 'admin') ?? room.users[0]
  room.hostId = candidate?.id ?? room.hostId

  if (room.hostId !== prev) {
    if (room.playState.isPlaying) {
      room.playState = {
        ...room.playState,
        currentTime: estimateCurrentTime(room.id),
        serverTimestamp: Date.now(),
      }
    }
    return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Public API — Room CRUD
// ---------------------------------------------------------------------------

export function createRoom(
  socketId: string,
  nickname: string,
  roomName?: string,
  password?: string | null,
  persistentUserId?: string,
  radioMode = false,
): { room: RoomData; user: User } | { error: string; code: string } {
  // 电台模式数量上限检查
  if (radioMode) {
    const radioCount = Array.from(roomRepo.getAll().values()).filter((r) => r.radioMode).length
    if (radioCount >= config.room.maxRadioRooms) {
      return { error: `电台房间数量已达到上限 (${config.room.maxRadioRooms})，请稍后再试`, code: 'RADIO_LIMIT_REACHED' }
    }
  }

  const roomId = nanoid(6).toUpperCase()
  const userId = persistentUserId || socketId

  const user: User = { id: userId, nickname, role: 'owner' }

  const room: RoomData = {
    id: roomId,
    name: roomName?.trim() || `${nickname}的房间`,
    password: password || null,
    creatorId: userId,
    hostId: userId,
    adminUserIds: new Set(),
    audioQuality: 320,
    users: [user],
    queue: [],
    currentTrack: null,
    playState: {
      isPlaying: false,
      currentTime: 0,
      serverTimestamp: Date.now(),
    },
    playMode: 'loop-all',
    radioMode,
  }

  roomRepo.set(roomId, room)
  chatRepo.createRoom(roomId)
  roomRepo.setSocketMapping(socketId, roomId, userId)

  logger.info(`Room created: ${roomId} by ${nickname}${radioMode ? ' [RADIO]' : ''}`, { roomId })
  return { room, user }
}

export function joinRoom(
  socketId: string,
  roomId: string,
  nickname: string,
  persistentUserId?: string,
): { room: RoomData; user: User; hostChanged: boolean } | null {
  const room = roomRepo.get(roomId)
  if (!room) return null

  // Cancel any pending room deletion (e.g. user refreshed and is rejoining)
  cancelDeletionTimer(roomId)

  const userId = persistentUserId || socketId
  const isCreator = userId === room.creatorId

  // Determine the permission role — purely based on identity, no grace logic
  function resolveRole(): User['role'] {
    if (isCreator) return 'owner'
    if (room!.adminUserIds.has(userId)) return 'admin'
    return 'member'
  }

  // Rejoin — update existing user entry instead of creating duplicate
  const existing = room.users.find((u) => u.id === userId)
  if (existing) {
    existing.nickname = nickname
    existing.role = resolveRole()
    roomRepo.setSocketMapping(socketId, roomId, userId)
    const hostChanged = electConductor(room)
    return { room, user: existing, hostChanged }
  }

  // New user entry
  const role = resolveRole()
  const user: User = { id: userId, nickname, role }
  room.users.push(user)
  roomRepo.setSocketMapping(socketId, roomId, userId)

  // Re-elect conductor (owner joining takes priority over current conductor)
  const hostChanged = electConductor(room)

  logger.info(`User ${nickname} joined room ${roomId} as ${role}`, { roomId })
  return { room, user, hostChanged }
}

export function leaveRoom(
  socketId: string,
  io?: TypedServer,
): {
  roomId: string
  user: User
  room: RoomData | null
  hostChanged: boolean
  voteUpdated: boolean
} | null {
  const mapping = roomRepo.getSocketMapping(socketId)
  if (!mapping) return null

  const { roomId, userId } = mapping
  const room = roomRepo.get(roomId)
  if (!room) return null

  // Race condition guard: if the user has another active socket in this room
  // (e.g. page refresh — new socket joined before old socket disconnected),
  // only clean up the stale mapping without removing the user from the room.
  if (roomRepo.hasOtherSocketForUser(roomId, userId, socketId)) {
    roomRepo.deleteSocketMapping(socketId)
    logger.info(`Stale disconnect for user ${userId} in room ${roomId} — newer socket exists`, { roomId })
    return null
  }

  const user = room.users.find((u) => u.id === userId)
  if (!user) return null

  room.users = room.users.filter((u) => u.id !== userId)
  roomRepo.deleteSocketMapping(socketId)

  // 电台模式：房间空置时不删除，走带器继续运行
  // 普通模式：安排宽限期删除
  if (room.users.length === 0) {
    if (!room.radioMode) {
      scheduleDeletion(roomId, io)
    } else {
      logger.info(`Radio room ${roomId} is empty — keeping alive`, { roomId })
    }
    return { roomId, user, room, hostChanged: false, voteUpdated: false }
  }

  // Re-elect conductor immediately — no grace period
  const hostChanged = electConductor(room)

  // Update active vote threshold so it doesn't become impossible to pass
  const voteUpdated = updateVoteThreshold(roomId, room.users.length, user.id)

  logger.info(`User ${user.nickname} left room ${roomId}`, { roomId })
  return { roomId, user, room, hostChanged, voteUpdated }
}

// ---------------------------------------------------------------------------
// Public API — Read / Settings / Roles
// ---------------------------------------------------------------------------

export function getRoom(roomId: string): RoomData | undefined {
  return roomRepo.get(roomId)
}

export function listRooms(): RoomListItem[] {
  return roomRepo.getAllAsList()
}

export function updateSettings(
  io: TypedServer | null,
  roomId: string,
  settings: { name?: string; password?: string | null; audioQuality?: AudioQuality; radioMode?: boolean },
): void {
  const room = roomRepo.get(roomId)
  if (!room) return

  if (settings.name !== undefined) {
    room.name = settings.name
  }

  // password: string -> set password; null -> remove password; undefined -> no change
  if (settings.password !== undefined) {
    room.password = settings.password
  }

  if (settings.audioQuality !== undefined) {
    room.audioQuality = settings.audioQuality
  }

  // 电台模式切换处理
  if (settings.radioMode !== undefined && settings.radioMode !== room.radioMode) {
    if (settings.radioMode) {
      // 开启电台模式：检查数量上限
      const radioCount = Array.from(roomRepo.getAll().values()).filter((r) => r.radioMode).length
      if (radioCount >= config.room.maxRadioRooms) {
        logger.warn(`Radio room limit reached, cannot enable for room ${roomId}`, { roomId })
        return
      }
      room.radioMode = true
      // 当前有翡目且正在播放 → 立即启动 conductor
      if (room.currentTrack && room.playState.isPlaying && io) {
        const conductor = getOrCreateRadioConductor(roomId, io, (rid) =>
          playNextTrackInRoom(io, rid, roomRepo.get(rid)?.playMode ?? 'loop-all', { skipDebounce: true }),
        )
        conductor.start()
      }
      logger.info(`Radio mode ENABLED for room ${roomId}`, { roomId })
    } else {
      // 关闭电台模式：销毁 conductor
      room.radioMode = false
      destroyRadioConductor(roomId)
      logger.info(`Radio mode DISABLED for room ${roomId}`, { roomId })
    }
  }
}

/**
 * 房主解散房间 — 立即删除房间（无论普通/电台模式），无宽限期。
 * 由 roomController 的 ROOM_DISSOLVE 事件触发。
 * 返回被解散的房间数据（含用户列表），供 controller 广播 ROOM_DISSOLVED。
 */
export function dissolveRoom(roomId: string): { users: User[]; name: string } | null {
  const room = roomRepo.get(roomId)
  if (!room) return null

  const { users, name } = room

  // 清理所有资源（与 roomLifecycleService 的 scheduleDeletion 回调保持一致）
  roomRepo.delete(roomId)
  chatRepo.deleteRoom(roomId)
  cleanupPlayerRoom(roomId) // 这同时会 destroyRadioConductor
  cancelDeletionTimer(roomId)

  // 清理所有成员的 socket mapping
  for (const user of users) {
    // socket mapping 在 leaveRoom 时清理，这里只需确保数据层已删除
    void user
  }

  logger.info(`Room ${roomId} dissolved by owner (had ${users.length} users)`, { roomId })
  return { users, name }
}

export function setUserRole(roomId: string, targetUserId: string, role: 'admin' | 'member'): boolean {
  const room = roomRepo.get(roomId)
  if (!room) return false
  const user = room.users.find((u) => u.id === targetUserId)
  if (!user) return false
  // Cannot change owner's role
  if (user.role === 'owner') return false
  user.role = role
  // Sync persistent admin set
  if (role === 'admin') {
    room.adminUserIds.add(targetUserId)
  } else {
    room.adminUserIds.delete(targetUserId)
  }
  // Re-elect conductor (admin promotion/demotion may change priority)
  electConductor(room)
  return true
}

export function getUserBySocket(socketId: string): User | null {
  const mapping = roomRepo.getSocketMapping(socketId)
  if (!mapping) return null
  const room = roomRepo.get(mapping.roomId)
  if (!room) return null
  return room.users.find((u) => u.id === mapping.userId) ?? null
}

export function getRoomBySocket(socketId: string): { roomId: string; room: RoomData } | null {
  const mapping = roomRepo.getSocketMapping(socketId)
  if (!mapping) return null
  const room = roomRepo.get(mapping.roomId)
  if (!room) return null
  return { roomId: mapping.roomId, room }
}

// ---------------------------------------------------------------------------
// Join validation (business logic extracted from roomController)
// ---------------------------------------------------------------------------

/** Constant-time string comparison to mitigate timing attacks */
function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

export interface JoinValidationResult {
  valid: boolean
  errorCode?: string
  errorMessage?: string
  /** Whether this is a rejoin (user already in room or same socket mapping) — skip join notification */
  isRejoin: boolean
  /** Whether password should be bypassed (rejoin, creator, or persistent admin) */
  skipPassword: boolean
}

/**
 * Validate a join request: check room existence, password, rejoin scenarios.
 * Pure business logic — no socket operations.
 */
export function validateJoinRequest(
  roomId: string,
  socketId: string,
  identityUserId: string,
  password?: string,
  rejoinToken?: string,
): JoinValidationResult {
  const room = roomRepo.get(roomId)
  if (!room) {
    return {
      valid: false,
      errorCode: 'ROOM_NOT_FOUND',
      errorMessage: '房间不存在',
      isRejoin: false,
      skipPassword: false,
    }
  }

  const existingMapping = roomRepo.getSocketMapping(socketId)
  const effectiveUserId = identityUserId
  const alreadyInRoom = room.users.some((u) => u.id === effectiveUserId)
  const isCreator = effectiveUserId === room.creatorId
  const isPersistentAdmin = room.adminUserIds.has(effectiveUserId)
  const hasValidRejoinTicket =
    typeof rejoinToken === 'string' && rejoinToken.length > 0
      ? consumeRejoinTicket(rejoinToken, roomId, effectiveUserId)
      : false

  // Password bypass: same socket mapping, already in room, creator, or persistent admin
  const skipPassword =
    hasValidRejoinTicket || existingMapping?.roomId === roomId || alreadyInRoom || isCreator || isPersistentAdmin
  // Notification skip: only when user is literally still in the room
  const isRejoin = existingMapping?.roomId === roomId || alreadyInRoom

  if (!skipPassword && room.password !== null) {
    if (!password || !safeCompare(password, room.password)) {
      return { valid: false, errorCode: 'WRONG_PASSWORD', errorMessage: '密码错误', isRejoin, skipPassword }
    }
  }

  // Auto-leave check: if the socket is mapped to a different room, the caller
  // should call leaveRoom before proceeding. We just flag the scenario here.

  return { valid: true, isRejoin, skipPassword }
}
