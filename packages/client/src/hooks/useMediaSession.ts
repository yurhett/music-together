import { useEffect } from 'react'
import { usePlayerStore } from '@/stores/playerStore'

interface UseMediaSessionCallbacks {
  onNext: (() => void) | null
  onPrev: (() => void) | null
  onPlay: (() => void) | null
  onPause: (() => void) | null
  onSeek: ((time: number) => void) | null
}

/**
 * 接入 Media Session API，为 iOS Safari 锁屏控制中心提供：
 *   - 封面、歌名、歌手元数据展示
 *   - 下一首 / 上一首 / 播放 / 暂停 / 进度跳转 操作处理
 *   - 实时播放状态与进度条同步
 *
 * iOS 16.4+ Safari 正式支持 Media Session API。
 * 注册后，系统通过原生回调驱动切歌，完全不受后台 setTimeout/rAF 节流影响。
 */
export function useMediaSession({
  onNext,
  onPrev,
  onPlay,
  onPause,
  onSeek,
}: UseMediaSessionCallbacks): void {
  // ----- 注册操作处理器（仅一次，回调通过 ref-stable 的 store 访问）-----
  useEffect(() => {
    if (!('mediaSession' in navigator)) return

    // 各操作直接调用外部传入的回调（已通过 useCallback 稳定引用）
    navigator.mediaSession.setActionHandler('nexttrack', onNext || null)
    navigator.mediaSession.setActionHandler('previoustrack', onPrev || null)
    navigator.mediaSession.setActionHandler('play', onPlay || null)
    navigator.mediaSession.setActionHandler('pause', onPause || null)
    navigator.mediaSession.setActionHandler(
      'seekto',
      onSeek
        ? (details: MediaSessionActionDetails) => {
            if (details.seekTime != null) onSeek(details.seekTime)
          }
        : null
    )
    // seekbackward / seekforward 用于支持带快退快进键的耳机
    navigator.mediaSession.setActionHandler(
      'seekbackward',
      onSeek
        ? (details) => {
            const current = usePlayerStore.getState().currentTime
            onSeek(Math.max(0, current - (details.seekOffset ?? 10)))
          }
        : null
    )
    navigator.mediaSession.setActionHandler(
      'seekforward',
      onSeek
        ? (details) => {
            const { currentTime, duration } = usePlayerStore.getState()
            onSeek(Math.min(duration, currentTime + (details.seekOffset ?? 10)))
          }
        : null
    )

    return () => {
      // 组件卸载时清理处理器，避免指向旧回调
      if (!('mediaSession' in navigator)) return
      navigator.mediaSession.setActionHandler('nexttrack', null)
      navigator.mediaSession.setActionHandler('previoustrack', null)
      navigator.mediaSession.setActionHandler('play', null)
      navigator.mediaSession.setActionHandler('pause', null)
      navigator.mediaSession.setActionHandler('seekto', null)
      navigator.mediaSession.setActionHandler('seekbackward', null)
      navigator.mediaSession.setActionHandler('seekforward', null)
    }
    // 回调引用稳定（useCallback 保障），effect 只在 mount/unmount 时执行
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onNext, onPrev, onPlay, onPause, onSeek])

  // ----- 同步 isPlaying → playbackState -----
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    const unsub = usePlayerStore.subscribe((state) => {
      navigator.mediaSession.playbackState = state.isPlaying ? 'playing' : 'paused'
    })
    // 立即同步一次当前状态
    const { isPlaying } = usePlayerStore.getState()
    navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused'
    return unsub
  }, [])

  // ----- 同步 currentTrack → MediaMetadata（封面、标题、歌手）-----
  useEffect(() => {
    if (!('mediaSession' in navigator) || !('MediaMetadata' in window)) return
    const unsub = usePlayerStore.subscribe((state, prev) => {
      if (state.currentTrack === prev.currentTrack) return
      const track = state.currentTrack
      if (!track) {
        navigator.mediaSession.metadata = null
        return
      }
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist.join(' / '),
        album: track.album ?? '',
        artwork: track.cover
          ? [
              { src: track.cover, sizes: '96x96', type: 'image/jpeg' },
              { src: track.cover, sizes: '128x128', type: 'image/jpeg' },
              { src: track.cover, sizes: '256x256', type: 'image/jpeg' },
              { src: track.cover, sizes: '512x512', type: 'image/jpeg' },
            ]
          : [],
      })
    })
    // 立即同步当前曲目
    const track = usePlayerStore.getState().currentTrack
    if (track) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist.join(' / '),
        album: track.album ?? '',
        artwork: track.cover
          ? [
              { src: track.cover, sizes: '96x96', type: 'image/jpeg' },
              { src: track.cover, sizes: '128x128', type: 'image/jpeg' },
              { src: track.cover, sizes: '256x256', type: 'image/jpeg' },
              { src: track.cover, sizes: '512x512', type: 'image/jpeg' },
            ]
          : [],
      })
    }
    return unsub
  }, [])

  // ----- 同步 currentTime / duration → setPositionState（锁屏进度条）-----
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    const unsub = usePlayerStore.subscribe((state, prev) => {
      // 避免过频繁调用（duration 或 currentTime 发生变化才更新）
      if (state.currentTime === prev.currentTime && state.duration === prev.duration) return

      const { duration, currentTime, isPlaying } = state
      if (!duration || duration <= 0) return
      try {
        navigator.mediaSession.setPositionState({
          duration,
          // 后台暂停时 playbackRate 为 0，避免锁屏进度条自动滚动
          playbackRate: isPlaying ? 1 : 0,
          position: Math.min(currentTime, duration),
        })
      } catch {
        // 部分旧版本 Safari 不支持 setPositionState，静默忽略
      }
    })
    return unsub
  }, [])
}
