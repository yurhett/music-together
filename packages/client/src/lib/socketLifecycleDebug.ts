import type { Socket } from 'socket.io-client'

const SOCKET_DEBUG_KEY = 'mt-socket-lifecycle-debug'
const SOCKET_DEBUG_MAX = 300

type DebugDetails = Record<string, unknown>

export interface SocketDebugEntry {
  at: number
  event: string
  hidden: boolean
  online: boolean
  standalone: boolean
  connected: boolean
  transport: string | null
  socketId: string | null
  detail?: DebugDetails
}

declare global {
  interface Window {
    __MT_GET_SOCKET_DEBUG__?: () => SocketDebugEntry[]
    __MT_CLEAR_SOCKET_DEBUG__?: () => void
  }
}

function safeRead(): SocketDebugEntry[] {
  try {
    const raw = localStorage.getItem(SOCKET_DEBUG_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as SocketDebugEntry[]) : []
  } catch {
    return []
  }
}

function safeWrite(entries: SocketDebugEntry[]): void {
  try {
    localStorage.setItem(SOCKET_DEBUG_KEY, JSON.stringify(entries.slice(-SOCKET_DEBUG_MAX)))
  } catch {
    // Ignore storage failures.
  }
}

function isStandaloneMode(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean }
  return Boolean(nav.standalone) || Boolean(window.matchMedia?.('(display-mode: standalone)').matches)
}

function getTransportName(socket: Socket): string | null {
  return socket.io.engine?.transport?.name ?? null
}

export function recordSocketDebug(event: string, socket: Socket, detail?: DebugDetails): void {
  const entry: SocketDebugEntry = {
    at: Date.now(),
    event,
    hidden: document.hidden,
    online: navigator.onLine,
    standalone: isStandaloneMode(),
    connected: socket.connected,
    transport: getTransportName(socket),
    socketId: socket.id ?? null,
    detail,
  }

  const logs = safeRead()
  logs.push(entry)
  safeWrite(logs)

  if (import.meta.env.DEV) {
    console.debug('[SocketDebug]', entry)
  }
}

export function installSocketDebugHelpers(): void {
  if (typeof window === 'undefined') return
  if (window.__MT_GET_SOCKET_DEBUG__) return

  window.__MT_GET_SOCKET_DEBUG__ = () => safeRead()
  window.__MT_CLEAR_SOCKET_DEBUG__ = () => safeWrite([])
}
