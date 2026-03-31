import { useCallback, useEffect, useRef } from 'react'
import type { Track } from '@music-together/shared'
import { usePlayerStore } from '@/stores/playerStore'
import {
  CURRENT_TIME_THROTTLE_MS,
  HOWL_UNMUTE_DELAY_SEEK_MS,
  HOWL_UNMUTE_DELAY_DEFAULT_MS,
  LOAD_COMPENSATION_THRESHOLD_S,
  MAX_LOAD_COMPENSATION_S,
} from '@/lib/constants'
import { toast } from 'sonner'
import { globalHtmlAudio } from '@/lib/singletonAudio'

export interface AudioFacade {
  unload: () => void
  play: (id?: number) => number
  pause: (id?: number) => void
  seek: (val?: number) => number
  volume: (val?: number) => number
  duration: () => number
  playing: () => boolean
  fade: (from: number, to: number, durationMs: number) => void
  rate: (val?: number) => number
}

/** If playback reports playing() but currentTime doesn't advance for this
 *  many milliseconds, treat it as stalled (network drop mid-stream). */
const STALLED_TIMEOUT_MS = 8000

function createAudioFacade(audioEl: HTMLAudioElement | null): AudioFacade | null {
  if (!audioEl) return null
  return {
    unload: () => {
      audioEl.pause()
      audioEl.removeAttribute('src')
      audioEl.load()
    },
    play: () => {
      audioEl.play().catch(() => {})
      return 1
    },
    pause: () => {
      audioEl.pause()
    },
    seek: (val?: number) => {
      if (val !== undefined) {
        audioEl.currentTime = val
        return val
      }
      return audioEl.currentTime
    },
    volume: (val?: number) => {
      if (val !== undefined) {
        audioEl.volume = Math.max(0, Math.min(1, val))
        return val
      }
      return audioEl.volume
    },
    duration: () => audioEl.duration || 0,
    playing: () => !audioEl.paused && !audioEl.ended && audioEl.readyState > 0,
    fade: (from: number, to: number, durationMs: number) => {
      audioEl.volume = from
      const steps = 20
      const stepTime = Math.max(10, durationMs / steps)
      const stepVol = (to - from) / steps
      let currentStep = 0
      
      const el = audioEl as any
      if (el._fadeInterval) clearInterval(el._fadeInterval)
      
      el._fadeInterval = setInterval(() => {
        currentStep++
        let nextVol = from + stepVol * currentStep
        if (nextVol < 0) nextVol = 0
        if (nextVol > 1) nextVol = 1
        audioEl.volume = nextVol
        if (currentStep >= steps) {
          clearInterval(el._fadeInterval)
        }
      }, stepTime)
    },
    rate: (val?: number) => {
      if (val !== undefined) {
        audioEl.playbackRate = val
        return val
      }
      return audioEl.playbackRate
    }
  }
}

/**
 * Manages playback via a Singleton HTMLAudioElement.
 * Bypassing Howler completely here allows us to retain iOS Safari
 * background playing permissions by never recreating the strict <audio> element.
 */
