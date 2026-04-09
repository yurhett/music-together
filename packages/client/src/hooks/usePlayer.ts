import { getServerTime, isCalibrated } from '@/lib/clockSync'
import { PLAYER_PLAY_DEDUP_MS } from '@/lib/constants'
import { storage } from '@/lib/storage'
import { useSocketContext } from '@/providers/SocketProvider'
import { usePlayerStore } from '@/stores/playerStore'
import { useRoomStore } from '@/stores/roomStore'
import type { ScheduledPlayState, Track } from '@music-together/shared'
import { ERROR_CODE, EVENTS } from '@music-together/shared'
import { useCallback, useEffect, useRef } from 'react'
import { useHowl } from './useHowl'
import { useLyric } from './useLyric'
import { useMediaSession } from './useMediaSession'
import { usePlayerSync } from './usePlayerSync'

/**
 * Composing hook: useHowl + useLyric + usePlayerSync.
 * Provides unified playback controls.
 *
 * Architecture: **Scheduled Execution**.
 * All player actions (play, pause, seek, resume) are emitted to the server
 * which broadcasts a `ScheduledPlayState` to ALL clients (including the
 * initiator). Clients then execute the action at the scheduled server-time
 * so that every device acts in unison.
 */
export function usePlayer() {
  const { socket } = useSocketContext()
  const loadingRef = useRef<{ trackId: string; ts: number; serverTimestamp: number } | null>(null)
  type RefreshStreamResult = { recovered: boolean; failureNotified?: boolean }

  const refreshInFlightRef = useRef<Promise<RefreshStreamResult> | null>(null)
  const RECOVERY_GRACE_MS = 3000
  const RECOVERY_DELAY_MS = 700
  const STREAM_REFRESH_TIMEOUT_MS = 4000

  const next = useCallback(() => socket.emit(EVENTS.PLAYER_NEXT), [socket])

  // Auto-next on song end: only the current conductor (hostId) emits PLAYER_NEXT.
  // The conductor is auto-elected by the server (owner > admin > member).
  // Other clients silently wait to prevent duplicate PLAYER_NEXT events.
  const autoNext = useCallback(() => {
    const { room } = useRoomStore.getState()
    const myId = storage.getUserId()
    if (room?.roomMode === 'radio') {
      return
    }
    if (room?.hostId === myId) {
      socket.emit(EVENTS.PLAYER_NEXT)
    }
  }, [socket])

  const refreshCurrentTrackStreamUrl = useCallback(
    async (currentTime: number) => {
      const room = useRoomStore.getState().room
      const track = room?.currentTrack
      if (!track) return { recovered: false }

      if (refreshInFlightRef.current) {
        return refreshInFlightRef.current
      }

      const refreshPromise = new Promise<RefreshStreamResult>((resolve) => {
        let settled = false
        let failureNotified = false
        const requestAt = Date.now()

        const done = (result: RefreshStreamResult) => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          socket.off(EVENTS.PLAYER_PLAY, onPlayerPlay)
          socket.off(EVENTS.ROOM_ERROR, onRoomError)
          resolve(result)
        }

        const onPlayerPlay = (data: { track: Track; playState: ScheduledPlayState }) => {
          // Only treat responses newer than this request as refresh success.
          if (data.playState.serverTimestamp < requestAt - 50) return
          if (data.track.id !== track.id || !data.track.streamUrl) return
          done({ recovered: true })
        }

        const onRoomError = (error: { code: string }) => {
          if (
            error.code !== ERROR_CODE.STREAM_FAILED &&
            error.code !== ERROR_CODE.NO_PERMISSION &&
            error.code !== ERROR_CODE.NOT_IN_ROOM &&
            error.code !== ERROR_CODE.ROOM_NOT_FOUND
          ) {
            return
          }
          failureNotified = true
          done({ recovered: false, failureNotified: true })
        }

        const timeout = setTimeout(() => {
          done({ recovered: false, failureNotified })
        }, STREAM_REFRESH_TIMEOUT_MS)

        socket.on(EVENTS.PLAYER_PLAY, onPlayerPlay)
        socket.on(EVENTS.ROOM_ERROR, onRoomError)
        socket.emit(EVENTS.PLAYER_REFRESH_STREAM_URL, {
          currentTime: Math.max(0, currentTime),
          reason: 'audio-error',
        })
      })

      refreshInFlightRef.current = refreshPromise.finally(() => {
        refreshInFlightRef.current = null
      })

      return refreshInFlightRef.current
    },
    [socket],
  )

  const { howlRef, soundIdRef, loadTrack } = useHowl(autoNext, async (ctx) => {
    return refreshCurrentTrackStreamUrl(ctx.currentTime)
  })
  const { fetchLyric } = useLyric()

  // Connect sync (handles SEEK, PAUSE, RESUME + conductor reporting)
  usePlayerSync(howlRef, soundIdRef)

  // Reset dedup ref on disconnect so reconnect PLAYER_PLAY is never blocked
  useEffect(() => {
    const onDisconnect = () => {
      loadingRef.current = null
    }
    socket.on('disconnect', onDisconnect)
    return () => {
      socket.off('disconnect', onDisconnect)
    }
  }, [socket])

  // Listen for PLAYER_PLAY events (new track load)
  const playTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const recoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const onPlayerPlay = (data: { track: Track; playState: ScheduledPlayState }) => {
      console.log('[Audio Debug] 📡 socket onPlayerPlay received. Track:', data.track.title)
      // Deduplicate: ignore if the same track with the same serverTimestamp
      // was requested within the dedup window.  Comparing serverTimestamp
      // ensures that a legitimate replay of the same track (e.g. loop mode)
      // with a different serverTimestamp is not discarded.
      const now = Date.now()
      if (
        loadingRef.current?.trackId === data.track.id &&
        loadingRef.current.serverTimestamp === data.playState.serverTimestamp &&
        now - loadingRef.current.ts < PLAYER_PLAY_DEDUP_MS
      ) {
        return
      }
      loadingRef.current = { trackId: data.track.id, ts: now, serverTimestamp: data.playState.serverTimestamp }

      if (recoveryTimerRef.current) {
        clearTimeout(recoveryTimerRef.current)
        recoveryTimerRef.current = null
      }

      // Keep roomStore in sync so recovery effect sees the correct currentTrack
      useRoomStore.getState().updateRoom({
        currentTrack: data.track,
        playState: {
          isPlaying: data.playState.isPlaying,
          currentTime: data.playState.currentTime,
          serverTimestamp: data.playState.serverTimestamp,
        },
      })

      const ct = data.playState.currentTime

      if (ct === 0 && data.playState.serverTimeToExecute) {
        // New track from position 0: schedule load so playback begins at
        // the coordinated server-time.  We load with autoPlay=true and let
        // the scheduling delay account for buffering.
        // When NTP is not yet calibrated, execute immediately (delay=0) to
        // avoid wildly inaccurate scheduling from uncorrected local clocks.
        const delay = isCalibrated() ? Math.max(0, data.playState.serverTimeToExecute - getServerTime()) : 0
        if (playTimerRef.current) clearTimeout(playTimerRef.current)
        playTimerRef.current = setTimeout(() => {
          playTimerRef.current = null
          loadTrack(data.track, 0, data.playState.isPlaying)
          fetchLyric(data.track)
        }, delay)
      } else {
        // Mid-song join or currentTime > 0: load immediately and seek to
        // the expected position at the scheduled execution time.
        const elapsed = data.playState.isPlaying
          ? Math.max(0, (getServerTime() - data.playState.serverTimestamp) / 1000)
          : 0
        const adjustedTime = ct + elapsed

        loadTrack(data.track, adjustedTime, data.playState.isPlaying)
        fetchLyric(data.track)
      }
    }

    socket.on(EVENTS.PLAYER_PLAY, onPlayerPlay)

    return () => {
      socket.off(EVENTS.PLAYER_PLAY, onPlayerPlay)
      if (playTimerRef.current) {
        clearTimeout(playTimerRef.current)
        playTimerRef.current = null
      }
      if (recoveryTimerRef.current) {
        clearTimeout(recoveryTimerRef.current)
        recoveryTimerRef.current = null
      }
    }
  }, [socket, loadTrack, fetchLyric])

  // Recovery: auto-sync player state from room state when desync is detected
  // (e.g. after HMR resets stores, or reconnection where PLAYER_PLAY was missed)
  useEffect(() => {
    let hasRecovered = false

    const recover = () => {
      const { room } = useRoomStore.getState()

      // When room becomes null (disconnect), reset flag so next reconnect can recover
      if (!room) {
        hasRecovered = false
        return
      }

      if (hasRecovered) return
      const playerTrack = usePlayerStore.getState().currentTrack
      const roomTrack = room.currentTrack

      // Server has cleared the track (queue empty / cleared) — reset client
      if (!roomTrack && playerTrack) {
        hasRecovered = true
        if (howlRef.current) {
          try {
            howlRef.current.unload()
          } catch {
            /* ignore */
          }
          howlRef.current = null
        }
        soundIdRef.current = undefined
        usePlayerStore.getState().reset()
        return
      }

      // Server has track but client doesn't (HMR reset / missed PLAYER_PLAY)
      if (roomTrack?.streamUrl && (!playerTrack || !howlRef.current)) {
        const now = Date.now()
        const hasRecentPlayerPlay = loadingRef.current !== null && now - loadingRef.current.ts < RECOVERY_GRACE_MS

        // Wait for the normal PLAYER_PLAY flow when it has just arrived.
        // This avoids a double load race: onPlayerPlay (seek=0) + recover (mid-song seek).
        if (hasRecentPlayerPlay || playTimerRef.current) return

        // Delay recovery slightly to give PLAYER_PLAY a chance to arrive first.
        if (recoveryTimerRef.current) return

        recoveryTimerRef.current = setTimeout(() => {
          recoveryTimerRef.current = null
          if (hasRecovered) return

          const latestRoom = useRoomStore.getState().room
          const latestTrack = latestRoom?.currentTrack
          const latestPlayerTrack = usePlayerStore.getState().currentTrack
          if (!latestRoom || !latestTrack?.streamUrl) return

          const now2 = Date.now()
          const hasRecentPlayerPlay2 = loadingRef.current !== null && now2 - loadingRef.current.ts < RECOVERY_GRACE_MS
          if (hasRecentPlayerPlay2 || playTimerRef.current) return

          // Cancel any pending scheduled load from onPlayerPlay to prevent
          // a second loadTrack call when the timer fires after recovery.
          if (playTimerRef.current) {
            clearTimeout(playTimerRef.current)
            playTimerRef.current = null
          }

          if (latestPlayerTrack?.id === latestTrack.id && howlRef.current) {
            hasRecovered = true
            return
          }

          hasRecovered = true
          const ps = latestRoom.playState
          const elapsed = ps.isPlaying ? (getServerTime() - ps.serverTimestamp) / 1000 : 0
          loadTrack(latestTrack, ps.currentTime + Math.max(0, elapsed), ps.isPlaying)
          fetchLyric(latestTrack)
        }, RECOVERY_DELAY_MS)
      }
    }

    // Check immediately (covers HMR where roomStore already has data)
    recover()

    // Subscribe for future changes (covers reconnect where ROOM_STATE arrives later)
    const unsubscribe = useRoomStore.subscribe(recover)
    return () => {
      unsubscribe()
      if (recoveryTimerRef.current) {
        clearTimeout(recoveryTimerRef.current)
        recoveryTimerRef.current = null
      }
    }
    // `socket` intentionally excluded — effect subscribes to roomStore, not socket directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadTrack, fetchLyric, RECOVERY_DELAY_MS, RECOVERY_GRACE_MS])

  // -----------------------------------------------------------------------
  // Controls — emit to server only.  Server broadcasts ScheduledPlayState
  // to ALL clients (including us) via scheduled execution.
  // -----------------------------------------------------------------------
  const play = useCallback(() => {
    socket.emit(EVENTS.PLAYER_PLAY)
  }, [socket])

  const pause = useCallback(() => {
    socket.emit(EVENTS.PLAYER_PAUSE)
  }, [socket])

  const seek = useCallback(
    (time: number) => {
      // Optimistic local update for the progress bar UI
      usePlayerStore.getState().setCurrentTime(time)
      socket.emit(EVENTS.PLAYER_SEEK, { currentTime: time })
    },
    [socket],
  )

  const prev = useCallback(() => socket.emit(EVENTS.PLAYER_PREV), [socket])

  // 接入 Media Session API，为 iOS 锁屏控制中心提供切歌、元数据、进度条
  useMediaSession({
    onNext: next,
    onPrev: prev,
    onPlay: play,
    onPause: pause,
    onSeek: seek,
  })

  return { play, pause, seek, next, prev }
}
