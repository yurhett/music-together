import type { AudioQuality, MusicSource, PlayMode, PlayState, ScheduledPlayState, Track } from '@music-together/shared'
import { EVENTS, ERROR_CODE, NTP } from '@music-together/shared'
import { roomRepo } from '../repositories/roomRepository.js'
import { musicProvider } from './musicProvider.js'
import * as queueService from './queueService.js'
import * as authService from './authService.js'
import { estimateCurrentTime } from './syncService.js'
import { broadcastRoomList } from './roomLifecycleService.js'
import { toPublicRoomState } from '../utils/roomUtils.js'
import { config } from '../config.js'
import { logger } from '../utils/logger.js'
import type { RoomData } from '../repositories/types.js'
import type { TypedServer, TypedSocket } from '../middleware/types.js'

// ---------------------------------------------------------------------------
// Per-room mutex for playTrackInRoom (prevents concurrent execution)
// ---------------------------------------------------------------------------

const playMutexes = new Map<string, Promise<unknown>>()
const radioAutoNextTimers = new Map<string, ReturnType<typeof setTimeout>>()
const radioAutoNextGeneration = new Map<string, number>()

function withPlayMutex<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
  const prev = playMutexes.get(roomId) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  playMutexes.set(roomId, next)
  // Cleanup entry when chain settles to avoid unbounded growth
  next.finally(() => {
    if (playMutexes.get(roomId) === next) playMutexes.delete(roomId)
  })
  return next
}

function clearRadioAutoNextTimer(roomId: string): void {
  const timer = radioAutoNextTimers.get(roomId)
  if (timer) {
    clearTimeout(timer)
    radioAutoNextTimers.delete(roomId)
  }
}

function bumpRadioAutoNextGeneration(roomId: string): number {
  const next = (radioAutoNextGeneration.get(roomId) ?? 0) + 1
  radioAutoNextGeneration.set(roomId, next)
  return next
}

function cancelRadioAutoNext(roomId: string): void {
  clearRadioAutoNextTimer(roomId)
  bumpRadioAutoNextGeneration(roomId)
}

function scheduleRadioAutoNext(io: TypedServer, roomId: string): void {
  clearRadioAutoNextTimer(roomId)
  const generation = bumpRadioAutoNextGeneration(roomId)

  const room = roomRepo.get(roomId)
  if (!room || room.roomMode !== 'radio' || !room.currentTrack || !room.playState.isPlaying) return

  const duration = room.currentTrack.duration
  if (!duration || duration <= 0) return

  const currentTime = estimateCurrentTime(roomId)
  const remainingMs = Math.max(0, (duration - currentTime) * 1000)
  const trackId = room.currentTrack.id

  const timer = setTimeout(() => {
    // A newer schedule/cancel has superseded this timer.
    if (radioAutoNextGeneration.get(roomId) !== generation) return

    radioAutoNextTimers.delete(roomId)

    const latestRoom = roomRepo.get(roomId)
    if (!latestRoom) return
    if (latestRoom.roomMode !== 'radio' || !latestRoom.currentTrack || !latestRoom.playState.isPlaying) return

    // Ignore stale timers created for an old track timeline.
    if (latestRoom.currentTrack.id !== trackId) {
      return
    }

    logger.info(`Radio auto-next triggered in room ${roomId}`, { roomId })

    playNextTrackInRoom(io, roomId, latestRoom.playMode, { skipDebounce: true }).catch((err) => {
      logger.error('Radio auto-next failed', err, { roomId })
    })
  }, Math.max(100, Math.ceil(remainingMs)))

  radioAutoNextTimers.set(roomId, timer)
}

// ---------------------------------------------------------------------------
// Scheduled execution helpers
// ---------------------------------------------------------------------------

/**
 * Compute the future server-time at which all clients should execute an
 * action, based on the P90 RTT in the room.
 */
function getScheduleTime(roomId: string): number {
  const maxRTT = roomRepo.getP90RTT(roomId)
  const delay = Math.min(Math.max(maxRTT * 1.5 + 100, NTP.MIN_SCHEDULE_DELAY_MS), NTP.MAX_SCHEDULE_DELAY_MS)
  return Date.now() + delay
}

/** Build a ScheduledPlayState from a plain PlayState.
 *  Accepts an optional pre-computed scheduleTime to keep room state and
 *  broadcast payload consistent (same timestamp for both). */
function scheduled(ps: PlayState, roomId: string, scheduleTime?: number): ScheduledPlayState {
  return { ...ps, serverTimeToExecute: scheduleTime ?? getScheduleTime(roomId) }
}