export function useHowl(onTrackEnd: () => void) {
  const howlRef = useRef<AudioFacade | null>(null)
  const soundIdRef = useRef<number | undefined>(undefined)
  const animFrameRef = useRef<number>(0)
  const syncReadyRef = useRef(false)
  const unmuteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastTimeUpdateRef = useRef(0)
  const stalledRef = useRef<{ lastSeek: number; since: number }>({ lastSeek: -1, since: 0 })
  const trackTitleRef = useRef<string>('')
  const retryRef = useRef(false)

  const volume = usePlayerStore((s) => s.volume)

  // Initialize facade once
  useEffect(() => {
    if (!howlRef.current && globalHtmlAudio) {
      howlRef.current = createAudioFacade(globalHtmlAudio)
    }
  }, [])

  const startTimeUpdate = useCallback(() => {
    cancelAnimationFrame(animFrameRef.current)
    stalledRef.current = { lastSeek: -1, since: 0 }
    const update = () => {
      if (howlRef.current && howlRef.current.playing()) {
        const now = performance.now()
        if (now - lastTimeUpdateRef.current >= CURRENT_TIME_THROTTLE_MS) {
          lastTimeUpdateRef.current = now
          const seekVal = howlRef.current.seek() as number
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
      animFrameRef.current = requestAnimationFrame(update)
    }
    animFrameRef.current = requestAnimationFrame(update)
  }, [onTrackEnd])

  const stopTimeUpdate = useCallback(() => {
    cancelAnimationFrame(animFrameRef.current)
  }, [])

  const loadTrack = useCallback(
    (track: Track, seekTo?: number, autoPlay = true) => {
      if (unmuteTimerRef.current) {
        clearTimeout(unmuteTimerRef.current)
        unmuteTimerRef.current = null
      }

      if (globalHtmlAudio) {
        // iOS Safari Background Fix: DO NOT call .pause() here!
        // Pausing immediately before swapping .src breaks the continuous playback
        // chain, which makes Safari drop the background media session token.
        // Re-assigning .src below will naturally halt the old track.
        // globalHtmlAudio.pause() 
        stopTimeUpdate()
      }

      syncReadyRef.current = false
      soundIdRef.current = 1
      trackTitleRef.current = track.title
      retryRef.current = false

      if (!track.streamUrl || !globalHtmlAudio) return

      const audioEl = globalHtmlAudio
      const loadStartTime = Date.now()
      const currentVolume = usePlayerStore.getState().volume

      // Clear old listeners safely
      audioEl.onloadeddata = null
      audioEl.onplaying = null
      audioEl.onplay = null
      audioEl.onpause = null
      audioEl.onended = null
      audioEl.onerror = null

      audioEl.volume = 0
      audioEl.src = track.streamUrl
      
      let hasPlayedOnce = false

      audioEl.onloadedmetadata = () => {
        const d = audioEl.duration
        if (Number.isFinite(d) && d > 0) {
          usePlayerStore.getState().setDuration(d)
        }
        if (seekTo && seekTo > 0) {
          audioEl.currentTime = seekTo
          usePlayerStore.getState().setCurrentTime(seekTo)
        }
      }

      audioEl.onloadeddata = () => {
        if (autoPlay) {
          unmuteTimerRef.current = setTimeout(() => {
            if (howlRef.current) {
              const latestVolume = usePlayerStore.getState().volume
              howlRef.current.fade(0, latestVolume, 200)
              syncReadyRef.current = true
            }
          }, seekTo && seekTo > 0 ? HOWL_UNMUTE_DELAY_SEEK_MS : HOWL_UNMUTE_DELAY_DEFAULT_MS)
        } else {
          audioEl.volume = currentVolume
          syncReadyRef.current = true
        }
      }

      audioEl.onplaying = () => {
        if (!hasPlayedOnce && autoPlay) {
          hasPlayedOnce = true
          const elapsed = (Date.now() - loadStartTime) / 1000
          const seekTarget = (seekTo ?? 0) + Math.min(elapsed, MAX_LOAD_COMPENSATION_S)
          if ((seekTo && seekTo > 0) || elapsed > LOAD_COMPENSATION_THRESHOLD_S) {
            audioEl.currentTime = seekTarget
          }
        }
        usePlayerStore.getState().setIsPlaying(true)
        const dur = audioEl.duration
        if (Number.isFinite(dur) && dur > 0) {
          usePlayerStore.getState().setDuration(dur)
        }
        startTimeUpdate()
      }

      audioEl.onpause = () => {
        usePlayerStore.getState().setIsPlaying(false)
        stopTimeUpdate()
      }

      audioEl.onended = () => {
        usePlayerStore.getState().setIsPlaying(false)
        stopTimeUpdate()
        onTrackEnd()
      }

      audioEl.onerror = () => {
        if (!retryRef.current && globalHtmlAudio) {
          retryRef.current = true
          console.warn('Audio load error, retrying')
          // audioEl.load() // Removed to avoid iOS lock loss
          if (autoPlay) audioEl.play().catch(()=>{})
          return
        }
        retryRef.current = false
        console.error('Audio load error (after retry)')
        toast.error(`「${trackTitleRef.current}」加载失败，已跳到下一首`)
        onTrackEnd()
      }

      // DO NOT call audioEl.load() explicitly, as it drops the unlocked state on iOS Safari.
      // Changing .src implicitly begins the load algorithm.
      
      if (autoPlay) {
        audioEl.play().catch((e) => {
          console.error('Audio sync play error:', e)
        })
      } else {
        usePlayerStore.getState().setCurrentTime(seekTo ?? 0)
      }
      
      usePlayerStore.getState().setCurrentTrack(track)
    },
    [onTrackEnd, startTimeUpdate, stopTimeUpdate],
  )

  useEffect(() => {
    if (syncReadyRef.current && globalHtmlAudio) {
      globalHtmlAudio.volume = volume
    }
  }, [volume])

  useEffect(() => {
    return () => {
      if (unmuteTimerRef.current) {
        clearTimeout(unmuteTimerRef.current)
        unmuteTimerRef.current = null
      }
      stopTimeUpdate()
    }
  }, [stopTimeUpdate])

  return { howlRef, soundIdRef, loadTrack }
}
