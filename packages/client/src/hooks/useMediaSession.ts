import { useEffect, useRef } from 'react'
import { usePlayerStore } from '@/stores/playerStore'
import { useSocketContext } from '@/providers/SocketProvider'
import { EVENTS } from '@music-together/shared'

export function useMediaSession() {
  const { socket } = useSocketContext()

  // 使用 ref 持有最新 socket，避免 handlers 注册后形成闭包陷阱
  // （如果 socket 重连，handler 内仍能拿到最新引用）
  const socketRef = useRef(socket)
  useEffect(() => {
    socketRef.current = socket
  }, [socket])

  // ─── 一次性注册 action handlers ─────────────────────────────────────────
  // 依赖数组为空，整个 hook 生命周期内只注册一次。
  // 这样切歌时不会因为 currentTrack 变化触发 cleanup → 重新注册的间隙，
  // 导致系统认为 MediaSession 已结束，从而关闭控制中心媒体卡片。
  useEffect(() => {
    if (!('mediaSession' in navigator)) return

    navigator.mediaSession.setActionHandler('play', () =>
      socketRef.current.emit(EVENTS.PLAYER_RESUME),
    )
    navigator.mediaSession.setActionHandler('pause', () =>
      socketRef.current.emit(EVENTS.PLAYER_PAUSE),
    )
    navigator.mediaSession.setActionHandler('nexttrack', () =>
      socketRef.current.emit(EVENTS.PLAYER_NEXT),
    )
    navigator.mediaSession.setActionHandler('previoustrack', () =>
      socketRef.current.emit(EVENTS.PLAYER_PREV),
    )

    // 只在组件卸载时清理，不在 currentTrack 变化时清理
    return () => {
      if (!('mediaSession' in navigator)) return
      navigator.mediaSession.setActionHandler('play', null)
      navigator.mediaSession.setActionHandler('pause', null)
      navigator.mediaSession.setActionHandler('nexttrack', null)
      navigator.mediaSession.setActionHandler('previoustrack', null)
      navigator.mediaSession.metadata = null
    }
  }, []) // ← 空依赖，生命周期内只执行一次

  // ─── 订阅 playerStore，同步 metadata / playbackState / positionState ──
  // 将三类更新合并到一个 subscribe 回调中，减少重复订阅开销。
  useEffect(() => {
    if (!('mediaSession' in navigator)) return

    // 初始化：立即同步当前状态（避免首次渲染时 metadata 为空）
    const syncAll = (state: ReturnType<typeof usePlayerStore.getState>) => {
      const { currentTrack, isPlaying, currentTime, duration } = state

      // 同步专辑/曲目信息
      if (currentTrack) {
        const artistList = Array.isArray(currentTrack.artist)
          ? currentTrack.artist.join(', ')
          : currentTrack.artist

        navigator.mediaSession.metadata = new MediaMetadata({
          title: currentTrack.title,
          artist: artistList || 'Unknown Artist',
          album: currentTrack.album || '',
          artwork: currentTrack.cover
            ? [{ src: currentTrack.cover, sizes: '512x512', type: 'image/jpeg' }]
            : [],
        })
      }

      // 同步播放状态（关键：系统控制中心显示/隐藏媒体卡片的依据）
      navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused'

      // 同步进度条（让系统控制中心的进度条正确显示）
      if (duration > 0) {
        try {
          navigator.mediaSession.setPositionState({
            duration,
            playbackRate: 1,
            position: Math.min(currentTime, duration),
          })
        } catch {
          // 部分浏览器（如旧版 Firefox Android）尚未实现此 API，静默忽略
        }
      }
    }

    // 立即执行一次初始同步
    syncAll(usePlayerStore.getState())

    // 订阅后续变化
    const unsubscribe = usePlayerStore.subscribe((state, prevState) => {
      if (!('mediaSession' in navigator)) return

      // currentTrack 变化 → 更新 metadata（不清空，直接覆盖）
      if (state.currentTrack !== prevState.currentTrack && state.currentTrack) {
        const artistList = Array.isArray(state.currentTrack.artist)
          ? state.currentTrack.artist.join(', ')
          : state.currentTrack.artist

        navigator.mediaSession.metadata = new MediaMetadata({
          title: state.currentTrack.title,
          artist: artistList || 'Unknown Artist',
          album: state.currentTrack.album || '',
          artwork: state.currentTrack.cover
            ? [{ src: state.currentTrack.cover, sizes: '512x512', type: 'image/jpeg' }]
            : [],
        })
      }

      // isPlaying 变化 → 同步 playbackState
      if (state.isPlaying !== prevState.isPlaying) {
        navigator.mediaSession.playbackState = state.isPlaying ? 'playing' : 'paused'
      }

      // 进度或时长变化 → 同步 positionState（节流由上层 setCurrentTime 约 250ms 控制）
      if (
        state.currentTime !== prevState.currentTime ||
        state.duration !== prevState.duration
      ) {
        if (state.duration > 0) {
          try {
            navigator.mediaSession.setPositionState({
              duration: state.duration,
              playbackRate: 1,
              position: Math.min(state.currentTime, state.duration),
            })
          } catch {
            // 静默忽略不支持的浏览器
          }
        }
      }
    })

    return unsubscribe
  }, [])
}
