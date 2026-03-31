import { Howl, Howler } from 'howler'

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

  // 2. Play a silent WAV to force-activate (iOS Safari compat)
  playSilentAudio()

  unlocked = true
}

export function playSilentAudio(): void {
  const silentHowl = new Howl({
    src: ['data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA='],
    volume: 0,
    html5: true,
  })
  silentHowl.play()
  silentHowl.once('end', () => silentHowl.unload())
}

let silentLoopHolder: Howl | null = null

/**
 * Starts playing a silent, looping audio track.
 * Keeps the iOS audio session alive in the background while waiting
 * for network requests (e.g. changing tracks) to complete.
 */
export function holdAudioSession(): void {
  if (!silentLoopHolder) {
    silentLoopHolder = new Howl({
      src: ['data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA='],
      volume: 0,
      loop: true,
      html5: true,
    })
  }
  if (!silentLoopHolder.playing()) {
    silentLoopHolder.play()
  }
}

/**
 * Stops the silent looping audio track once real playback has started.
 */
export function releaseAudioSession(): void {
  if (silentLoopHolder && silentLoopHolder.playing()) {
    silentLoopHolder.pause()
  }
}

