import { useEffect } from 'react'
import { usePlayerStore } from '@/stores/playerStore'
import { useRoomStore } from '@/stores/roomStore'
import { useSocketContext } from '@/providers/SocketProvider'
import { EVENTS } from '@music-together/shared'
import { getNextTrackClient, getPrevTrackClient } from '@/lib/queueUtils'
import { globalHtmlAudio } from '@/lib/singletonAudio'

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
      // 保持 Media Session 活跃：立即在用户操作堆栈里触发 play
      if (globalHtmlAudio) {
        globalHtmlAudio.play().catch(() => {})
      }
      socket.emit(EVENTS.PLAYER_RESUME)
    }

    const handlePause = () => {
      // 在用户操作堆栈里立即暂停
      if (globalHtmlAudio) {
        globalHtmlAudio.pause()
      }
      socket.emit(EVENTS.PLAYER_PAUSE)
    }

    const handleNext = () => {
      // 乐观更新机制：如果本地已经取到 streamUrl 则直接塞给音频元素并播放，防 Safari 杀后台媒体锁
      const roomStore = useRoomStore.getState().room
      if (roomStore && globalHtmlAudio) {
        const nextTrack = getNextTrackClient(roomStore.queue, roomStore.currentTrack, roomStore.playMode)
        if (nextTrack && nextTrack.streamUrl) {
          globalHtmlAudio.src = nextTrack.streamUrl
          globalHtmlAudio.play().catch(() => {})
          usePlayerStore.getState().setCurrentTrack(nextTrack)
          usePlayerStore.getState().setIsPlaying(true)
        } else {
          // 如果没有则尝试刷新锁
          globalHtmlAudio.play().catch(() => {})
        }
      }
      socket.emit(EVENTS.PLAYER_NEXT)
    }

    const handlePrev = () => {
      const roomStore = useRoomStore.getState().room
      if (roomStore && globalHtmlAudio) {
        const prevTrack = getPrevTrackClient(roomStore.queue, roomStore.currentTrack, roomStore.playMode)
        if (prevTrack && prevTrack.streamUrl) {
          globalHtmlAudio.src = prevTrack.streamUrl
          globalHtmlAudio.play().catch(() => {})
          usePlayerStore.getState().setCurrentTrack(prevTrack)
          usePlayerStore.getState().setIsPlaying(true)
        } else {
          globalHtmlAudio.play().catch(() => {})
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
