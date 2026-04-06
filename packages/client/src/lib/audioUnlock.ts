import { Howler } from 'howler'

let unlocked = false

// The global, singleton HTML5 audio element
export const globalAudio = new Audio()
globalAudio.preload = 'auto'

// 1-second silent WAV base64 instead of 0-sample to prevent browser from instantly rejecting or finishing it
export const SILENT_WAV_BASE64 = (() => {
  const sampleRate = 8000;
  const numSamples = sampleRate * 1; // 1 second
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);
  
  const writeString = (offset: number, string: string) => {
    for (let i = 0; i < string.length; i++) view.setUint8(offset + i, string.charCodeAt(i));
  };
  
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, numSamples * 2, true);
  
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return 'data:audio/wav;base64,' + btoa(binary);
})();

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
  globalAudio.src = SILENT_WAV_BASE64
  globalAudio.volume = 0
  
  try {
    await globalAudio.play()
  } catch (e) {
    console.warn('Audio unlock failed:', e)
  }

  unlocked = true
}
