import { useEffect } from 'react'
import { usePlayerStore } from '@/stores/playerStore'
import { useRoomStore } from '@/stores/roomStore'
import { useSocketContext } from '@/providers/SocketProvider'
import { EVENTS } from '@music-together/shared'
import { getNextTrackClient, getPrevTrackClient } from '@/lib/queueUtils'
import { globalHtmlAudio } from '@/lib/singletonAudio'
import { SILENT_AUDIO_BASE64 } from '@/lib/silentAudio'
import { toast } from 'sonner'

export function useMediaSession() {
  const { currentTrack } = usePlayerStore()
  const { socket } = useSocketContext()

  useEffect(() => {
    if (!('mediaSession' in navigator) || !currentTrack) return

    const artistList = Array.isArray(currentTrack.artist)
      ? currentTrack.artist.join(', ')
      : currentTrack.artist

    // Update metadata for system media player
    navigator.mediaSession.metadata = new MediaMetadata({
      title: currentTrack.title,
      artist: artistList || 'Unknown Artist',
      album: currentTrack.album || '',
      artwork: currentTrack.cover
        ? [
            {
              src: currentTrack.cover,
              sizes: '512x512',
              type: 'image/jpeg',
            },
          ]
        : [],
    })

    const handlePlay = () => {
      console.log('[MediaSession] handlePlay triggered')
      // 保持 Media Session 活跃：立即在用户操作堆栈里触发 play
      if (globalHtmlAudio) {
        globalHtmlAudio.play().catch((e) => {
          console.error('[MediaSession] play failed:', e)
          toast.error(`[Play] Failed: ${e.message}`)
        })
      }
      socket.emit(EVENTS.PLAYER_RESUME)
    }

    const handlePause = () => {
      console.log('[MediaSession] handlePause triggered')
      // 在用户操作堆栈里立即暂停
      if (globalHtmlAudio) {
        globalHtmlAudio.pause()
      }
      socket.emit(EVENTS.PLAYER_PAUSE)
    }

    const handleNext = () => {
      console.log('[MediaSession] handleNext triggered')
      // 乐观更新机制：如果本地已经取到 streamUrl 则直接塞给音频元素并播放，防 Safari 杀后台媒体锁
      const roomStore = useRoomStore.getState().room
      if (roomStore && globalHtmlAudio) {
        const nextTrack = getNextTrackClient(roomStore.queue, roomStore.currentTrack, roomStore.playMode)
        if (nextTrack && nextTrack.streamUrl) {
          globalHtmlAudio.loop = false
          globalHtmlAudio.src = nextTrack.streamUrl
          globalHtmlAudio.play().catch((e) => {
            console.error('[MediaSession] next play URL failed:', e)
            toast.error(`[Next] URL play failed: ${e.message}`)
          })
          usePlayerStore.getState().setCurrentTrack(nextTrack)
          usePlayerStore.getState().setIsPlaying(true)
        } else {
          // 如果没有则使用静音音频来维系后台锁，等待 Socket 事件带来的真实变更触发 loadTrack
          globalHtmlAudio.loop = true
          globalHtmlAudio.src = SILENT_AUDIO_BASE64
          globalHtmlAudio.play().catch((e) => {
            console.error('[MediaSession] next play silent failed:', e)
            toast.error(`[Next] Silent play failed: ${e.message}`)
          })
        }
      }
      socket.emit(EVENTS.PLAYER_NEXT)
    }

    const handlePrev = () => {
      console.log('[MediaSession] handlePrev triggered')
      const roomStore = useRoomStore.getState().room
      if (roomStore && globalHtmlAudio) {
        const prevTrack = getPrevTrackClient(roomStore.queue, roomStore.currentTrack, roomStore.playMode)
        if (prevTrack && prevTrack.streamUrl) {
          globalHtmlAudio.loop = false
          globalHtmlAudio.src = prevTrack.streamUrl
          globalHtmlAudio.play().catch((e) => {
            console.error('[MediaSession] prev play URL failed:', e)
            toast.error(`[Prev] URL play failed: ${e.message}`)
          })
          usePlayerStore.getState().setCurrentTrack(prevTrack)
          usePlayerStore.getState().setIsPlaying(true)
        } else {
          // 同样使用静音音频来维系后台锁
          globalHtmlAudio.loop = true
          globalHtmlAudio.src = SILENT_AUDIO_BASE64
          globalHtmlAudio.play().catch((e) => {
            console.error('[MediaSession] prev play silent failed:', e)
            toast.error(`[Prev] Silent play failed: ${e.message}`)
          })
        }
      }
      socket.emit(EVENTS.PLAYER_PREV)
    }

    navigator.mediaSession.setActionHandler('play', handlePlay)
    navigator.mediaSession.setActionHandler('pause', handlePause)
    navigator.mediaSession.setActionHandler('nexttrack', handleNext)
    navigator.mediaSession.setActionHandler('previoustrack', handlePrev)

    return () => {
      if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = null
        navigator.mediaSession.setActionHandler('play', null)
        navigator.mediaSession.setActionHandler('pause', null)
        navigator.mediaSession.setActionHandler('nexttrack', null)
        navigator.mediaSession.setActionHandler('previoustrack', null)
      }
    }
  }, [currentTrack, socket])
}