// ---------------------------------------------------------------------------
// Audio quality fallback
// ---------------------------------------------------------------------------

/** Ordered fallback bitrates for each quality tier */
const BITRATE_FALLBACKS: Record<AudioQuality, AudioQuality[]> = {
  999: [320, 192, 128],
  320: [192, 128],
  192: [128],
  128: [],
}

/**
 * Try to get a stream URL at the requested bitrate. If it fails, try each
 * lower tier in order until one succeeds or all options are exhausted.
 */
async function resolveStreamUrl(
  source: MusicSource,
  urlId: string,
  bitrate: AudioQuality,
  cookie?: string,
  options?: { forceRefresh?: boolean },
): Promise<string | null> {
  const url = await musicProvider.getStreamUrl(source, urlId, bitrate, cookie, options)
  if (url) return url

  // Fallback to lower bitrates
  for (const fallback of BITRATE_FALLBACKS[bitrate]) {
    const fallbackUrl = await musicProvider.getStreamUrl(source, urlId, fallback, cookie, options)
    if (fallbackUrl) {
      logger.info(`Bitrate fallback: ${bitrate} -> ${fallback} for ${source}/${urlId}`)
      return fallbackUrl
    }
  }

  return null
}

/**
 * Resolve stream URL / cover, set current track, and broadcast PLAYER_PLAY.
 * Returns true on success, false on failure.
 * Serialized per room via mutex to prevent concurrent state corruption.
 */
export function playTrackInRoom(io: TypedServer, roomId: string, track: Track): Promise<boolean> {
  return withPlayMutex(roomId, () => _playTrackInRoom(io, roomId, track))
}

/**
 * Auto-play when the queue was empty. Re-checks `room.currentTrack` inside
 * the mutex so that concurrent QUEUE_ADD handlers don't both trigger playback
 * (the second caller sees the track set by the first and bails out).
 */
export function autoPlayIfEmpty(io: TypedServer, roomId: string, track: Track): Promise<boolean> {
  return withPlayMutex(roomId, async () => {
    const room = roomRepo.get(roomId)
    if (!room || room.currentTrack) return false
    return _playTrackInRoom(io, roomId, track)
  })
}

async function _playTrackInRoom(io: TypedServer, roomId: string, track: Track): Promise<boolean> {
  const room = roomRepo.get(roomId)
  if (!room) return false

  const resolved = { ...track }

  // Fetch stream URL if missing
  if (!resolved.streamUrl) {
    try {
      // Get cookie from the room's pool for this platform (enables VIP access)
      const cookie = authService.getAnyCookie(resolved.source, roomId)
      const url = await resolveStreamUrl(resolved.source, resolved.urlId, room.audioQuality, cookie ?? undefined)

      if (!url) {
        const isVip = resolved.vip
        const hint = isVip && !cookie ? '（VIP 歌曲，需要有用户登录 VIP 账号）' : ''
        logger.warn(`Cannot get stream URL for "${resolved.title}"${hint}, removing from queue`, { roomId })
        // Auto-remove the invalid track from the queue
        queueService.removeTrack(roomId, resolved.id)
        const room2 = roomRepo.get(roomId)
        if (room2) io.to(roomId).emit(EVENTS.QUEUE_UPDATED, { queue: room2.queue })
        io.to(roomId).emit(EVENTS.ROOM_ERROR, {
          code: ERROR_CODE.STREAM_FAILED,
          message: `无法获取「${resolved.title}」的播放链接${hint}，已从列表移除`,
        })
        return false
      }
      resolved.streamUrl = url
    } catch (err) {
      logger.error(`getStreamUrl failed for ${resolved.urlId}`, err, { roomId })
      // Auto-remove on unexpected failure too
      queueService.removeTrack(roomId, resolved.id)
      const room2 = roomRepo.get(roomId)
      if (room2) io.to(roomId).emit(EVENTS.QUEUE_UPDATED, { queue: room2.queue })
      return false
    }
  }

  // Fetch cover if missing
  if (!resolved.cover && resolved.picId) {
    try {
      const cover = await musicProvider.getCover(resolved.source, resolved.picId)
      if (cover) resolved.cover = cover
    } catch {
      // Non-critical, leave cover empty
    }
  }

  // Update room state — align serverTimestamp with the scheduled execution time
  // so that estimateCurrentTime() is accurate before the first conductor report.
  room.currentTrack = resolved
  const scheduleTime = getScheduleTime(roomId)
  room.playState = {
    isPlaying: true,
    currentTime: 0,
    serverTimestamp: scheduleTime,
  }

  io.to(roomId).emit(EVENTS.PLAYER_PLAY, {
    track: resolved,
    playState: scheduled(room.playState, roomId, scheduleTime),
  })

  scheduleRadioAutoNext(io, roomId)

  // 通知大厅用户当前播放曲目变化
  broadcastRoomList(io)

  logger.info(`Playing: ${resolved.title} in room ${roomId}`, { roomId })
  return true
}

