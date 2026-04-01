import { useCallback, useEffect, useRef } from 'react'
import type { Track } from '@music-together/shared'
import { usePlayerStore } from '@/stores/playerStore'
import { globalAudio } from '@/lib/audioUnlock'
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

export function useHowl(onTrackEnd: () => void) {
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
  const visibilityCleanupRef = useRef<(() => void) | null>(null)

  const volume = usePlayerStore((s) => s.volume)

  if (!howlRef.current) {
    howlRef.current = new NativeAudioAdapter()
  }

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
      usePlayerStore.getState().setIsPlaying(false)
      stopTimeUpdate()
      onTrackEnd()
    }

    const handleError = () => {
      if (!retryRef.current && globalAudio.src && !globalAudio.src.startsWith('data:audio/wav')) {
        retryRef.current = true
        console.warn('Audio load error, retrying:', globalAudio.error)
        globalAudio.load()
        globalAudio.play().catch(() => {})
        return
      }
      retryRef.current = false
      if (globalAudio.src && !globalAudio.src.startsWith('data:audio/wav')) {
        console.error('Audio load error (after retry):', globalAudio.error)
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
  }, [onTrackEnd, startTimeUpdate, stopTimeUpdate])

  const loadTrack = useCallback(
    (track: Track, seekTo?: number, autoPlay = true) => {
      if (unmuteTimerRef.current) {
        clearTimeout(unmuteTimerRef.current)
        unmuteTimerRef.current = null
      }
      if (playErrorTimerRef.current) {
        clearTimeout(playErrorTimerRef.current)
        playErrorTimerRef.current = null
      }

      stopTimeUpdate()
      syncReadyRef.current = false
      soundIdRef.current = 1
      trackTitleRef.current = track.title
      retryRef.current = false

      if (!track.streamUrl) return

      const loadStartTime = Date.now()
      const currentVolume = usePlayerStore.getState().volume

      globalAudio.src = track.streamUrl
      globalAudio.volume = 0
      globalAudio.playbackRate = 1
      
      const onCanPlay = () => {
        globalAudio.removeEventListener('canplay', onCanPlay)
        if (globalAudio.src !== track.streamUrl) return

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
            
            const elapsed = (Date.now() - loadStartTime) / 1000
            const seekTarget = (seekTo ?? 0) + Math.min(elapsed, MAX_LOAD_COMPENSATION_S)
            if ((seekTo && seekTo > 0) || elapsed > LOAD_COMPENSATION_THRESHOLD_S) {
              globalAudio.currentTime = seekTarget
            }
          }).catch(e => {
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
                fadeAudio(0, latestVolume, 200)
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
      globalAudio.load()
      usePlayerStore.getState().setCurrentTrack(track)
    },
    [onTrackEnd, stopTimeUpdate],
  )

  useEffect(() => {
    if (syncReadyRef.current) {
      globalAudio.volume = volume
    }
  }, [volume])

  useEffect(() => {
    return () => {
      if (unmuteTimerRef.current) {
        clearTimeout(unmuteTimerRef.current)
        unmuteTimerRef.current = null
      }
      if (playErrorTimerRef.current) {
        clearTimeout(playErrorTimerRef.current)
        playErrorTimerRef.current = null
      }
      stopTimeUpdate()
      globalAudio.pause()
      globalAudio.removeAttribute('src')
      globalAudio.load()
    }
  }, [stopTimeUpdate])

  return { howlRef, soundIdRef, loadTrack }
}
