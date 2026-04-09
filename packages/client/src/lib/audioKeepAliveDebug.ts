const KEEPALIVE_DEBUG_KEY = 'mt-audio-keepalive-debug'
const KEEPALIVE_DEBUG_MAX = 300

type DebugDetails = Record<string, unknown>

export interface KeepAliveDebugEntry {
  at: number
  event: string
  hidden: boolean
  online: boolean
  standalone: boolean
  srcKind: 'none' | 'silent-wav' | 'stream'
  paused: boolean
  ended: boolean
  readyState: number
  networkState: number
  currentTime: number
  duration: number
  loop: boolean
  volume: number
  playbackRate: number
  errorCode: number | null
  detail?: DebugDetails
}

declare global {
  interface Window {
    __MT_GET_KEEPALIVE_DEBUG__?: () => KeepAliveDebugEntry[]
    __MT_CLEAR_KEEPALIVE_DEBUG__?: () => void
  }
}

function safeRead(): KeepAliveDebugEntry[] {
  try {
    const raw = localStorage.getItem(KEEPALIVE_DEBUG_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as KeepAliveDebugEntry[]) : []
  } catch {
    return []
  }
}

function safeWrite(entries: KeepAliveDebugEntry[]): void {
  try {
    localStorage.setItem(KEEPALIVE_DEBUG_KEY, JSON.stringify(entries.slice(-KEEPALIVE_DEBUG_MAX)))
  } catch {
    // Ignore storage failures (quota/private mode)
  }
}

function isStandaloneMode(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean }
  return Boolean(nav.standalone) || Boolean(window.matchMedia?.('(display-mode: standalone)').matches)
}

function getSrcKind(audio: HTMLAudioElement): KeepAliveDebugEntry['srcKind'] {
  if (!audio.src) return 'none'
  if (audio.src.startsWith('data:audio/wav')) return 'silent-wav'
  return 'stream'
}

export function recordKeepAliveDebug(event: string, audio: HTMLAudioElement, detail?: DebugDetails): void {
  const entry: KeepAliveDebugEntry = {
    at: Date.now(),
    event,
    hidden: document.hidden,
    online: navigator.onLine,
    standalone: isStandaloneMode(),
    srcKind: getSrcKind(audio),
    paused: audio.paused,
    ended: audio.ended,
    readyState: audio.readyState,
    networkState: audio.networkState,
    currentTime: Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
    duration: Number.isFinite(audio.duration) ? audio.duration : 0,
    loop: audio.loop,
    volume: audio.volume,
    playbackRate: audio.playbackRate,
    errorCode: audio.error?.code ?? null,
    detail,
  }

  const logs = safeRead()
  logs.push(entry)
  safeWrite(logs)

  if (import.meta.env.DEV) {
    console.debug('[KeepAliveDebug]', entry)
  }
}

export function installKeepAliveDebugHelpers(): void {
  if (typeof window === 'undefined') return
  if (window.__MT_GET_KEEPALIVE_DEBUG__) return

  window.__MT_GET_KEEPALIVE_DEBUG__ = () => safeRead()
  window.__MT_CLEAR_KEEPALIVE_DEBUG__ = () => safeWrite([])
}