export function resumeTrack(io: TypedServer, roomId: string, _initiatorSocket?: TypedSocket): void {
  const room = roomRepo.get(roomId)
  if (!room || !room.currentTrack) return

  const scheduleTime = getScheduleTime(roomId)
  room.playState = { ...room.playState, isPlaying: true, serverTimestamp: scheduleTime }
  // All clients (including initiator) must execute at the same scheduled moment
  io.to(roomId).emit(EVENTS.PLAYER_RESUME, { playState: scheduled(room.playState, roomId, scheduleTime) })
  scheduleRadioAutoNext(io, roomId)
}

export function pauseTrack(io: TypedServer, roomId: string, _initiatorSocket?: TypedSocket): void {
  const room = roomRepo.get(roomId)
  if (!room) return

  // Snapshot estimated position before pausing so resume starts from the correct point
  const snapshotTime = estimateCurrentTime(roomId)
  room.playState = { isPlaying: false, currentTime: snapshotTime, serverTimestamp: Date.now() }
  cancelRadioAutoNext(roomId)
  // All clients must pause at the same scheduled moment
  io.to(roomId).emit(EVENTS.PLAYER_PAUSE, { playState: scheduled(room.playState, roomId) })
}

export function seekTrack(io: TypedServer, roomId: string, currentTime: number, _initiatorSocket?: TypedSocket): void {
  const room = roomRepo.get(roomId)
  if (!room) return

  const scheduleTime = getScheduleTime(roomId)
  // When playing, align serverTimestamp with scheduled time so estimateCurrentTime() is accurate
  room.playState = {
    ...room.playState,
    currentTime,
    serverTimestamp: room.playState.isPlaying ? scheduleTime : Date.now(),
  }
  // All clients must seek at the same scheduled moment
  io.to(roomId).emit(EVENTS.PLAYER_SEEK, { playState: scheduled(room.playState, roomId, scheduleTime) })

  if (room.playState.isPlaying) {
    scheduleRadioAutoNext(io, roomId)
  } else {
    cancelRadioAutoNext(roomId)
  }
}

export function updatePlayState(roomId: string, update: Partial<PlayState>): void {
  const room = roomRepo.get(roomId)
  if (room) {
    room.playState = { ...room.playState, ...update, serverTimestamp: Date.now() }
  }
}

export function setCurrentTrack(roomId: string, track: Track | null): void {
  const room = roomRepo.get(roomId)
  if (room) {
    if (track === null) {
      cancelRadioAutoNext(roomId)
    }
    room.currentTrack = track
    room.playState = {
      isPlaying: track !== null,
      currentTime: 0,
      serverTimestamp: Date.now(),
    }
  }
}

/**
 * Stop playback: clear current track, emit PLAYER_PAUSE with a stopped state,
 * broadcast full ROOM_STATE so clients clear stale track, and notify lobby.
 * Used when no next track is available (queue empty, track removed, queue cleared).
 */
export function stopPlayback(io: TypedServer, roomId: string): void {
  cancelRadioAutoNext(roomId)
  setCurrentTrack(roomId, null)
  io.to(roomId).emit(EVENTS.PLAYER_PAUSE, {
    playState: { isPlaying: false, currentTime: 0, serverTimestamp: Date.now(), serverTimeToExecute: Date.now() },
  })
  const room = roomRepo.get(roomId)
  if (room) {
    io.to(roomId).emit(EVENTS.ROOM_STATE, toPublicRoomState(room))
  }
  broadcastRoomList(io)
}

/**
 * Mutex-protected variant of `stopPlayback`. Use when the caller is NOT
 * already inside the per-room mutex (e.g. QUEUE_CLEAR) to prevent races
 * with concurrent `autoPlayIfEmpty` / `_playTrackInRoom` operations.
 */
export function stopPlaybackSafe(io: TypedServer, roomId: string): Promise<void> {
  return withPlayMutex(roomId, async () => {
    stopPlayback(io, roomId)
  })
}

