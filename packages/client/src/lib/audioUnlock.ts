import { Howler } from 'howler'

let unlocked = false

// The global, singleton HTML5 audio element
export const globalAudio = new Audio()
globalAudio.crossOrigin = 'anonymous'

export function isAudioUnlocked(): boolean {
  return unlocked
}

/**
 * Call within a real user interaction (click / keydown).
 * Unlocks the global Audio element so all subsequent
 * playback works without further interaction on platforms like iOS Safari.
 */
export async function unlockAudio(): Promise<void> {
  if (unlocked) return

  // 1. Resume Howler's global AudioContext (if it's still being used somewhere)
  const ctx = Howler.ctx
  if (ctx && ctx.state === 'suspended') {
    await ctx.resume()
  }

  // 2. Play a silent WAV to force-activate the global HTML5 audio element
  globalAudio.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA='
  globalAudio.volume = 0
  
  try {
    await globalAudio.play()
  } catch (e) {
    console.warn('Audio unlock failed:', e)
  }

  unlocked = true
}
