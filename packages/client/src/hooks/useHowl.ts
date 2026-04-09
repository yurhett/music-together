import { useCallback, useEffect, useRef } from 'react'
import type { Track } from '@music-together/shared'
import { usePlayerStore } from '@/stores/playerStore'
import { globalAudio, SILENT_WAV_BASE64 } from '@/lib/audioUnlock'
import { installKeepAliveDebugHelpers, recordKeepAliveDebug } from '@/lib/audioKeepAliveDebug'
import {
  CURRENT_TIME_THROTTLE_MS,
  HOWL_UNMUTE_DELAY_SEEK_MS,
  HOWL_UNMUTE_DELAY_DEFAULT_MS,
  LOAD_COMPENSATION_THRESHOLD_S,
  MAX_LOAD_COMPENSATION_S,
} from '@/lib/constants'
import { toast } from 'sonner'

/** Max wait (ms) for audio unlock event before giving up and skipping */
const PLAY_ERROR_TIMEOUT_MS = 3000

/** If playback reports playing() but currentTime doesn't advance for this
 *  many milliseconds, treat it as stalled (network drop mid-stream). */
const STALLED_TIMEOUT_MS = 8000
const GLOBAL_AUDIO_TEARDOWN_DELAY_MS = 1500
const HIDDEN_STREAM_LOAD_WATCHDOG_MS = 4000

let activeHowlHookCount = 0
let globalAudioTeardownTimer: ReturnType<typeof setTimeout> | null = null

function clearGlobalAudioTeardownTimer(reason?: string): void {
  if (!globalAudioTeardownTimer) return
  clearTimeout(globalAudioTeardownTimer)
  globalAudioTeardownTimer = null
  recordKeepAliveDebug('howl:cleanup-timer-cleared', globalAudio, {
    reason: reason ?? 'unknown',
  })
}

function shouldPreserveKeepAliveDuringUnmount(): boolean {
  const isSilentKeepAlive = globalAudio.src.startsWith('data:audio/wav')
  if (!isSilentKeepAlive) return false
  if (!document.hidden) return false

  const { mediaSessionLoading } = usePlayerStore.getState()
  return globalAudio.loop || !globalAudio.paused || mediaSessionLoading
}

function teardownGlobalAudioElement(): void {
  globalAudio.pause()
  globalAudio.removeAttribute('src')
  globalAudio.load()
}

function isStandaloneMode(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean }
  return Boolean(nav.standalone) || Boolean(window.matchMedia?.('(display-mode: standalone)').matches)
}

function isRealStreamUrl(url?: string): boolean {
  if (!url) return false
  return !url.startsWith('data:audio/wav')
}

function shouldDeferTrackLoadToForeground(track: Track, autoPlay: boolean): boolean {
  return autoPlay && document.hidden && isStandaloneMode() && isRealStreamUrl(track.streamUrl)
}

type RecoverPlaybackErrorContext = {
  currentTime: number
  mediaErrorCode: number | null
  mediaErrorMessage?: string
}

type RecoverPlaybackErrorResult = {
  recovered: boolean
  failureNotified?: boolean
}

type RecoverPlaybackErrorFn = (ctx: RecoverPlaybackErrorContext) => Promise<RecoverPlaybackErrorResult>

type PendingForegroundLoad = {
  track: Track
  seekTo?: number
  autoPlay: boolean
  queuedAt: number
}

type LoadTrackFn = (track: Track, seekTo?: number, autoPlay?: boolean) => void

// Adapter interface so consumers (like usePlayerSync) get what they expect.
export class NativeAudioAdapter {
  playing() {
    return !globalAudio.paused && !globalAudio.ended && globalAudio.readyState > 2
  }
  seek(val?: number) {
    if (val !== undefined) {
      if (Number.isFinite(val)) globalAudio.currentTime = val
      return this
    }
    return globalAudio.currentTime
  }
  duration() {
    return Number.isFinite(globalAudio.duration) ? globalAudio.duration : 0
  }
  pause() {
    globalAudio.pause()
    return this
  }
  play() {
    globalAudio.play().catch(() => {})
    return 1
  }
  rate(val?: number) {
    if (val !== undefined) {
      globalAudio.playbackRate = val
      return this
    }
    return globalAudio.playbackRate
  }
  volume(val?: number) {
    if (val !== undefined) {
      globalAudio.volume = val
      return this
    }
    return globalAudio.volume
  }
  unload() {
    globalAudio.pause()
    globalAudio.removeAttribute('src')
    globalAudio.load()
    return this
  }
}

