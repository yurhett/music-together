import { useCallback, useEffect, useRef } from 'react'
import type { Track, PlayMode } from '@music-together/shared'
import { useRoomStore } from '@/stores/roomStore'
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

function getNextTrackClient(queue: Track[], currentTrack: Track | null, playMode: PlayMode): Track | null {
  if (queue.length === 0) return null
  const currentIndex = currentTrack ? queue.findIndex((t) => t.id === currentTrack.id) : -1

  switch (playMode) {
    case 'loop-one':
      if (currentTrack && currentIndex >= 0) return currentTrack
      return queue[0] ?? null
    case 'loop-all': {
      const nextIndex = currentIndex + 1
      return nextIndex < queue.length ? queue[nextIndex] : queue[0]
    }
    case 'shuffle': {
      if (queue.length === 1) return queue[0]
      // Use standard sequential as fallback for shuffle prediction
      // unless server has already pre-fetched a specific random track
      const preFetched = queue.find((t, i) => i !== currentIndex && t.streamUrl)
      if (preFetched) return preFetched
      const nextIndex = currentIndex + 1
      return nextIndex < queue.length ? queue[nextIndex] : queue[0]
    }
    case 'sequential':
    default: {
      const nextIndex = currentIndex + 1
      return nextIndex < queue.length ? queue[nextIndex] : null
    }
  }
}

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
      // Explicitly load prevents iOS PWA from getting stuck when shifting from broken states
      audioEl.load()
      
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
        
        // --- GAPLESS SWAP FOR iOS SAFARI BACKGROUND ---
        // If we know the next track and it already has a resolved streamUrl (pre-fetched by server),
        // we synchronously update the src and play() right now. This avoids losing the background
        // media session lock which drops if we wait for asynchronous websocket replies.
        const roomStore = useRoomStore.getState().room
        if (roomStore && globalHtmlAudio) {
          const nextTrack = getNextTrackClient(roomStore.queue, roomStore.currentTrack, roomStore.playMode)
          if (nextTrack && nextTrack.streamUrl) {
            console.log('[Gapless] Synchronously swapping to next track:', nextTrack.title)
            audioEl.src = nextTrack.streamUrl
            audioEl.load() // Flush old buffers completely for strict iOS WebKit compliance
            audioEl.play().catch((e: any) => console.error('[Gapless] auto-play failed', e))
            // We tell our UI we are playing the new track immediately
            usePlayerStore.getState().setCurrentTrack(nextTrack)
            usePlayerStore.getState().setIsPlaying(true)
            trackTitleRef.current = nextTrack.title
            // (Note: startTimeUpdate will hook up when onplaying triggers)
          }
        }
        
        onTrackEnd()
      }

      audioEl.onerror = () => {
        if (!retryRef.current && globalHtmlAudio) {
          retryRef.current = true
          console.warn('Audio load error, retrying')
          audioEl.load() // Explicitly retry
          if (autoPlay) audioEl.play().catch(()=>{})
          return
        }
        retryRef.current = false
        console.error('Audio load error (after retry)')
        toast.error(`「${trackTitleRef.current}」加载失败，已跳到下一首`)
        
        // UNBRICK the iOS media element after a fatal error
        audioEl.removeAttribute('src')
        audioEl.load()
        
        onTrackEnd()
      }

      // DO NOT call audioEl.load() explicitly, as it drops the unlocked state on iOS Safari.
      // Changing .src implicitly begins the load algorithm.
      
      if (autoPlay) {
        audioEl.play().catch((e: any) => {
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