// ---------------------------------------------------------------------------
// Next / Previous track (debounce + queue navigation inside mutex)
// ---------------------------------------------------------------------------

/**
 * Advance to the next track in the queue. Debounce check and queue navigation
 * run inside the per-room mutex so two rapid NEXT events can never both pass
 * the debounce in the same event loop tick.
 */
export function playNextTrackInRoom(
  io: TypedServer,
  roomId: string,
  playMode: PlayMode,
  options?: { skipDebounce?: boolean },
): Promise<void> {
  return withPlayMutex(roomId, async () => {
    if (options?.skipDebounce) {
      // Still update the timestamp so a normal NEXT right after is debounced
      lastNextTimestamp.set(roomId, Date.now())
    } else if (_isNextDebounced(roomId)) {
      return
    }

    const nextTrack = queueService.getNextTrack(roomId, playMode)
    if (!nextTrack) {
      stopPlayback(io, roomId)
      return
    }

    const success = await _playTrackInRoom(io, roomId, nextTrack)
    if (!success) {
      const skipTrack = queueService.getNextTrack(roomId, playMode)
      if (skipTrack) await _playTrackInRoom(io, roomId, skipTrack)
    }

    // Refresh debounce timestamp after async work completes.
    // Without this, a second PLAYER_NEXT waiting on the mutex could pass
    // the debounce check if _playTrackInRoom took longer than 500ms (e.g.
    // stream URL resolution), causing a double-skip.
    lastNextTimestamp.set(roomId, Date.now())
  })
}

/**
 * Go to the previous track in the queue. Same mutex serialization as next.
 */
export function playPrevTrackInRoom(
  io: TypedServer,
  roomId: string,
  options?: { skipDebounce?: boolean },
): Promise<void> {
  return withPlayMutex(roomId, async () => {
    if (options?.skipDebounce) {
      lastNextTimestamp.set(roomId, Date.now())
    } else if (_isNextDebounced(roomId)) {
      return
    }

    const prevTrack = queueService.getPreviousTrack(roomId)
    if (!prevTrack) return

    const success = await _playTrackInRoom(io, roomId, prevTrack)
    if (!success) {
      const skipTrack = queueService.getPreviousTrack(roomId)
      if (skipTrack) await _playTrackInRoom(io, roomId, skipTrack)
    }

    // Refresh debounce timestamp after async work (same rationale as playNextTrackInRoom)
    lastNextTimestamp.set(roomId, Date.now())
  })
}

// ---------------------------------------------------------------------------
// Playback sync for newly-joined clients
// ---------------------------------------------------------------------------

/**
 * Send current playback state to a socket that just joined a room.
 * Handles auto-resume when alone, and auto-play from queue.
 */
export async function syncPlaybackToSocket(
  io: TypedServer,
  socket: TypedSocket,
  roomId: string,
  room: RoomData,
): Promise<void> {
  const isAloneInRoom = room.users.length === 1

  if (room.currentTrack?.streamUrl) {
    // Normal mode keeps the old behavior (alone rejoin auto-resume).
    // Radio mode must strictly follow server play/pause state.
    const shouldAutoPlay = room.roomMode === 'radio' ? room.playState.isPlaying : isAloneInRoom || room.playState.isPlaying
    if (room.roomMode !== 'radio' && isAloneInRoom && !room.playState.isPlaying) {
      room.playState = { ...room.playState, isPlaying: true, serverTimestamp: Date.now() }
    }
    socket.emit(EVENTS.PLAYER_PLAY, {
      track: room.currentTrack,
      playState: {
        isPlaying: shouldAutoPlay,
        currentTime: estimateCurrentTime(roomId),
        serverTimestamp: Date.now(),
        serverTimeToExecute: Date.now(),
      },
    })
  } else if (isAloneInRoom && room.queue.length > 0) {
    // No current track but queue has items → start playing from queue
    const firstTrack = room.queue[0]
    await playTrackInRoom(io, roomId, firstTrack)
  }
}

interface RefreshCurrentTrackOptions {
  currentTime?: number
  reason?: 'audio-error' | 'manual'
}

/**
 * Refresh the current track stream URL for one socket only.
 * Used by client-side silent recovery when media loading fails (e.g. 403).
 */
