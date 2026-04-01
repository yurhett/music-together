import { Howl, Howler } from 'howler'
import { globalHtmlAudio } from './singletonAudio'
import { unlockKeepAlive } from './keepAliveAudio'

let unlocked = false

export function isAudioUnlocked(): boolean {
  return unlocked
}

/**
 * 在真实用户交互（click / keydown）中调用。
 * 解锁 Howler AudioContext、全局 HTMLAudioElement、
 * 以及 iOS 后台保活用的第二音频元素。
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
    
    // Play synchronously, then pause immediately to keep the audio element "active" 
    // but paused, which prevents iOS from releasing the background audio token.
    const p = audioEl.play()
    if (p !== undefined) {
      p.then(() => {
        audioEl.pause()
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

  // 4. 解锁 iOS 后台保活用的第二音频元素
  unlockKeepAlive()

  unlocked = true
}
