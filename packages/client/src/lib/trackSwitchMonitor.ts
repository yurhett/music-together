/**
 * 轻量级切歌状态监控器（模块级单例，非 React 状态）
 *
 * useHowl 在 loadTrack 开始时调用 setSwitching(true)
 * 在 onplaying / onerror / onended 时调用 setSwitching(false)
 *
 * useMediaSession 在决定是否更新 playbackState 时读取此标志，
 * 避免 src 切换中间态的短暂 pause 事件把控制中心"误关闭"。
 */
let _switching = false

export const trackSwitchMonitor = {
  setSwitching: () => {
    _switching = true
  },
  clearSwitching: () => {
    _switching = false
  },
  isSwitching: () => _switching,
}
