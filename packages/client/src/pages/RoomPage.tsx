import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { EVENTS, ERROR_CODE } from '@music-together/shared'
import { motion } from 'motion/react'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { InteractionGate } from '@/components/InteractionGate'
import { AudioPlayer } from '@/components/Player/AudioPlayer'
import { ChatPanel } from '@/components/Chat/ChatPanel'
import { RoomHeader } from '@/components/Room/RoomHeader'
import { SearchDialog } from '@/components/Overlays/SearchDialog'
import { QueueDrawer } from '@/components/Overlays/QueueDrawer'
import { SettingsDialog, type SettingsTab } from '@/components/Overlays/SettingsDialog'
import { PasswordDialog } from '@/components/Lobby/PasswordDialog'
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from '@/components/ui/drawer'
import { cn } from '@/lib/utils'
import { isAudioUnlocked, unlockAudio } from '@/lib/audioUnlock'
import { SERVER_URL } from '@/lib/config'
import { useRoom } from '@/hooks/useRoom'
import { usePlayer } from '@/hooks/usePlayer'
import { useQueue } from '@/hooks/useQueue'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useRoomStore } from '@/stores/roomStore'
import { useChatStore } from '@/stores/chatStore'
import { useSocketContext } from '@/providers/SocketProvider'
import { AbilityProvider } from '@/providers/AbilityProvider'
import { useClockSync } from '@/hooks/useClockSync'
import { storage } from '@/lib/storage'

/** Invisible component that runs NTP clock-sync only while in a room. */
function ClockSyncRunner() {
  useClockSync()
  return null
}

interface RoomCheckInfo {
  name: string
  hasPassword: boolean
  userCount: number
}

const JOIN_RETRY_INTERVAL_MS = 5000
const JOIN_ATTEMPT_TIMEOUT_MS = 4000

