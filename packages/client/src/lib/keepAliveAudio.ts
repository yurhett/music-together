/**
 * iOS Safari 后台保活音频模块
 *
 * 当主播放元素 (globalHtmlAudio) 在切歌间隙停止发声时，
 * 用第二个 HTMLAudioElement 循环播放极安静的音频片段，
 * 防止 WebKit 因"无声"而挂起网页（Suspend），确保
 * WebSocket 和 setTimeout 等保持运转。
 *
 * 使用方法：
 *   - 在 audioUnlock 中调用 unlockKeepAlive()
 *   - 切歌无法同步启动时调用 startKeepAlive()
 *   - 主播放元素成功播放新曲后调用 stopKeepAlive()
 */

// 0.5 秒 8kHz 16-bit mono WAV，内容为极低振幅 (~-60dB) 的交替采样
// 这比完全静音更可靠——WebKit 某些版本会跳过零振幅音频的保活
function generateKeepAliveWav(): string {
  // WAV 文件头参数
  const sampleRate = 8000
  const bitsPerSample = 16
  const numChannels = 1
  const numSamples = sampleRate / 2 // 0.5 秒
  const dataSize = numSamples * numChannels * (bitsPerSample / 8)
  const fileSize = 44 + dataSize // 44 字节头 + 数据

  const buffer = new ArrayBuffer(fileSize)
  const view = new DataView(buffer)

  // RIFF 头
  writeString(view, 0, 'RIFF')
  view.setUint32(4, fileSize - 8, true)
  writeString(view, 8, 'WAVE')

  // fmt 子块
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // PCM 格式子块大小
  view.setUint16(20, 1, true) // PCM 格式
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * numChannels * (bitsPerSample / 8), true)
  view.setUint16(32, numChannels * (bitsPerSample / 8), true)
  view.setUint16(34, bitsPerSample, true)

  // data 子块
  writeString(view, 36, 'data')
  view.setUint32(40, dataSize, true)

  // 写入极低振幅的交替采样（约 -60dB）
  for (let i = 0; i < numSamples; i++) {
    // 交替 +8 / -8（满刻度 32767 的约 0.024%）
    const sample = i % 2 === 0 ? 8 : -8
    view.setInt16(44 + i * 2, sample, true)
  }

  // 转为 base64 data URI
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return 'data:audio/wav;base64,' + btoa(binary)
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i))
  }
}

// ---------- 单例 ----------

let keepAliveEl: HTMLAudioElement | null = null
let keepAliveDataUri: string | null = null
let isAlive = false

function getOrCreateElement(): HTMLAudioElement | null {
  if (typeof window === 'undefined') return null
  if (keepAliveEl) return keepAliveEl

  keepAliveEl = new Audio()
  keepAliveEl.volume = 0.01 // 极低音量，人耳几乎听不到
  keepAliveEl.loop = true
  // 获取或生成音频数据
  if (!keepAliveDataUri) {
    keepAliveDataUri = generateKeepAliveWav()
  }
  keepAliveEl.src = keepAliveDataUri

  return keepAliveEl
}

/**
 * 在用户交互时调用以"解锁"保活音频元素的播放权限。
 * 必须在 click/touchstart 等事件的同步调用栈中执行。
 */
export function unlockKeepAlive(): void {
  const el = getOrCreateElement()
  if (!el) return
  // 播放后立即暂停——仅为获取播放权限
  const p = el.play()
  if (p !== undefined) {
    p.then(() => el.pause()).catch(() => {})
  }
}

/**
 * 启动保活循环播放。
 * 在切歌间隙、onended 无法同步接续时调用。
 */
export function startKeepAlive(): void {
  const el = getOrCreateElement()
  if (!el || isAlive) return
  isAlive = true
  el.currentTime = 0
  el.play().catch((e) => {
    console.warn('[KeepAlive] play failed:', e)
    isAlive = false
  })
  console.log('[KeepAlive] Started')
}

/**
 * 停止保活。主音频元素开始播放新曲后调用。
 */
export function stopKeepAlive(): void {
  if (!isAlive || !keepAliveEl) return
  keepAliveEl.pause()
  isAlive = false
  console.log('[KeepAlive] Stopped')
}

/**
 * 是否正在保活中
 */
export function isKeepAliveActive(): boolean {
  return isAlive
}
