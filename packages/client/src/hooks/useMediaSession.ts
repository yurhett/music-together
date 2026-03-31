import { useEffect } from 'react'
import { useSocketContext } from '@/providers/SocketProvider'
import { EVENTS } from '@music-together/shared'
import { usePlayerStore } from '@/stores/playerStore'
import { holdAudioSession } from '@/lib/audioUnlock'

export function useMediaSession() {
  const { socket } = useSocketContext()
  const currentTrack = usePlayerStore((s) => s.currentTrack)

  useEffect(() => {
    if (!('mediaSession' in navigator)) return

    if (currentTrack) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: currentTrack.title,
        artist: currentTrack.artist.join(', '),
        album: currentTrack.album,
        artwork: currentTrack.cover ? [{ src: currentTrack.cover, sizes: '512x512', type: 'image/jpeg' }] : [],
      })

      navigator.mediaSession.setActionHandler('nexttrack', () => {
        holdAudioSession()
        socket.emit(EVENTS.PLAYER_NEXT)
      })

      navigator.mediaSession.setActionHandler('previoustrack', () => {
        holdAudioSession()
        socket.emit(EVENTS.PLAYER_PREV)
      })

      navigator.mediaSession.setActionHandler('play', () => {
        holdAudioSession()
        socket.emit(EVENTS.PLAYER_PLAY)
      })

      navigator.mediaSession.setActionHandler('pause', () => {
        socket.emit(EVENTS.PLAYER_PAUSE)
      })
    } else {
      navigator.mediaSession.metadata = null
      navigator.mediaSession.setActionHandler('nexttrack', null)
      navigator.mediaSession.setActionHandler('previoustrack', null)
      navigator.mediaSession.setActionHandler('play', null)
      navigator.mediaSession.setActionHandler('pause', null)
    }

    return () => {
      if ('mediaSession' in navigator) {
        navigator.mediaSession.setActionHandler('nexttrack', null)
        navigator.mediaSession.setActionHandler('previoustrack', null)
        navigator.mediaSession.setActionHandler('play', null)
        navigator.mediaSession.setActionHandler('pause', null)
      }
    }
  }, [currentTrack, socket])
}
