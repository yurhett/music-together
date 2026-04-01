import { useEffect } from 'react'
import { usePlayerStore } from '@/stores/playerStore'
import { useRoomStore } from '@/stores/roomStore'
import { useSocketContext } from '@/providers/SocketProvider'
import { EVENTS } from '@music-together/shared'
import { getNextTrackClient, getPrevTrackClient } from '@/lib/queueUtils'
import { globalHtmlAudio } from '@/lib/singletonAudio'
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
      const roomStore = useRoomStore.getState().room
      if (roomStore && globalHtmlAudio) {
        const nextTrack = getNextTrackClient(roomStore.queue, roomStore.currentTrack, roomStore.playMode)
        if (nextTrack) {
          usePlayerStore.getState().setCurrentTrack(nextTrack)
          usePlayerStore.getState().setIsPlaying(true)
        }
        
        // 【核心】使用当前已缓存加载完的歌曲，零音量继续播放充当后台驻留锁！
        // 避开了伪造跨域/ Blob URL 导致 Safari 拒绝解析的 "NotSupportedError"。
        globalHtmlAudio.volume = 0
        globalHtmlAudio.play().catch((e) => {
          console.error('[MediaSession] next play volume0 failed:', e)
          toast.error(`[Next] Guard fallback failed: ${e.message}`)
        })
      }
      socket.emit(EVENTS.PLAYER_NEXT)
    }

    const handlePrev = () => {
      console.log('[MediaSession] handlePrev triggered')
      const roomStore = useRoomStore.getState().room
      if (roomStore && globalHtmlAudio) {
        const prevTrack = getPrevTrackClient(roomStore.queue, roomStore.currentTrack, roomStore.playMode)
        if (prevTrack) {
          usePlayerStore.getState().setCurrentTrack(prevTrack)
          usePlayerStore.getState().setIsPlaying(true)
        }
        
        globalHtmlAudio.volume = 0
        globalHtmlAudio.play().catch((e) => {
          console.error('[MediaSession] prev play volume0 failed:', e)
          toast.error(`[Prev] Guard fallback failed: ${e.message}`)
        })
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
