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
    audioEl.load()
    audioEl.volume = 0
    audioEl.currentTime = 0
    
    // Play synchronously, then pause immediately to keep the audio element "active" 
    // but paused, which prevents iOS from releasing the background audio token.
    const p = audioEl.play()
    if (p !== undefined) {
      p.then(() => {
        audioEl.pause()
        audioEl.currentTime = 0
      }).catch(() => {})
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
