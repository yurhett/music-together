/**
 * RadioConductor — 服务端走带器
 *
 * 电台模式下，服务端接管 conductor 职责：
 *  - 每秒推进 room.playState.currentTime
 *  - 歌曲结束时自动调用 playNextTrackInRoom
 *  - 暂停/恢复/seek/切歌时同步内部状态
 *
 * 每个电台房间持有一个 RadioConductor 实例，存储在 per-room Map 中。
 *
 * 依赖方向（避免循环）：
 *   radioConductor -> roomRepository (只读 room)
 *   radioConductor NOT imported by playerService directly for start/stop;
 *   playerService calls exported getRadioConductor() + RadioConductor methods.
 */

import { roomRepo } from '../repositories/roomRepository.js'
import { logger } from '../utils/logger.js'
import type { TypedServer } from '../middleware/types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RadioConductorHandle {
  /** 开始/重置计时（切换新曲目时调用） */
  start(startTime?: number): void
  /** 暂停走带计时器 */
  pause(): void
  /** 恢复走带计时器 */
  resume(): void
  /** 手动 seek（同步内部 startTime 基准） */
  seek(time: number): void
  /** 停止计时器，重置状态（停止播放时调用） */
  stop(): void
  /** 销毁，释放所有资源（房间删除或关闭电台模式时调用） */
  destroy(): void
}

// ---------------------------------------------------------------------------
// Internal implementation
// ---------------------------------------------------------------------------

const TICK_INTERVAL_MS = 1000

/**
 * 歌曲结束检测提前量（秒）：
 * 当 estimatedTime >= duration - END_THRESHOLD_S 时触发 autoNext
 */
const END_THRESHOLD_S = 0.8

class RadioConductorImpl implements RadioConductorHandle {
  private readonly roomId: string
  private readonly io: TypedServer
  /** playNextFn 在运行时由 playerService 注入，避免循环导入 */
  private readonly onTrackEnd: (roomId: string) => Promise<void>

  private timer: ReturnType<typeof setInterval> | null = null
  /** 当前是否暂停 */
  private isPaused = false
  /** 是否已在处理 trackEnd（防止重复触发） */
  private isHandlingEnd = false

  constructor(
    roomId: string,
    io: TypedServer,
    onTrackEnd: (roomId: string) => Promise<void>,
  ) {
    this.roomId = roomId
    this.io = io
    this.onTrackEnd = onTrackEnd
  }

  start(startTime?: number): void {
    this.stop() // 先清理旧的
    this.isPaused = false
    this.isHandlingEnd = false

    // 如果指定了 startTime，先同步到 room.playState
    if (startTime !== undefined) {
      const room = roomRepo.get(this.roomId)
      if (room) {
        room.playState = {
          isPlaying: true,
          currentTime: startTime,
          serverTimestamp: Date.now(),
        }
      }
    }

    this._startTimer()
    logger.info(`RadioConductor started for room ${this.roomId}`, { roomId: this.roomId })
  }

  pause(): void {
    if (this.isPaused) return
    this.isPaused = true
    this._clearTimer()
    logger.info(`RadioConductor paused for room ${this.roomId}`, { roomId: this.roomId })
  }

  resume(): void {
    if (!this.isPaused) return
    this.isPaused = false
    this.isHandlingEnd = false
    this._startTimer()
    logger.info(`RadioConductor resumed for room ${this.roomId}`, { roomId: this.roomId })
  }

  seek(time: number): void {
    const room = roomRepo.get(this.roomId)
    if (!room) return
    // playState 已由 playerService.seekTrack 更新，这里重置 isHandlingEnd 即可
    this.isHandlingEnd = false
    logger.info(`RadioConductor seek to ${time.toFixed(2)}s for room ${this.roomId}`, { roomId: this.roomId })
  }

  stop(): void {
    this._clearTimer()
    this.isPaused = false
    this.isHandlingEnd = false
    logger.info(`RadioConductor stopped for room ${this.roomId}`, { roomId: this.roomId })
  }

  destroy(): void {
    this.stop()
    logger.info(`RadioConductor destroyed for room ${this.roomId}`, { roomId: this.roomId })
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _startTimer(): void {
    this.timer = setInterval(() => {
      this._tick()
    }, TICK_INTERVAL_MS)
  }

  private _clearTimer(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * 每秒 tick：
   * 1. 推进 room.playState.currentTime（由 playerService 的 estimateCurrentTime 负责估算，
   *    这里只做 end-of-track 检测）
   * 2. 检查歌曲是否结束，是则触发 onTrackEnd
   */
  private _tick(): void {
    if (this.isPaused || this.isHandlingEnd) return

    const room = roomRepo.get(this.roomId)
    if (!room || !room.currentTrack || !room.playState.isPlaying) return

    const { duration } = room.currentTrack
    if (!duration || duration <= 0) return

    // 用服务端估算的时间来检测结束，与 estimateCurrentTime 保持一致
    const elapsed = Math.max(0, (Date.now() - room.playState.serverTimestamp) / 1000)
    const currentTime = room.playState.currentTime + elapsed

    if (currentTime >= duration - END_THRESHOLD_S) {
      this.isHandlingEnd = true
      this._clearTimer()
      logger.info(
        `RadioConductor: track "${room.currentTrack.title}" ended (${currentTime.toFixed(2)}s / ${duration}s), advancing`,
        { roomId: this.roomId },
      )
      // 异步触发下一曲（playNextTrackInRoom 内部有 mutex 保护防竞态）
      this.onTrackEnd(this.roomId).catch((err) => {
        logger.error('RadioConductor onTrackEnd error', err, { roomId: this.roomId })
        this.isHandlingEnd = false
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Per-room conductor registry
// ---------------------------------------------------------------------------

const conductors = new Map<string, RadioConductorImpl>()

/**
 * 获取房间的 RadioConductor，若不存在则创建。
 * onTrackEnd 仅在首次创建时使用，后续 get 调用忽略该参数。
 */
export function getOrCreateRadioConductor(
  roomId: string,
  io: TypedServer,
  onTrackEnd: (roomId: string) => Promise<void>,
): RadioConductorHandle {
  let conductor = conductors.get(roomId)
  if (!conductor) {
    conductor = new RadioConductorImpl(roomId, io, onTrackEnd)
    conductors.set(roomId, conductor)
  }
  return conductor
}

/**
 * 获取已存在的 RadioConductor（不自动创建）
 */
export function getRadioConductor(roomId: string): RadioConductorHandle | undefined {
  return conductors.get(roomId)
}

/**
 * 销毁并移除房间的 RadioConductor（电台模式关闭或房间删除时调用）
 */
export function destroyRadioConductor(roomId: string): void {
  const conductor = conductors.get(roomId)
  if (conductor) {
    conductor.destroy()
    conductors.delete(roomId)
  }
}

/**
 * 清理所有 conductor（服务器关闭时调用）
 */
export function destroyAllRadioConductors(): void {
  for (const [roomId, conductor] of conductors) {
    conductor.destroy()
    conductors.delete(roomId)
  }
}
