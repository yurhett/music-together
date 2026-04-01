import { useEffect, useRef } from 'react'
import { usePlayerStore } from '@/stores/playerStore'
import { useSocketContext } from '@/providers/SocketProvider'
import { EVENTS } from '@music-together/shared'
import { trackSwitchMonitor } from '@/lib/trackSwitchMonitor'

interface UseMediaSessionOptions {
  /**
   * 按下「下一首」时调用。
   * 应在同步调用栈内完成 audioEl.play()（保住 iOS 后台手势上下文），
   * 然后再 emit PLAYER_NEXT 通知服务器。
   */
  onNext?: () => void
  /** 按下「上一首」时调用，同上。 */
  onPrev?: () => void
}

export function useMediaSession(options?: UseMediaSessionOptions) {
  const { socket } = useSocketContext()

  // 用 ref 保住最新 socket/回调，handler 注册后无需重新注册
  const socketRef = useRef(socket)
  useEffect(() => { socketRef.current = socket }, [socket])

  const onNextRef = useRef(options?.onNext)
  const onPrevRef = useRef(options?.onPrev)
  useEffect(() => {
    onNextRef.current = options?.onNext
    onPrevRef.current = options?.onPrev
  })

  // ─── 一次性注册 action handlers ─────────────────────────────────────────
  // 空依赖数组：整个生命周期只注册一次，切歌时不触发 cleanup/重注册，
  // 避免间隙期导致 iOS 判定媒体会话结束。
  useEffect(() => {
    if (!('mediaSession' in navigator)) return

    navigator.mediaSession.setActionHandler('play', () =>
      socketRef.current.emit(EVENTS.PLAYER_RESUME),
    )
    navigator.mediaSession.setActionHandler('pause', () =>
      socketRef.current.emit(EVENTS.PLAYER_PAUSE),
    )
    navigator.mediaSession.setActionHandler('nexttrack', () => {
      if (onNextRef.current) {
        // 乐观加载：在手势上下文内同步调用 audioEl.play()，
        // 保住 iOS 后台播放权限；回调内部再 emit PLAYER_NEXT。
        onNextRef.current()
      } else {
        socketRef.current.emit(EVENTS.PLAYER_NEXT)
      }
    })
    navigator.mediaSession.setActionHandler('previoustrack', () => {
      if (onPrevRef.current) {
        onPrevRef.current()
      } else {
        socketRef.current.emit(EVENTS.PLAYER_PREV)
      }
    })

    return () => {
      if (!('mediaSession' in navigator)) return
      navigator.mediaSession.setActionHandler('play', null)
      navigator.mediaSession.setActionHandler('pause', null)
      navigator.mediaSession.setActionHandler('nexttrack', null)
      navigator.mediaSession.setActionHandler('previoustrack', null)
      navigator.mediaSession.metadata = null
    }
  }, [])

  // ─── 订阅 playerStore，同步 metadata / playbackState / positionState ──
  useEffect(() => {
    if (!('mediaSession' in navigator)) return

    const updateMetadata = (track: ReturnType<typeof usePlayerStore.getState>['currentTrack']) => {
      if (!track) return
      const artistList = Array.isArray(track.artist) ? track.artist.join(', ') : track.artist
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: artistList || 'Unknown Artist',
        album: track.album || '',
        artwork: track.cover ? [{ src: track.cover, sizes: '512x512', type: 'image/jpeg' }] : [],
      })
    }

    // 初始同步
    const init = usePlayerStore.getState()
    updateMetadata(init.currentTrack)
    navigator.mediaSession.playbackState = init.isPlaying ? 'playing' : 'paused'

    const unsubscribe = usePlayerStore.subscribe((state, prevState) => {
      if (!('mediaSession' in navigator)) return

      // currentTrack 变化 → 立即更新 metadata，并保持 playbackState='playing'
      // （src 切换会短暂触发 pause 事件，不能在这里翻转为 paused）
      if (state.currentTrack !== prevState.currentTrack) {
        updateMetadata(state.currentTrack)
        // 切歌过渡期：始终保持 playing，防止控制中心消失
        navigator.mediaSession.playbackState = 'playing'
      }

      // isPlaying 变化 → 只在非切换过渡期内才更新 playbackState
      // 切换期间 src 变化会触发 onpause → isPlaying=false（误报），需忽略
      if (state.isPlaying !== prevState.isPlaying) {
        if (state.isPlaying === false && trackSwitchMonitor.isSwitching()) {
          // 切换中的瞬态 pause，保持 playing，不理会
          navigator.mediaSession.playbackState = 'playing'
        } else {
          navigator.mediaSession.playbackState = state.isPlaying ? 'playing' : 'paused'
        }
      }

      // 进度/时长变化 → 同步 positionState（节流由上层约 250ms 控制）
      if (state.currentTime !== prevState.currentTime || state.duration !== prevState.duration) {
        if (state.duration > 0) {
          try {
            navigator.mediaSession.setPositionState({
              duration: state.duration,
              playbackRate: 1,
              position: Math.min(state.currentTime, state.duration),
            })
          } catch {
            // 部分浏览器不支持，静默忽略
          }
        }
      }
    })

    return unsubscribe
  }, [])
}
