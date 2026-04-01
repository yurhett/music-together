import type { Track, PlayMode } from '@music-together/shared'

export function getNextTrackClient(queue: Track[], currentTrack: Track | null, playMode: PlayMode): Track | null {
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

export function getPrevTrackClient(queue: Track[], currentTrack: Track | null, playMode: PlayMode): Track | null {
  if (queue.length === 0) return null
  const currentIndex = currentTrack ? queue.findIndex((t) => t.id === currentTrack.id) : -1

  switch (playMode) {
    case 'loop-one':
      if (currentTrack && currentIndex >= 0) return currentTrack
      return queue[queue.length - 1] ?? null
    case 'loop-all': {
      const prevIndex = currentIndex - 1
      return prevIndex >= 0 ? queue[prevIndex] : queue[queue.length - 1]
    }
    case 'shuffle': {
      if (queue.length === 1) return queue[0]
      const prevIndex = currentIndex - 1
      return prevIndex >= 0 ? queue[prevIndex] : queue[queue.length - 1]
    }
    case 'sequential':
    default: {
      const prevIndex = currentIndex - 1
      return prevIndex >= 0 ? queue[prevIndex] : null
    }
  }
}
