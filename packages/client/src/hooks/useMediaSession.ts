import { useEffect } from 'react'
import { usePlayerStore } from '@/stores/playerStore'

interface UseMediaSessionCallbacks {
  onNext: () => void
  onPrev: () => void
  onPlay: () => void
  onPause: () => void
  onSeek: (time: number) => void
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

    const boundActions: MediaSessionAction[] = []
    const bindAction = (action: MediaSessionAction, handler: MediaSessionActionHandler | null): boolean => {
      try {
        navigator.mediaSession.setActionHandler(action, handler)
        boundActions.push(action)
        return true
      } catch (error) {
        console.warn(`[Media Session] 暂不支持 ${action} 操作`)
        return false
      }
    }

    // 优先展示上一首/下一首：部分系统媒体面板在 seekbackward/seekforward 与
    // previoustrack/nexttrack 同时注册时，会优先显示快退/快进并隐藏切歌按钮。
    const hasPrev = bindAction('previoustrack', () => onPrev())
    const hasNext = bindAction('nexttrack', () => onNext())

    bindAction('play', () => onPlay())
    bindAction('pause', () => onPause())
    bindAction('seekto', (details: MediaSessionActionDetails) => {
      if (details.seekTime != null) {
        onSeek(details.seekTime)
      }
    })

    // 仅在系统不支持完整上一首/下一首时，才回退到快退/快进。
    if (!(hasPrev && hasNext)) {
      bindAction('seekbackward', (details: MediaSessionActionDetails) => {
        const current = usePlayerStore.getState().currentTime
        onSeek(Math.max(0, current - (details.seekOffset ?? 10)))
      })
      bindAction('seekforward', (details: MediaSessionActionDetails) => {
        const { currentTime, duration } = usePlayerStore.getState()
        onSeek(Math.min(duration, currentTime + (details.seekOffset ?? 10)))
      })
    } else {
      // 显式清空，避免某些浏览器保留上一次会话的 seek 按钮。
      bindAction('seekbackward', null)
      bindAction('seekforward', null)
    }

    return () => {
      // 组件卸载时清理处理器，避免指向旧回调
      if (!('mediaSession' in navigator)) return
      for (const action of boundActions) {
        try {
          navigator.mediaSession.setActionHandler(action, null)
        } catch {
          // ignore
        }
      }
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

    const toArtwork = (cover?: string): MediaImage[] =>
      cover
        ? [
            { src: cover, sizes: '96x96', type: 'image/jpeg' },
            { src: cover, sizes: '128x128', type: 'image/jpeg' },
            { src: cover, sizes: '256x256', type: 'image/jpeg' },
            { src: cover, sizes: '512x512', type: 'image/jpeg' },
          ]
        : []

    const cloneArtwork = (artwork: readonly MediaImage[] | null | undefined): MediaImage[] =>
      artwork ? Array.from(artwork, (item) => ({ src: item.src, sizes: item.sizes, type: item.type })) : []

    const syncMetadata = (state: ReturnType<typeof usePlayerStore.getState>) => {
      const track = state.currentTrack

      if (state.mediaSessionLoading) {
        const previous = navigator.mediaSession.metadata
        navigator.mediaSession.metadata = new MediaMetadata({
          title: '⏳ 加载中...',
          artist: previous?.artist ?? track?.artist.join(' / ') ?? '',
          album: previous?.album ?? track?.album ?? '',
          artwork: previous?.artwork?.length ? cloneArtwork(previous.artwork) : toArtwork(track?.cover),
        })
        return
      }

      if (!track) {
        navigator.mediaSession.metadata = null
        return
      }

      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist.join(' / '),
        album: track.album ?? '',
        artwork: toArtwork(track.cover),
      })
    }

    const unsub = usePlayerStore.subscribe((state, prev) => {
      if (state.currentTrack === prev.currentTrack && state.mediaSessionLoading === prev.mediaSessionLoading) return
      syncMetadata(state)
    })

    // 立即同步当前曲目/加载状态
    syncMetadata(usePlayerStore.getState())

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