export function useHowl(onTrackEnd: () => void, onRecoverPlaybackError?: RecoverPlaybackErrorFn) {
  const howlRef = useRef<NativeAudioAdapter | null>(null)
  const soundIdRef = useRef<number | undefined>(undefined)
  const animFrameRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const syncReadyRef = useRef(false)
  const unmuteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const playErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastTimeUpdateRef = useRef(0)
  const stalledRef = useRef<{ lastSeek: number; since: number }>({ lastSeek: -1, since: 0 })
  const trackTitleRef = useRef<string>('')
  const retryRef = useRef(false)
  const recoveringRef = useRef(false)
  const visibilityCleanupRef = useRef<(() => void) | null>(null)
  const hiddenLoadWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingForegroundLoadRef = useRef<PendingForegroundLoad | null>(null)
  const loadTrackRef = useRef<LoadTrackFn | null>(null)

  const volume = usePlayerStore((s) => s.volume)

  if (!howlRef.current) {
    howlRef.current = new NativeAudioAdapter()
  }

  const clearHiddenLoadWatchdog = useCallback((reason: string) => {
    if (!hiddenLoadWatchdogRef.current) return
    clearTimeout(hiddenLoadWatchdogRef.current)
    hiddenLoadWatchdogRef.current = null
    recordKeepAliveDebug('track:hidden-load-watchdog-cleared', globalAudio, { reason })
  }, [])

  const startSilentKeepAlive = useCallback((reason: string) => {
    usePlayerStore.getState().setMediaSessionLoading(true)

    const title = trackTitleRef.current
    recordKeepAliveDebug('keepalive:start', globalAudio, {
      title,
      reason,
    })

    if (!globalAudio.src.startsWith('data:audio/wav')) {
      globalAudio.src = SILENT_WAV_BASE64
    }
    globalAudio.loop = true
    // Keep tiny non-zero volume to avoid aggressive background suspension.
    globalAudio.volume = Math.max(0.01, usePlayerStore.getState().volume)

    globalAudio.play().then(() => {
      recordKeepAliveDebug('keepalive:play-ok', globalAudio, {
        title,
        reason,
      })
    }).catch((e) => {
      recordKeepAliveDebug('keepalive:play-failed', globalAudio, {
        title,
        reason,
        error: String(e),
      })
    })
  }, [])

  useEffect(() => {
    const flushDeferredLoadIfNeeded = (trigger: string) => {
      if (document.visibilityState !== 'visible') return
      const pending = pendingForegroundLoadRef.current
      if (!pending) return

      pendingForegroundLoadRef.current = null
      recordKeepAliveDebug('track:flush-deferred-on-visible', globalAudio, {
        trigger,
        title: pending.track.title,
        queuedForMs: Date.now() - pending.queuedAt,
      })
      clearHiddenLoadWatchdog('flush-deferred')
      loadTrackRef.current?.(pending.track, pending.seekTo, pending.autoPlay)
    }

    const onVisibilityChange = () => {
      flushDeferredLoadIfNeeded('visibilitychange')
    }
    const onPageShow = () => {
      flushDeferredLoadIfNeeded('pageshow')
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('pageshow', onPageShow)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pageshow', onPageShow)
    }
  }, [clearHiddenLoadWatchdog])

  useEffect(() => {
    activeHowlHookCount += 1
    clearGlobalAudioTeardownTimer('remount')

    return () => {
      activeHowlHookCount = Math.max(0, activeHowlHookCount - 1)
    }
  }, [])

  useEffect(() => {
    installKeepAliveDebugHelpers()
    recordKeepAliveDebug('howl:mount', globalAudio)

    const onVisibilityChange = () => {
      recordKeepAliveDebug('page:visibilitychange', globalAudio, {
        visibilityState: document.visibilityState,
      })
    }
    const onOnline = () => recordKeepAliveDebug('network:online', globalAudio)
    const onOffline = () => recordKeepAliveDebug('network:offline', globalAudio)
    const onPageHide = (e: PageTransitionEvent) => {
      recordKeepAliveDebug('page:hide', globalAudio, { persisted: e.persisted })

      const { mediaSessionLoading } = usePlayerStore.getState()
      const isStreamSrc = Boolean(globalAudio.src) && !globalAudio.src.startsWith('data:audio/wav')
      if (document.hidden && isStandaloneMode() && mediaSessionLoading && isStreamSrc) {
        recordKeepAliveDebug('keepalive:pagehide-fallback', globalAudio)
        startSilentKeepAlive('pagehide-loading-fallback')
      }
    }
    const onPageShow = (e: PageTransitionEvent) => {
      recordKeepAliveDebug('page:show', globalAudio, { persisted: e.persisted })
    }

    const audioEvents = [
      'play',
      'pause',
      'ended',
      'error',
      'stalled',
      'suspend',
      'waiting',
      'canplay',
      'canplaythrough',
      'emptied',
    ] as const

    const onAudioEvent = (event: Event) => {
      const mediaError = globalAudio.error
      recordKeepAliveDebug(`audio:${event.type}`, globalAudio, {
        mediaErrorCode: mediaError?.code ?? null,
      })
    }

    for (const name of audioEvents) {
      globalAudio.addEventListener(name, onAudioEvent)
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('pageshow', onPageShow)

    return () => {
      recordKeepAliveDebug('howl:unmount', globalAudio)
      for (const name of audioEvents) {
        globalAudio.removeEventListener(name, onAudioEvent)
      }
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('pageshow', onPageShow)
    }
  }, [startSilentKeepAlive])

  const startTimeUpdate = useCallback(() => {
    if (animFrameRef.current !== null) {
      clearInterval(animFrameRef.current)
      animFrameRef.current = null
    }
    stalledRef.current = { lastSeek: -1, since: 0 }

    const tick = () => {
      if (howlRef.current?.playing()) {
        const now = performance.now()
        if (now - lastTimeUpdateRef.current >= CURRENT_TIME_THROTTLE_MS) {
          lastTimeUpdateRef.current = now
          const seekVal = globalAudio.currentTime
          usePlayerStore.getState().setCurrentTime(seekVal)

          const st = stalledRef.current
          if (Math.abs(seekVal - st.lastSeek) < 0.05) {
            if (st.since > 0 && now - st.since > STALLED_TIMEOUT_MS) {
              console.warn('Playback stalled, skipping track')
              toast.error('播放中断，已跳到下一首')
              stalledRef.current = { lastSeek: -1, since: 0 }
              onTrackEnd()
              return
            }
          } else {
            stalledRef.current = { lastSeek: seekVal, since: now }
          }
        }
      }
    }

    const getInterval = () => (document.visibilityState === 'visible' ? CURRENT_TIME_THROTTLE_MS : 1000)

    animFrameRef.current = setInterval(tick, getInterval())

    const onVisibilityChange = () => {
      if (animFrameRef.current !== null) {
        clearInterval(animFrameRef.current)
        animFrameRef.current = setInterval(tick, getInterval())
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    visibilityCleanupRef.current = () =>
      document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [onTrackEnd])

  const stopTimeUpdate = useCallback(() => {
    if (animFrameRef.current !== null) {
      clearInterval(animFrameRef.current)
      animFrameRef.current = null
    }
    visibilityCleanupRef.current?.()
    visibilityCleanupRef.current = null
  }, [])

  const fadeAudio = (from: number, to: number, duration: number) => {
    globalAudio.volume = from
    let lastTime = Date.now()
    const step = () => {
      const now = Date.now()
      const dt = now - lastTime
      const stepValue = ((to - from) / Math.max(duration, 1)) * dt
      let newVol = globalAudio.volume + stepValue
      if ((to > from && newVol > to) || (to < from && newVol < to)) {
        newVol = to
      }
      globalAudio.volume = newVol
      if (newVol !== to) {
        lastTime = now
        requestAnimationFrame(step)
      }
    }
    requestAnimationFrame(step)
  }

  useEffect(() => {
    const handlePlay = () => {
      usePlayerStore.getState().setIsPlaying(true)
      const d = globalAudio.duration
      if (Number.isFinite(d) && d > 0) {
        usePlayerStore.getState().setDuration(d)
      }
      startTimeUpdate()
    }

    const handlePause = () => {
      usePlayerStore.getState().setIsPlaying(false)
      stopTimeUpdate()
    }

    const handleEnded = () => {
      console.log('[Audio Debug] ✨ native "ended" event triggered!')
      recordKeepAliveDebug('track:ended', globalAudio, {
        title: trackTitleRef.current,
      })
      // 以无声 WAV 循环播放，避免系统立马挂起 JS 导致无法拉取下一首歌
      if (globalAudio.src && !globalAudio.src.startsWith('data:audio/wav')) {
        console.log('[Audio Debug] Track ended. Starting silent WAV keep-alive...')
        startSilentKeepAlive('track-ended')
      }

      usePlayerStore.getState().setIsPlaying(false)
      stopTimeUpdate()
      onTrackEnd()
    }

    const handleError = () => {
      console.error('[Audio Debug] handleError called:', globalAudio.error)
      recordKeepAliveDebug('track:error', globalAudio, {
        title: trackTitleRef.current,
      })
      if (!retryRef.current && globalAudio.src && !globalAudio.src.startsWith('data:audio/wav')) {
        retryRef.current = true
        console.warn('Audio load error, retrying:', globalAudio.error)
        recordKeepAliveDebug('track:error-retry', globalAudio, {
          title: trackTitleRef.current,
        })
        globalAudio.load()
        globalAudio.play().catch(() => {})
        return
      }
      retryRef.current = false
      if (globalAudio.src && !globalAudio.src.startsWith('data:audio/wav')) {
        console.error('Audio load error (after retry):', globalAudio.error)
        const mediaError = globalAudio.error
        const message = String((mediaError as MediaError & { message?: string } | null)?.message ?? '')
        const normalized = message.toLowerCase()
        const likely403Like =
          mediaError?.code === 2 ||
          mediaError?.code === 4 ||
          normalized.includes('403') ||
          normalized.includes('forbidden') ||
          normalized.includes('status code 403')

        if (!recoveringRef.current && likely403Like && onRecoverPlaybackError) {
          recoveringRef.current = true
          usePlayerStore.getState().setMediaSessionLoading(true)
          void onRecoverPlaybackError({
            currentTime: Math.max(0, Number.isFinite(globalAudio.currentTime) ? globalAudio.currentTime : 0),
            mediaErrorCode: mediaError?.code ?? null,
            mediaErrorMessage: message || undefined,
          })
            .then((result) => {
              if (result.recovered) {
                usePlayerStore.getState().setMediaSessionLoading(false)
                return
              }

              if (!result.failureNotified) {
                toast.error(`「${trackTitleRef.current}」加载失败，已跳到下一首`)
              }
              onTrackEnd()
            })
            .catch(() => {
              toast.error(`「${trackTitleRef.current}」加载失败，已跳到下一首`)
              onTrackEnd()
            })
            .finally(() => {
              recoveringRef.current = false
            })
          return
        }

        usePlayerStore.getState().setMediaSessionLoading(true)
        toast.error(`「${trackTitleRef.current}」加载失败，已跳到下一首`)
        onTrackEnd()
      }
    }

    globalAudio.addEventListener('play', handlePlay)
    globalAudio.addEventListener('pause', handlePause)
    globalAudio.addEventListener('ended', handleEnded)
    globalAudio.addEventListener('error', handleError)

    return () => {
      globalAudio.removeEventListener('play', handlePlay)
      globalAudio.removeEventListener('pause', handlePause)
      globalAudio.removeEventListener('ended', handleEnded)
      globalAudio.removeEventListener('error', handleError)
    }
  }, [onRecoverPlaybackError, onTrackEnd, startTimeUpdate, stopTimeUpdate, startSilentKeepAlive])

  const loadTrack = useCallback(
    (track: Track, seekTo?: number, autoPlay = true) => {
      console.log(`[Audio Debug] loadTrack called. new track: ${track.title}, autoPlay: ${autoPlay}, seekTo: ${seekTo}`)
      recordKeepAliveDebug('track:load-start', globalAudio, {
        title: track.title,
        autoPlay,
        seekTo: seekTo ?? null,
      })

      if (shouldDeferTrackLoadToForeground(track, autoPlay)) {
        const prev = pendingForegroundLoadRef.current
        if (prev && prev.track.id !== track.id) {
          recordKeepAliveDebug('track:hidden-deferred-overwrite', globalAudio, {
            previousTitle: prev.track.title,
            nextTitle: track.title,
          })
        }

        pendingForegroundLoadRef.current = {
          track,
          seekTo,
          autoPlay,
          queuedAt: Date.now(),
        }
        usePlayerStore.getState().setCurrentTrack(track)
        usePlayerStore.getState().setMediaSessionLoading(true)
        clearHiddenLoadWatchdog('hidden-defer')
        recordKeepAliveDebug('track:hidden-deferred', globalAudio, {
          title: track.title,
          seekTo: seekTo ?? null,
        })
        startSilentKeepAlive('hidden-defer-track-load')
        return
      }
      
      if (unmuteTimerRef.current) {
        clearTimeout(unmuteTimerRef.current)
        unmuteTimerRef.current = null
      }
      if (playErrorTimerRef.current) {
        clearTimeout(playErrorTimerRef.current)
        playErrorTimerRef.current = null
      }
      clearHiddenLoadWatchdog('load-track-restart')

      stopTimeUpdate()
      syncReadyRef.current = false
      soundIdRef.current = 1
      trackTitleRef.current = track.title
      retryRef.current = false
      recoveringRef.current = false

      usePlayerStore.getState().setMediaSessionLoading(true)

      if (!track.streamUrl) {
        clearHiddenLoadWatchdog('no-stream-url')
        usePlayerStore.getState().setMediaSessionLoading(false)
        return
      }

      const loadStartTime = Date.now()
      const currentVolume = usePlayerStore.getState().volume

      globalAudio.src = track.streamUrl
      globalAudio.loop = false
      // 🚨 当处于后台(hidden)时不要静音，否则直接被系统按照省点策略暂停网络请求。处于前台时给一个极小值避免杂音突爆。
      globalAudio.volume = document.hidden ? Math.max(0.01, currentVolume) : 0.001
      globalAudio.playbackRate = 1

      const onCanPlay = () => {
        clearHiddenLoadWatchdog('canplay')
        globalAudio.removeEventListener('canplay', onCanPlay)
        if (globalAudio.src !== track.streamUrl) return

        usePlayerStore.getState().setMediaSessionLoading(false)
        recordKeepAliveDebug('track:canplay', globalAudio, {
          title: track.title,
        })

        const d = globalAudio.duration
        if (Number.isFinite(d) && d > 0) {
          usePlayerStore.getState().setDuration(d)
        }

        if (autoPlay) {
          if (seekTo && seekTo > 0) {
            usePlayerStore.getState().setCurrentTime(seekTo)
            globalAudio.currentTime = seekTo
          }
          
          globalAudio.play().then(() => {
            if (globalAudio.src !== track.streamUrl) return
            recordKeepAliveDebug('track:play-ok', globalAudio, {
              title: track.title,
            })
            
            const elapsed = (Date.now() - loadStartTime) / 1000
            const seekTarget = (seekTo ?? 0) + Math.min(elapsed, MAX_LOAD_COMPENSATION_S)
            if ((seekTo && seekTo > 0) || elapsed > LOAD_COMPENSATION_THRESHOLD_S) {
              globalAudio.currentTime = seekTarget
            }
          }).catch(e => {
            recordKeepAliveDebug('track:play-failed', globalAudio, {
              title: track.title,
              error: String(e),
              hidden: document.hidden,
            })
            if (document.hidden) return
            playErrorTimerRef.current = setTimeout(() => {
              if (document.hidden) {
                playErrorTimerRef.current = null
                return
              }
              playErrorTimerRef.current = null
              console.warn('Native Audio play error/timeout, skipping track', e)
              toast.error('播放失败，已跳到下一首')
              onTrackEnd()
            }, PLAY_ERROR_TIMEOUT_MS)
          })

          unmuteTimerRef.current = setTimeout(
            () => {
              if (globalAudio.src === track.streamUrl) {
                const latestVolume = usePlayerStore.getState().volume
                // 从当前音量平滑过渡，如果处于后台则直接沿用。
                fadeAudio(document.hidden ? latestVolume : 0.001, latestVolume, 200)
                syncReadyRef.current = true
              }
            },
            seekTo && seekTo > 0 ? HOWL_UNMUTE_DELAY_SEEK_MS : HOWL_UNMUTE_DELAY_DEFAULT_MS,
          )
        } else {
          if (seekTo && seekTo > 0) globalAudio.currentTime = seekTo
          globalAudio.volume = currentVolume
          usePlayerStore.getState().setCurrentTime(seekTo ?? 0)
          syncReadyRef.current = true
        }
      }

      globalAudio.addEventListener('canplay', onCanPlay)
      // 首先同步执行 load()
      globalAudio.load()
      recordKeepAliveDebug('track:load-called', globalAudio, {
        title: track.title,
      })

      if (autoPlay && document.hidden && isStandaloneMode()) {
        hiddenLoadWatchdogRef.current = setTimeout(() => {
          hiddenLoadWatchdogRef.current = null
          const { mediaSessionLoading } = usePlayerStore.getState()
          if (!mediaSessionLoading) return
          if (globalAudio.src !== track.streamUrl) return

          recordKeepAliveDebug('track:hidden-load-watchdog-triggered', globalAudio, {
            title: track.title,
            timeoutMs: HIDDEN_STREAM_LOAD_WATCHDOG_MS,
          })
          startSilentKeepAlive('hidden-load-watchdog')
        }, HIDDEN_STREAM_LOAD_WATCHDOG_MS)
      }
      
      // 在 load() 明确重置会话之后立刻 play(). 这向系统强宣我们占用媒体缓冲了
      if (autoPlay) {
        console.log('[Audio Debug] loadTrack autoPlay started for new URL.', track.streamUrl.substring(0, 30) + '...')
        globalAudio.play().then(() => {
          console.log('[Audio Debug] New track .play() success pending buffering.')
          recordKeepAliveDebug('track:prime-play-ok', globalAudio, {
            title: track.title,
          })
        }).catch((e) => {
          console.error('[Audio Debug] New track .play() failed:', e)
          recordKeepAliveDebug('track:prime-play-failed', globalAudio, {
            title: track.title,
            error: String(e),
          })
        })
      }
      
      usePlayerStore.getState().setCurrentTrack(track)
    },
    [clearHiddenLoadWatchdog, onTrackEnd, startSilentKeepAlive, stopTimeUpdate],
  )

  useEffect(() => {
    loadTrackRef.current = loadTrack
  }, [loadTrack])

  useEffect(() => {
    if (syncReadyRef.current) {
      globalAudio.volume = volume
    }
  }, [volume])

  useEffect(() => {
    return () => {
      recordKeepAliveDebug('howl:cleanup', globalAudio, {
        activeHowlHookCount,
      })
      if (unmuteTimerRef.current) {
        clearTimeout(unmuteTimerRef.current)
        unmuteTimerRef.current = null
      }
      if (playErrorTimerRef.current) {
        clearTimeout(playErrorTimerRef.current)
        playErrorTimerRef.current = null
      }
      clearHiddenLoadWatchdog('howl-cleanup')
      pendingForegroundLoadRef.current = null
      recoveringRef.current = false
      stopTimeUpdate()

      clearGlobalAudioTeardownTimer('cleanup-reschedule')
      globalAudioTeardownTimer = setTimeout(() => {
        globalAudioTeardownTimer = null
        if (activeHowlHookCount > 0) {
          recordKeepAliveDebug('howl:cleanup-cancelled-remount', globalAudio, {
            activeHowlHookCount,
          })
          return
        }

        if (shouldPreserveKeepAliveDuringUnmount()) {
          const nav = navigator as Navigator & { standalone?: boolean }
          recordKeepAliveDebug('howl:cleanup-preserve-keepalive', globalAudio, {
            standalone: Boolean(nav.standalone) || Boolean(window.matchMedia?.('(display-mode: standalone)').matches),
          })
          return
        }

        recordKeepAliveDebug('howl:cleanup-teardown-audio', globalAudio)
        usePlayerStore.getState().setMediaSessionLoading(false)
        teardownGlobalAudioElement()
      }, GLOBAL_AUDIO_TEARDOWN_DELAY_MS)
    }
  }, [clearHiddenLoadWatchdog, stopTimeUpdate])

  return { howlRef, soundIdRef, loadTrack }
}
