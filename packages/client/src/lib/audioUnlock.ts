import { Howl, Howler } from 'howler'
import { globalHtmlAudio } from './singletonAudio'

let unlocked = false

export function isAudioUnlocked(): boolean {
  return unlocked
}

/**
 * Call within a real user interaction (click / keydown).
 * Unlocks the Howler global AudioContext so all subsequent
 * playback works without further interaction.
 */
export async function unlockAudio(): Promise<void> {
  if (unlocked) return

  // 1. Resume Howler's global AudioContext
  const ctx = Howler.ctx
  if (ctx && ctx.state === 'suspended') {
    await ctx.resume()
  }

  // 2. Unlock the global native HTMLAudioElement for iOS Background playback
  if (globalHtmlAudio) {
    const audioEl = globalHtmlAudio
    audioEl.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA='
    audioEl.volume = 0
    
    // Play synchronously, and let it finish playing naturally (do not call pause()).
    // This establishes the user gesture context for the audio token on iOS PWA.
    const p = audioEl.play()
    if (p !== undefined) {
      p.catch(() => {})
    }
  }

  // 3. Play a silent WAV to force-activate Howler WebAudio
  const silentHowl = new Howl({
    src: ['data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA='],
    volume: 0,
    html5: false, // Explicitly WebAudio unlock
  })
  silentHowl.play()
  silentHowl.once('end', () => silentHowl.unload())

  unlocked = true
}
