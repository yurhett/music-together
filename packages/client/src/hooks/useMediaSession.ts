import { useEffect } from 'react'
import { usePlayerStore } from '@/stores/playerStore'
import { useSocketContext } from '@/providers/SocketProvider'
import { EVENTS } from '@music-together/shared'

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

    const handlePlay = () => socket.emit(EVENTS.PLAYER_RESUME)
    const handlePause = () => socket.emit(EVENTS.PLAYER_PAUSE)
    const handleNext = () => socket.emit(EVENTS.PLAYER_NEXT)
    const handlePrev = () => socket.emit(EVENTS.PLAYER_PREV)

    navigator.mediaSession.setActionHandler('play', handlePlay)
    navigator.mediaSession.setActionHandler('pause', handlePause)
    navigator.mediaSession.setActionHandler('nexttrack', handleNext)
    navigator.mediaSession.setActionHandler('previoustrack', handlePrev)

    return () => {
      // Do not clear metadata on track changes to prevent iOS from dropping background audio lock!
      // Action handlers can be reassigned on next render.
    }
  }, [currentTrack, socket])

  // Separate effect to clear session only when no track is loaded (e.g. left room)
  useEffect(() => {
    if (!currentTrack && 'mediaSession' in navigator) {
      navigator.mediaSession.metadata = null
      navigator.mediaSession.setActionHandler('play', null)
      navigator.mediaSession.setActionHandler('pause', null)
      navigator.mediaSession.setActionHandler('nexttrack', null)
      navigator.mediaSession.setActionHandler('previoustrack', null)
    }
  }, [currentTrack])
}