export default function RoomPage() {
  const { roomId } = useParams<{ roomId: string }>()
  const navigate = useNavigate()
  const { socket, isConnected } = useSocketContext()
  const { leaveRoom, updateSettings, setUserRole, setRoomMode, dissolveRoom } = useRoom()
  const { play, pause, seek, next, prev } = usePlayer()
  const { addTrack, removeTrack, reorderTracks, clearQueue } = useQueue()

  const room = useRoomStore((s) => s.room)
  const reconnectMeta = useRoomStore((s) => s.reconnectMeta)
  const chatOpen = useChatStore((s) => s.isChatOpen)
  const setChatOpen = useChatStore((s) => s.setIsChatOpen)
  const chatUnreadCount = useChatStore((s) => s.unreadCount)
  const reconnecting = reconnectMeta.reconnecting
  const reconnectStopped = reconnectMeta.stopped
  const toggleChat = useCallback(() => {
    setChatOpen(!useChatStore.getState().isChatOpen)
  }, [setChatOpen])
  const isMobile = useIsMobile()

  // --- Pre-check state ---
  const [checking, setChecking] = useState(true)
  const [roomInfo, setRoomInfo] = useState<RoomCheckInfo | null>(null)

  // Gate: audio must be unlocked before joining the room.
  // From lobby: isAudioUnlocked() is already true → gate skipped, auto-join runs immediately.
  // Direct URL / page refresh: gate blocks until user clicks "开始收听".
  const [gateOpen, setGateOpen] = useState(() => isAudioUnlocked())
  const [gatePasswordError, setGatePasswordError] = useState<string | null>(null)

  const [searchOpen, setSearchOpen] = useState(false)
  const [queueOpen, setQueueOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab | undefined>(undefined)

  // Fallback password dialog state (edge case: password changed after pre-check)
  const [passwordNeeded, setPasswordNeeded] = useState(false)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [passwordLoading, setPasswordLoading] = useState(false)

  const joiningRef = useRef(false)
  const isLeavingRef = useRef(false)
  const passwordRef = useRef<string | undefined>(undefined)
  const joinAttemptTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearJoinAttemptTimeout = useCallback(() => {
    if (!joinAttemptTimeoutRef.current) return
    clearTimeout(joinAttemptTimeoutRef.current)
    joinAttemptTimeoutRef.current = null
  }, [])

  // --- Pre-check: fetch room existence & password requirement ---
  useEffect(() => {
    if (!roomId) {
      navigate('/', { replace: true })
      return
    }

    // If already in this room (e.g. navigated from lobby), skip pre-check
    if (room && room.id === roomId) {
      setChecking(false)
      return
    }

    let cancelled = false
    const controller = new AbortController()

    async function checkRoom() {
      try {
        const res = await fetch(`${SERVER_URL}/api/rooms/${roomId}/check`, {
          signal: controller.signal,
          credentials: 'include',
        })
        if (cancelled) return

        if (!res.ok) {
          // Room not found
          toast.error('房间不存在')
          navigate('/', { replace: true })
          return
        }

        const data = await res.json()
        setRoomInfo({
          name: data.name,
          hasPassword: data.hasPassword,
          userCount: data.userCount,
        })
      } catch (err) {
        if (cancelled) return
        // Network error — still allow the user to try (gate will show, join may fail)
        console.warn('Room pre-check failed:', err)
        setRoomInfo(null)
      } finally {
        if (!cancelled) setChecking(false)
      }
    }

    checkRoom()
    return () => {
      cancelled = true
      controller.abort()
    }
    // `room` is excluded intentionally — this effect only runs on mount / roomId change.
    // `navigate` is stable (React Router guarantee) and would cause unnecessary re-runs if included.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId])

  // --- Gate start handler (receives password from gate if applicable) ---
  const handleGateStart = useCallback(async (password?: string) => {
    await unlockAudio()
    if (password && roomId) {
      passwordRef.current = password
      storage.setRecentRoomPassword(roomId, password)
    }
    setGatePasswordError(null)
    setGateOpen(true)
  }, [roomId])

  const attemptRoomJoin = useCallback(
    (overridePassword?: string) => {
      if (!roomId) return false
      if (isLeavingRef.current) return false

      const nickname = storage.getNickname()
      if (!nickname) {
        joiningRef.current = false
        useRoomStore.getState().markJoinError('NICKNAME_REQUIRED', '缺少昵称，无法重新加入房间')
        if (!useRoomStore.getState().reconnectMeta.reconnecting) {
          setGateOpen(false)
        }
        return false
      }

      const rejoinToken = storage.getRejoinToken(roomId) ?? undefined
      const fallbackPassword =
        overridePassword ??
        passwordRef.current ??
        storage.getRecentRoomPassword(roomId) ??
        useRoomStore.getState().roomPassword ??
        undefined

      if (fallbackPassword) {
        passwordRef.current = fallbackPassword
        storage.setRecentRoomPassword(roomId, fallbackPassword)
      }

      joiningRef.current = true
      clearJoinAttemptTimeout()
      joinAttemptTimeoutRef.current = setTimeout(() => {
        if (!joiningRef.current) return
        joiningRef.current = false
        const state = useRoomStore.getState()
        if (state.reconnectMeta.stopped) return
        state.markJoinError('JOIN_TIMEOUT', '加入房间超时，正在重试')
      }, JOIN_ATTEMPT_TIMEOUT_MS)

      useRoomStore.getState().markJoinAttempt()
      socket.emit(EVENTS.ROOM_JOIN, {
        roomId,
        nickname,
        password: fallbackPassword,
        rejoinToken,
      })
      return true
    },
    [clearJoinAttemptTimeout, roomId, socket],
  )

  // --- Auto-join / re-join loop ---
  // While connected and room state is missing (or reconnect recovery is active),
  // keep attempting ROOM_JOIN every 5s until ROOM_STATE arrives or we hit a terminal error.
  useEffect(() => {
    if (!gateOpen || !roomId || !isConnected || reconnectStopped) return
    if (isLeavingRef.current) return
    if (passwordNeeded) return

    const shouldJoin = !room || reconnecting
    if (!shouldJoin) {
      joiningRef.current = false
      clearJoinAttemptTimeout()
      return
    }

    if (!joiningRef.current) {
      attemptRoomJoin()
    }

    const timer = setInterval(() => {
      if (joiningRef.current || isLeavingRef.current) return
      const state = useRoomStore.getState()
      const shouldRetry = !state.room || state.reconnectMeta.reconnecting
      if (!shouldRetry || state.reconnectMeta.stopped || !socket.connected) return
      attemptRoomJoin()
    }, JOIN_RETRY_INTERVAL_MS)

    return () => {
      clearInterval(timer)
      clearJoinAttemptTimeout()
    }
  }, [attemptRoomJoin, clearJoinAttemptTimeout, gateOpen, isConnected, passwordNeeded, reconnectStopped, roomId, room, reconnecting, socket])

  // iOS standalone may heavily throttle timers while hidden.
  // Kick an immediate rejoin attempt when returning to foreground.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return
      if (!gateOpen || !roomId || !isConnected || reconnectStopped || passwordNeeded) return
      if (isLeavingRef.current) return

      const state = useRoomStore.getState()
      const shouldRetry = !state.room || state.reconnectMeta.reconnecting
      if (!shouldRetry || state.reconnectMeta.stopped) return

      joiningRef.current = false
      clearJoinAttemptTimeout()
      attemptRoomJoin()
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [attemptRoomJoin, clearJoinAttemptTimeout, gateOpen, isConnected, passwordNeeded, reconnectStopped, roomId])

  // --- Handle ROOM_ERROR — password errors, fallback dialog ---
  useEffect(() => {
    const onRoomError = (error: { code: string; message: string }) => {
      joiningRef.current = false
      clearJoinAttemptTimeout()

      if (error.code === ERROR_CODE.WRONG_PASSWORD) {
        if (passwordNeeded) {
          setPasswordError('密码错误，请重试')
          setPasswordLoading(false)
          return
        }

        // During reconnect retries, keep using the cached password automatically.
        if (reconnecting) {
          const hasCachedPassword = Boolean(
            (roomId && storage.getRecentRoomPassword(roomId)) || passwordRef.current || useRoomStore.getState().roomPassword,
          )
          if (hasCachedPassword) {
            setGatePasswordError('密码验证失败，正在自动重试…')
            setPasswordLoading(false)
            return
          }

          setPasswordNeeded(true)
          setPasswordError('重连需要房间密码，请输入后继续')
          setPasswordLoading(false)
          return
        }

        // If we came through the gate, revert to gate with error
        if (!passwordNeeded && !gateOpen) {
          // Gate was not yet open — shouldn't happen, but handle gracefully
          setPasswordNeeded(true)
          return
        }

        if (gateOpen && !passwordNeeded) {
          // Password was sent from gate but rejected (e.g. race condition / password changed)
          // Reset gate so user can re-enter password
          setGateOpen(false)
          setGatePasswordError('密码错误，请重试')
          passwordRef.current = undefined
          return
        }

        // Fallback password dialog path
        if (passwordNeeded) {
          setPasswordError('密码错误，请重试')
          setPasswordLoading(false)
        } else {
          setPasswordNeeded(true)
          setPasswordLoading(false)
        }
      }
    }

    // On successful join, dismiss any password state
    const onRoomState = () => {
      joiningRef.current = false
      clearJoinAttemptTimeout()
      if (passwordNeeded) {
        setPasswordNeeded(false)
        setPasswordError(null)
        setPasswordLoading(false)
      }
      setGatePasswordError(null)
      if (roomId && passwordRef.current) {
        storage.setRecentRoomPassword(roomId, passwordRef.current)
      }
    }

    socket.on(EVENTS.ROOM_ERROR, onRoomError)
    socket.on(EVENTS.ROOM_STATE, onRoomState)
    return () => {
      socket.off(EVENTS.ROOM_ERROR, onRoomError)
      socket.off(EVENTS.ROOM_STATE, onRoomState)
      clearJoinAttemptTimeout()
    }
  }, [socket, passwordNeeded, gateOpen, reconnecting, roomId, clearJoinAttemptTimeout])

  // No unmount cleanup needed — the server handles room membership:
  // - On disconnect: server's disconnect handler removes user
  // - On join/create another room: server auto-leaves old room
  // - On explicit leave: user clicks the leave button below

  const handlePasswordSubmit = useCallback(
    (password: string) => {
      if (!roomId) return
      passwordRef.current = password
      storage.setRecentRoomPassword(roomId, password)
      setPasswordLoading(true)
      setPasswordError(null)
      attemptRoomJoin(password)
    },
    [attemptRoomJoin, roomId],
  )

  // If password dialog is dismissed without submitting, navigate home
  const handlePasswordOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        setPasswordNeeded(false)
        setPasswordError(null)
        navigate('/', { replace: true })
      }
    },
    [navigate],
  )

  const handleOpenMembers = useCallback(() => {
    setSettingsInitialTab('members')
    setSettingsOpen(true)
  }, [])

  const handleLeaveRoom = useCallback(() => {
    isLeavingRef.current = true
    leaveRoom()
    navigate('/', { replace: true })
  }, [leaveRoom, navigate])

  // --- Loading state during pre-check ---
  if (checking) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center gap-4">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">正在检查房间...</p>
        </motion.div>
      </div>
    )
  }

  // --- Interaction gate (audio unlock + optional password) ---
  if (!gateOpen) {
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
      >
        <InteractionGate
          onStart={handleGateStart}
          roomName={roomInfo?.name}
          hasPassword={roomInfo?.hasPassword || !!gatePasswordError}
          passwordError={gatePasswordError}
        />
      </motion.div>
    )
  }

  return (
    <AbilityProvider>
      <ClockSyncRunner />
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
      >
        <div className="flex h-dvh flex-col bg-background">
          <RoomHeader
            onOpenSearch={() => setSearchOpen(true)}
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenMembers={handleOpenMembers}
            onLeaveRoom={handleLeaveRoom}
          />

          <div className="flex min-h-0 flex-1 overflow-hidden p-2 md:p-3 lg:p-4">
            <div className="min-w-0 flex-1 overflow-hidden rounded-2xl">
              <AudioPlayer
                onPlay={play}
                onPause={pause}
                onSeek={seek}
                onNext={next}
                onPrev={prev}
                onOpenChat={toggleChat}
                onOpenQueue={() => setQueueOpen(true)}
                chatUnreadCount={chatUnreadCount}
              />
            </div>

            {/* Desktop: inline chat panel that squeezes the player */}
            <div
              className={cn(
                'hidden h-full shrink-0 overflow-hidden transition-[width] duration-200 ease-out md:block',
                chatOpen ? 'w-[320px] pl-3' : 'w-0',
              )}
            >
              <div className="flex h-full w-[320px] flex-col">{chatOpen && <ChatPanel />}</div>
            </div>
          </div>

          {/* Mobile: chat drawer from bottom */}
          {isMobile && (
            <Drawer open={chatOpen} onOpenChange={setChatOpen}>
              <DrawerContent className="flex h-[70vh] flex-col p-0">
                <DrawerHeader className="sr-only">
                  <DrawerTitle>聊天</DrawerTitle>
                </DrawerHeader>
                <ChatPanel />
              </DrawerContent>
            </Drawer>
          )}

          <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} onAddToQueue={addTrack} />
          <QueueDrawer
            open={queueOpen}
            onOpenChange={setQueueOpen}
            onRemoveFromQueue={removeTrack}
            onReorderQueue={reorderTracks}
            onClearQueue={clearQueue}
          />
          <SettingsDialog
            open={settingsOpen}
            onOpenChange={(open) => {
              setSettingsOpen(open)
              if (!open) setSettingsInitialTab(undefined)
            }}
            onUpdateSettings={updateSettings}
            onSetUserRole={setUserRole}
            onSetRoomMode={setRoomMode}
            onDissolveRoom={dissolveRoom}
            initialTab={settingsInitialTab}
          />
        </div>

        {/* Fallback password dialog for edge cases (password changed after pre-check) */}
        <PasswordDialog
          open={passwordNeeded}
          onOpenChange={handlePasswordOpenChange}
          roomName={room?.name ?? roomId ?? ''}
          onSubmit={handlePasswordSubmit}
          error={passwordError}
          isLoading={passwordLoading}
        />
      </motion.div>
    </AbilityProvider>
  )
}
