import { useCallback, useEffect, useRef } from 'react'
import type { Track } from '@music-together/shared'
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
import { getNextTrackClient } from '@/lib/queueUtils'

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

      let isSameSrc = false
      if (track.streamUrl) {
        try {
          const targetUrl = new URL(track.streamUrl, window.location.origin).href
          if (audioEl.src === targetUrl) {
            isSameSrc = true
          }
        } catch(e) {}
      }

      if (!isSameSrc) {
        audioEl.loop = false // 关掉为前一个空白保活片段开启的 loop
        audioEl.volume = 0
        audioEl.src = track.streamUrl
      }
      
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
        
        // --- GAPLESS SWAP & BACKGROUND EXEMPTION FOR iOS SAFARI ---
        // 抛弃容易引发兼容和解码出错的基站静音包。直接利用当前这首已知而且合法的流媒体，
        // 将音量清零，并且退回 0 的位置开启单曲循环，依靠这个真实的网络资源当作底层保活锁！
        // 当后续真正的 loadTrack 接到 WebSocket 通知时，它接替这个现成的存活锁切歌。
        const roomStore = useRoomStore.getState().room
        if (roomStore && globalHtmlAudio) {
          const nextTrack = getNextTrackClient(roomStore.queue, roomStore.currentTrack, roomStore.playMode)
          if (nextTrack) {
            usePlayerStore.getState().setCurrentTrack(nextTrack)
            usePlayerStore.getState().setIsPlaying(true)
            trackTitleRef.current = nextTrack.title
          }
          
          audioEl.loop = true
          audioEl.volume = 0
          audioEl.currentTime = 0
          audioEl.play().catch((e: any) => {
            console.error('[Background] rewind auto-play failed', e)
            toast.error(`[Background] auto-play fallback failed: ${e.message}`)
          })
        }

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
      
      if (!isSameSrc) {
        if (autoPlay) {
          audioEl.play().catch((e: any) => {
            console.error('Audio sync play error:', e)
          })
        } else {
          usePlayerStore.getState().setCurrentTime(seekTo ?? 0)
        }
      } else {
        console.log('[loadTrack] Stream URL is identical! Skipping hard reload.')
        if (autoPlay) {
          audioEl.play().catch(() => {})
        }
        if (audioEl.readyState >= 2) { // 至少有当前帧的数据
           if (autoPlay && howlRef.current) {
               howlRef.current.fade(0, currentVolume, 200)
               syncReadyRef.current = true
           } else {
               audioEl.volume = currentVolume
               syncReadyRef.current = true
           }
        }
        if (!audioEl.paused) {
           usePlayerStore.getState().setIsPlaying(true)
           const dur = audioEl.duration
           if (Number.isFinite(dur) && dur > 0) usePlayerStore.getState().setDuration(dur)
           startTimeUpdate()
        }
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