export async function refreshCurrentTrackStreamUrlForSocket(
  socket: TypedSocket,
  roomId: string,
  options?: RefreshCurrentTrackOptions,
): Promise<boolean> {
  return withPlayMutex(roomId, async () => {
    const room = roomRepo.get(roomId)
    if (!room?.currentTrack) return false

    const track = room.currentTrack
    const cookie = authService.getAnyCookie(track.source, roomId)

    let refreshedUrl: string | null = null
    try {
      // Force refresh bypasses non-cookie cache to avoid reusing expired signed URLs.
      refreshedUrl = await resolveStreamUrl(track.source, track.urlId, room.audioQuality, cookie ?? undefined, {
        forceRefresh: true,
      })
    } catch (err) {
      logger.error(`refreshCurrentTrackStreamUrlForSocket failed for ${track.urlId}`, err, { roomId })
      return false
    }

    if (!refreshedUrl) {
      logger.warn(`Cannot refresh stream URL for "${track.title}"`, {
        roomId,
        reason: options?.reason ?? 'manual',
      })
      return false
    }

    const refreshedTrack: Track = { ...track, streamUrl: refreshedUrl }
    room.currentTrack = refreshedTrack

    const requestedCurrentTime = options?.currentTime
    const fallbackCurrentTime = room.playState.isPlaying ? estimateCurrentTime(roomId) : room.playState.currentTime
    const safeCurrentTime =
      typeof requestedCurrentTime === 'number' && Number.isFinite(requestedCurrentTime)
        ? Math.max(0, requestedCurrentTime)
        : Math.max(0, fallbackCurrentTime)

    const now = Date.now()
    socket.emit(EVENTS.PLAYER_PLAY, {
      track: refreshedTrack,
      playState: {
        isPlaying: room.playState.isPlaying,
        currentTime: safeCurrentTime,
        serverTimestamp: now,
        serverTimeToExecute: now,
      },
    })

    logger.info(`Refreshed stream URL for "${track.title}"`, {
      roomId,
      reason: options?.reason ?? 'manual',
    })
    return true
  })
}

// ---------------------------------------------------------------------------
// Room cleanup, debounce & conductor report validation
// ---------------------------------------------------------------------------

/** Debounce tracking for PLAYER_NEXT per room */
const lastNextTimestamp = new Map<string, number>()

/** Track consecutive rejected conductor reports per room to break deadlocks */
const conductorRejectCount = new Map<string, number>()

/** Force-accept a conductor report after this many consecutive rejections */
const CONDUCTOR_REJECT_FORCE_ACCEPT_COUNT = 2

/** Max allowed drift (seconds) between conductor-reported time and server estimate */
const CONDUCTOR_REJECT_DRIFT_THRESHOLD_S = 3

/** Remove per-room entries for a deleted room */
export function cleanupRoom(roomId: string): void {
  cancelRadioAutoNext(roomId)
  lastNextTimestamp.delete(roomId)
  conductorRejectCount.delete(roomId)
  playMutexes.delete(roomId)
  radioAutoNextGeneration.delete(roomId)
}

export function handleRoomModeChanged(io: TypedServer, roomId: string): void {
  const room = roomRepo.get(roomId)
  if (!room || room.roomMode !== 'radio') {
    cancelRadioAutoNext(roomId)
    return
  }

  scheduleRadioAutoNext(io, roomId)
}

/**
 * Validate a conductor sync report against the server estimate.
 * Returns true if the report should be ACCEPTED, false if rejected (stale).
 * Automatically force-accepts after CONDUCTOR_REJECT_FORCE_ACCEPT consecutive
 * rejections to break deadlocks when the server estimate has diverged.
 */
export function validateConductorReport(roomId: string, reportedTime: number, estimatedTime: number): boolean {
  if (estimatedTime - reportedTime > CONDUCTOR_REJECT_DRIFT_THRESHOLD_S) {
    const count = (conductorRejectCount.get(roomId) ?? 0) + 1
    conductorRejectCount.set(roomId, count)
    if (count < CONDUCTOR_REJECT_FORCE_ACCEPT_COUNT) {
      return false // reject
    }
    // Too many consecutive rejections — force accept to break deadlock
    logger.warn(`Force-accepting conductor report after ${count} consecutive rejections`, { roomId })
  }
  // Accepted — reset counter
  conductorRejectCount.delete(roomId)
  return true
}

/**
 * Check and update the next-track debounce for a room.
 * Returns true if the action should be SKIPPED (too soon), false if allowed.
 * Internal: called inside mutex to prevent same-tick race conditions.
 */
function _isNextDebounced(roomId: string): boolean {
  const now = Date.now()
  const lastNext = lastNextTimestamp.get(roomId) ?? 0
  if (now - lastNext < config.player.nextDebounceMs) return true
  lastNextTimestamp.set(roomId, now)
  return false
}
