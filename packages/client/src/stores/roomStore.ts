import { create } from 'zustand'
import { storage } from '@/lib/storage'
import type { RoomState, User } from '@music-together/shared'

/**
 * Derive the current user from the authoritative room.users list.
 * Role is purely permission-based (owner/admin/member) — no client-side override.
 */
function deriveCurrentUser(room: RoomState | null): User | null {
  if (!room) return null
  const myId = storage.getUserId()
  return room.users.find((u) => u.id === myId) ?? null
}

interface ReconnectMeta {
  reconnecting: boolean
  stopped: boolean
  joinRetryCount: number
  lastJoinAttemptAt: number | null
  lastJoinErrorCode: string | null
  lastJoinErrorMessage: string | null
}

function createReconnectMeta(): ReconnectMeta {
  return {
    reconnecting: false,
    stopped: false,
    joinRetryCount: 0,
    lastJoinAttemptAt: null,
    lastJoinErrorCode: null,
    lastJoinErrorMessage: null,
  }
}

interface RoomStore {
  room: RoomState | null
  currentUser: User | null
  /** 房间密码明文（从 ROOM_SETTINGS 事件接收） */
  roomPassword: string | null
  reconnectMeta: ReconnectMeta

  setRoom: (room: RoomState | null) => void
  updateRoom: (partial: Partial<RoomState>) => void
  setRoomPassword: (password: string | null) => void
  addUser: (user: User) => void
  removeUser: (userId: string) => void
  setReconnecting: (reconnecting: boolean) => void
  markJoinAttempt: () => void
  markJoinError: (code: string, message: string) => void
  stopReconnect: (code: string, message: string) => void
  clearReconnectMeta: () => void
  reset: () => void
}

export const useRoomStore = create<RoomStore>((set) => ({
  room: null,
  currentUser: null,
  roomPassword: null,
  reconnectMeta: createReconnectMeta(),

  setRoom: (room) =>
    set({
      room,
      currentUser: deriveCurrentUser(room),
      reconnectMeta: createReconnectMeta(),
    }),

  updateRoom: (partial) =>
    set((state) => {
      if (!state.room) return {}
      const room = { ...state.room, ...partial }
      // Re-derive currentUser when users list changed (role may have been updated by server)
      if ('users' in partial) {
        return { room, currentUser: deriveCurrentUser(room) }
      }
      return { room }
    }),

  setRoomPassword: (password) => set({ roomPassword: password }),

  addUser: (user) =>
    set((state) => {
      if (!state.room) return {}
      const room = { ...state.room, users: [...state.room.users, user] }
      const myId = storage.getUserId()
      if (user.id === myId) {
        // The added user is us — derive our currentUser from the updated room
        return { room, currentUser: deriveCurrentUser(room) }
      }
      return { room }
    }),

  removeUser: (userId) =>
    set((state) => {
      if (!state.room) return {}
      const room = { ...state.room, users: state.room.users.filter((u) => u.id !== userId) }
      const myId = storage.getUserId()
      if (userId === myId) {
        // We were removed — clear currentUser
        return { room, currentUser: null }
      }
      return { room }
    }),

  setReconnecting: (reconnecting) =>
    set((state) => ({
      reconnectMeta: {
        ...state.reconnectMeta,
        reconnecting,
        stopped: reconnecting ? false : state.reconnectMeta.stopped,
        joinRetryCount: reconnecting ? 0 : state.reconnectMeta.joinRetryCount,
        lastJoinAttemptAt: reconnecting ? null : state.reconnectMeta.lastJoinAttemptAt,
        lastJoinErrorCode: reconnecting ? null : state.reconnectMeta.lastJoinErrorCode,
        lastJoinErrorMessage: reconnecting ? null : state.reconnectMeta.lastJoinErrorMessage,
      },
    })),

  markJoinAttempt: () =>
    set((state) => ({
      reconnectMeta: {
        ...state.reconnectMeta,
        joinRetryCount: state.reconnectMeta.joinRetryCount + 1,
        lastJoinAttemptAt: Date.now(),
      },
    })),

  markJoinError: (code, message) =>
    set((state) => ({
      reconnectMeta: {
        ...state.reconnectMeta,
        lastJoinErrorCode: code,
        lastJoinErrorMessage: message,
      },
    })),

  stopReconnect: (code, message) =>
    set((state) => ({
      reconnectMeta: {
        ...state.reconnectMeta,
        reconnecting: false,
        stopped: true,
        lastJoinErrorCode: code,
        lastJoinErrorMessage: message,
      },
    })),

  clearReconnectMeta: () => set({ reconnectMeta: createReconnectMeta() }),

  reset: () =>
    set({
      room: null,
      currentUser: null,
      roomPassword: null,
      reconnectMeta: createReconnectMeta(),
    }),
}))
