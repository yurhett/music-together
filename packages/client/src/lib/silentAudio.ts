/**
 * 一段极短且无声的 MP3 Base64 数据。
 * 用于在 iOS Safari (WebKit) 中，保持网页后台 Audio Playing Exemption 的状态锁。
 * 在网页转入后台或屏幕熄灭时，如果音频结束（触发 onend），WebKit 会剥夺 JavaScript 和网络权限。
 * 在等待下一首音频由于网络延迟解析并加载的期间，循环播放此静音音频防止冻结。
 */
export const SILENT_AUDIO_BASE64 =
  'data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU5LjI3LjEwMAAAAAAAAAAAAAAA//twwAACqAAAIMAAADEwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAxCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQn/+3DAAAJSAAAAwwAAAMTAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk'

let _silentBlobUrl: string | null = null

export function getSilentBlobUrl(): string {
  if (!_silentBlobUrl && typeof window !== 'undefined') {
    try {
      const parts = SILENT_AUDIO_BASE64.split(';base64,')
      const contentType = parts[0].split(':')[1] || 'audio/mpeg'
      const raw = window.atob(parts[1])
      const rawLength = raw.length
      const uInt8Array = new Uint8Array(rawLength)
      for (let i = 0; i < rawLength; ++i) {
        uInt8Array[i] = raw.charCodeAt(i)
      }
      const blob = new Blob([uInt8Array], { type: contentType })
      _silentBlobUrl = URL.createObjectURL(blob)
    } catch (e) {
      _silentBlobUrl = SILENT_AUDIO_BASE64 // 解析失败则回退基础 base64
    }
  }
  return _silentBlobUrl || SILENT_AUDIO_BASE64
}
