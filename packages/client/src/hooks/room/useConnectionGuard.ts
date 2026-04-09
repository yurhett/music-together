import { useSocketContext } from '@/providers/SocketProvider'
import { useRoomStore } from '@/stores/roomStore'
import { useEffect } from 'react'

/**
 * Marks room session as reconnecting on socket disconnect.
 * We intentionally keep room/player/chat state so the UI does not flash empty
 * while audio can continue locally until resync completes.
 */
export function useConnectionGuard() {
  const { socket } = useSocketContext()

  useEffect(() => {
    const markReconnecting = (code: string, message: string) => {
      const { room, setReconnecting, markJoinError } = useRoomStore.getState()
      if (!room) return
      setReconnecting(true)
      markJoinError(code, message)
    }

    const onDisconnect = (reason: string) => {
      markReconnecting('SOCKET_DISCONNECTED', reason)
    }

    const onOffline = () => {
      markReconnecting('NETWORK_OFFLINE', 'browser-offline')
    }

    const onOnline = () => {
      const { room, clearReconnectMeta } = useRoomStore.getState()
      if (!room) return
      if (!socket.connected) return
      clearReconnectMeta()
    }

    socket.on('disconnect', onDisconnect)
    window.addEventListener('offline', onOffline)
    window.addEventListener('online', onOnline)

    return () => {
      socket.off('disconnect', onDisconnect)
      window.removeEventListener('offline', onOffline)
      window.removeEventListener('online', onOnline)
    }
  }, [socket])
}
