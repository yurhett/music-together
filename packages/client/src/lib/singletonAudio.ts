/**
 * 唯一的全局 HTMLAudioElement 单例
 * 针对 iOS Safari 在后台播放的限制：
 * iOS 禁止在非用户交互(或者非直接连接在 onend 后)的情况下创建并播放新的 Audio。
 * 因此我们必须在全局保留一个统一的 <audio> 节点，通过修改其 src 来切换歌曲，
 * 并确保在首次用户交互时（unlockAudio）赋予其播放权限。
 */
export const globalHtmlAudio = typeof window !== 'undefined' ? new Audio() : null
if (globalHtmlAudio) {
  globalHtmlAudio.crossOrigin = 'anonymous'
  // Prevent iOS locking when swapping sources
  globalHtmlAudio.autoplay = false
}
