import { connectSocket, type TypedSocket } from '@/lib/socket'
import { installSocketDebugHelpers, recordSocketDebug } from '@/lib/socketLifecycleDebug'
import { SERVER_URL } from '@/lib/config'
import { storage } from '@/lib/storage'
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'

interface SocketContextValue {
  socket: TypedSocket
  isConnected: boolean
}

const SocketContext = createContext<SocketContextValue | null>(null)

/** Persistent toast id so we can dismiss it on reconnect */
const DISCONNECT_TOAST_ID = 'socket-disconnect'

export function SocketProvider({ children }: { children: ReactNode }) {
  const socketRef = useRef<TypedSocket>(connectSocket())
  const hasDisconnectedRef = useRef(false)
  const [isConnected, setIsConnected] = useState(socketRef.current.connected)

  useEffect(() => {
    const socket = socketRef.current
    let cancelled = false
    let reauthenticating = false
    let reconnectPending = false

    installSocketDebugHelpers()

    const logSocket = (event: string, detail?: Record<string, unknown>) => {
      recordSocketDebug(event, socket, detail)
    }

    const isStandaloneMode = (): boolean => {
      const nav = navigator as Navigator & { standalone?: boolean }
      return Boolean(nav.standalone) || Boolean(window.matchMedia?.('(display-mode: standalone)').matches)
    }

    logSocket('provider:mount')

    const showDisconnectToast = (message: string) => {
      toast.warning(message, {
        id: DISCONNECT_TOAST_ID,
        duration: Infinity,
      })
    }

    const onConnect = () => {
      logSocket('socket:connect')
      reconnectPending = false
      setIsConnected(true)
      toast.dismiss(DISCONNECT_TOAST_ID)
      if (hasDisconnectedRef.current) {
        toast.success('已重新连接', { id: 'socket-reconnect' })
      }
    }

    const onDisconnect = (reason: string) => {
      logSocket('socket:disconnect', { reason })
      reconnectPending = true
      setIsConnected(false)
      hasDisconnectedRef.current = true
      showDisconnectToast('连接已断开，正在重连…')
    }

    const onOffline = () => {
      logSocket('network:offline')
      reconnectPending = true
      setIsConnected(false)
      hasDisconnectedRef.current = true
      showDisconnectToast('网络已离线，正在等待恢复…')
    }

    const onOnline = () => {
      if (cancelled) return
      logSocket('network:online')
      reconnectPending = true
      setIsConnected(false)
      hasDisconnectedRef.current = true
      const hiddenStandalone = document.hidden && isStandaloneMode()
      if (hiddenStandalone) {
        logSocket('network:online-hidden-standalone')
        showDisconnectToast('网络已恢复，后台等待重连…')
        // Hidden standalone mode is frequently throttled/suspended by iOS.
        // Avoid hard reconnect churn; let visible transition trigger strong recovery.
        if (!socket.connected) {
          logSocket('socket:soft-connect-call-from-online-hidden')
          socket.connect()
        }
        return
      }

      showDisconnectToast('网络已恢复，正在重连…')
      // Force a fresh handshake to avoid stale "connected" state after background/offline periods.
      if (socket.connected) {
        logSocket('socket:force-disconnect-before-reconnect')
        socket.disconnect()
      }
      logSocket('socket:connect-call-from-online')
      socket.connect()
    }

    const onVisibilityChange = () => {
      logSocket('page:visibilitychange', { state: document.visibilityState })
      if (document.visibilityState !== 'visible') return
      if (cancelled) return

      const shouldRecover = reconnectPending || !socket.connected
      if (!shouldRecover) return

      logSocket('socket:visible-recovery-start', {
        reconnectPending,
        connected: socket.connected,
      })
      setIsConnected(false)
      hasDisconnectedRef.current = true
      showDisconnectToast('正在恢复连接…')

      if (socket.connected) {
        logSocket('socket:visible-force-disconnect-before-reconnect')
        socket.disconnect()
      }
      logSocket('socket:connect-call-from-visible')
      socket.connect()
    }

    const bootstrapIdentity = async (showError = true): Promise<boolean> => {
      try {
        const res = await fetch(`${SERVER_URL}/api/auth/identity/bootstrap`, {
          method: 'POST',
          credentials: 'include',
        })
        if (!res.ok) {
          logSocket('identity:bootstrap-failed', { status: res.status })
          storage.clearUserId()
          if (showError) toast.error('身份初始化失败，请刷新重试')
          return false
        }

        const userId = res.headers.get('X-Identity-UserId') ?? res.headers.get('x-identity-userid')
        if (userId && userId.trim().length > 0) {
          storage.setUserId(userId.trim())
        } else {
          storage.clearUserId()
        }
        logSocket('identity:bootstrap-ok')
        return true
      } catch {
        logSocket('identity:bootstrap-network-error')
        storage.clearUserId()
        if (showError) toast.error('连接服务器失败，请稍后重试')
        return false
      }
    }

    const ensureIdentityAndConnect = async (showError = true): Promise<void> => {
      await bootstrapIdentity(showError)
      if (!cancelled && !socket.connected) {
        logSocket('socket:connect-call-from-ensure-identity')
        socket.connect()
      }
    }

    const onConnectError = async (err: Error) => {
      logSocket('socket:connect_error', { message: err.message })
      if (err.message !== 'UNAUTHENTICATED') return
      if (cancelled || reauthenticating) return

      reauthenticating = true
      try {
        const ok = await bootstrapIdentity(false)
        if (ok && !cancelled && !socket.connected) {
          logSocket('socket:connect-call-after-reauth')
          socket.connect()
        }
      } finally {
        reauthenticating = false
      }
    }

    const manager = socket.io
    const onReconnectAttempt = (attempt: number) => logSocket('manager:reconnect_attempt', { attempt })
    const onReconnect = (attempt: number) => logSocket('manager:reconnect', { attempt })
    const onReconnectError = (err: Error) => logSocket('manager:reconnect_error', { message: err.message })
    const onReconnectFailed = () => logSocket('manager:reconnect_failed')
    const onManagerOpen = () => logSocket('manager:open')
    const onManagerClose = (reason: string) => logSocket('manager:close', { reason })

    manager.on('reconnect_attempt', onReconnectAttempt)
    manager.on('reconnect', onReconnect)
    manager.on('reconnect_error', onReconnectError)
    manager.on('reconnect_failed', onReconnectFailed)
    manager.on('open', onManagerOpen)
    manager.on('close', onManagerClose)

    socket.on('connect', onConnect)
    socket.on('disconnect', onDisconnect)
    socket.on('connect_error', onConnectError)
    window.addEventListener('offline', onOffline)
    window.addEventListener('online', onOnline)
    document.addEventListener('visibilitychange', onVisibilityChange)
    ensureIdentityAndConnect()

    return () => {
      cancelled = true
      logSocket('provider:unmount')
      socket.off('connect', onConnect)
      socket.off('disconnect', onDisconnect)
      socket.off('connect_error', onConnectError)
      manager.off('reconnect_attempt', onReconnectAttempt)
      manager.off('reconnect', onReconnect)
      manager.off('reconnect_error', onReconnectError)
      manager.off('reconnect_failed', onReconnectFailed)
      manager.off('open', onManagerOpen)
      manager.off('close', onManagerClose)
      window.removeEventListener('offline', onOffline)
      window.removeEventListener('online', onOnline)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  const value = useMemo<SocketContextValue>(() => ({ socket: socketRef.current, isConnected }), [isConnected])

  return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>
}

export function useSocketContext(): SocketContextValue {
  const ctx = useContext(SocketContext)
  if (!ctx) throw new Error('useSocketContext must be used within SocketProvider')
  return ctx
}
