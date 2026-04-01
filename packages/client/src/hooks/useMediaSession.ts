import { useEffect } from 'react'
import { usePlayerStore } from '@/stores/playerStore'
import { useRoomStore } from '@/stores/roomStore'
import { useSocketContext } from '@/providers/SocketProvider'
import { EVENTS } from '@music-together/shared'
import { getNextTrackClient, getPrevTrackClient } from '@/lib/queueUtils'
import { globalHtmlAudio } from '@/lib/singletonAudio'
import { startKeepAlive } from '@/lib/keepAliveAudio'
import type { Track } from '@music-together/shared'

/**
 * 同步更新 MediaSession 元数据。
 * 在后台环境下 React useEffect 可能被延迟执行，
 * 因此切歌时必须在 action handler 的同步调用栈中立即更新，
 * 否则 iOS 控制中心会短暂显示旧信息或空白。
 */
function syncMediaSessionMetadata(track: Track) {
  if (!('mediaSession' in navigator)) return
  const artistList = Array.isArray(track.artist)
    ? track.artist.join(', ')
    : track.artist

  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    artist: artistList || 'Unknown Artist',
    album: track.album || '',
    artwork: track.cover
      ? [{ src: track.cover, sizes: '512x512', type: 'image/jpeg' }]
      : [],
  })
  navigator.mediaSession.playbackState = 'playing'
}

/**
 * 乐观切歌的统一处理逻辑。
 *
 * 情况 A: streamUrl 可用 → 立即设置 src 并播放（同步保活）
 * 情况 B: streamUrl 不可用 → 启动 keepAlive 保活音频，
 *         等待服务端 PLAYER_PLAY 响应后由 loadTrack 接管
 */
function optimisticSwap(track: Track | null) {
  if (!track || !globalHtmlAudio) return

  if (track.streamUrl) {
    // 情况 A：有 streamUrl → 立即切换并播放
    globalHtmlAudio.src = track.streamUrl
    globalHtmlAudio.play().catch(() => {})
    usePlayerStore.getState().setCurrentTrack(track)
    usePlayerStore.getState().setIsPlaying(true)
    syncMediaSessionMetadata(track)
  } else {
    // 情况 B：无 streamUrl → 启动保活，防止 iOS 挂起
    // 保活音频在第二个 audio 元素上播放，不影响主元素
    startKeepAlive()
    // 先更新 UI 状态，让控制中心显示下一首的信息
    usePlayerStore.getState().setCurrentTrack(track)
    usePlayerStore.getState().setIsPlaying(true)
    syncMediaSessionMetadata(track)
  }
}

export function useMediaSession() {
  const { currentTrack } = usePlayerStore()
  const { socket } = useSocketContext()

  useEffect(() => {
    if (!('mediaSession' in navigator) || !currentTrack) return

    const artistList = Array.isArray(currentTrack.artist)
      ? currentTrack.artist.join(', ')
      : currentTrack.artist

    // 更新系统媒体播放器的元数据
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
      const roomState = useRoomStore.getState().room
      if (roomState) {
        const nextTrack = getNextTrackClient(roomState.queue, roomState.currentTrack, roomState.playMode)
        // 乐观更新：同步启动音频或保活，防止 iOS 挂起
        optimisticSwap(nextTrack)
      }
      socket.emit(EVENTS.PLAYER_NEXT)
    }

    const handlePrev = () => {
      const roomState = useRoomStore.getState().room
      if (roomState) {
        const prevTrack = getPrevTrackClient(roomState.queue, roomState.currentTrack, roomState.playMode)
        optimisticSwap(prevTrack)
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
