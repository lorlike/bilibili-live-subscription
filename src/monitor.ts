import type { AppConfig } from './config.ts'
import type { RoomConfig } from './rooms.ts'
import type { LIVE, Message } from 'tiny-bilibili-ws'
import { KeepLiveWS } from 'tiny-bilibili-ws'
import { describeError, logger } from './logger.ts'

export type RoomMonitorStatus = 'connecting' | 'listening' | 'reconnecting' | 'stopped'

export interface LiveEventDetail {
  roomId: number
  roomName: string
  liveTime: number
  liveKey: string
}

/**
 * 从 LIVE 消息中提取开播信息。
 * 返回 null 表示该消息不可用（缺少 live_time）。
 */
export function parseLiveMessage(
  message: Message<LIVE> | undefined,
  room: ResolvedRoom,
): LiveEventDetail | null {
  const data = message?.data
  const liveTime = Number(data?.live_time)

  if (!Number.isFinite(liveTime) || liveTime <= 0) return null

  return {
    roomId: room.id,
    roomName: room.name,
    liveTime,
    liveKey: typeof data?.live_key === 'string' ? data.live_key : '',
  }
}

/** 名字已确定的房间（清单里的 name 可能为空，启动前会补全） */
export type ResolvedRoom = RoomConfig & { name: string }

export class RoomMonitor {
  readonly room: ResolvedRoom
  status: RoomMonitorStatus = 'stopped'
  private live: KeepLiveWS | null = null
  private stopped = false
  private lastLiveTime = 0
  private readonly config: AppConfig
  private readonly onLive: (detail: LiveEventDetail) => void

  constructor(room: ResolvedRoom, config: AppConfig, onLive: (detail: LiveEventDetail) => void) {
    this.room = room
    this.config = config
    this.onLive = onLive
  }

  get label(): string {
    return `${this.room.name}(${this.room.id})`
  }

  start(): void {
    if (this.live) return
    this.stopped = false
    this.status = 'connecting'

    const live = new KeepLiveWS(this.room.id, {
      headers: {
        Cookie: this.config.cookie,
      },
      uid: this.config.uid,
      keepalive: true,
      reconnectTime: this.config.reconnectTime,
      heartbeatTime: this.config.heartbeatTime,
    })

    this.live = live

    live.runWhenConnected(() => {
      if (this.stopped) return
      this.status = 'listening'
      logger.info(`正在监听 ${this.label}`)
    })

    live.on('LIVE', (message) => this.handleLive(message))
    live.on('PREPARING', () => logger.debug(`下播 / 准备中 ${this.label}`))

    live.on('reconnect', () => {
      if (this.stopped) return
      this.status = 'reconnecting'
      logger.warn(`${this.label} 连接断开，准备重连`)
    })

    live.on('error', (error: unknown) => {
      if (this.stopped) return
      this.status = 'reconnecting'
      logger.error(`${this.label} 连接错误: ${describeError(error)}`)
    })

    live.on('close', () => {
      if (this.stopped) return
      this.status = 'reconnecting'
    })
  }

  private handleLive(message: Message<LIVE>): void {
    const detail = parseLiveMessage(message, this.room)

    if (!detail) {
      logger.debug(`${this.label} 收到 LIVE 事件但缺少 live_time`, message?.data)
      return
    }

    // 同一次连接内，相同开播时间只处理一次（重连后 B 站可能重放 LIVE 帧）
    if (detail.liveTime === this.lastLiveTime) return
    this.lastLiveTime = detail.liveTime

    const reportedRoomId = Number(message?.data?.roomid) || this.room.id
    if (reportedRoomId !== this.room.id) {
      logger.debug(
        `${this.label} LIVE 事件房间号与清单不一致: ${reportedRoomId}，按清单房间号记录`,
      )
    }

    this.onLive(detail)
  }

  stop(): void {
    this.stopped = true
    this.status = 'stopped'
    try {
      this.live?.close()
    } catch (error) {
      logger.debug(`${this.label} 关闭连接时出错: ${describeError(error)}`)
    }
    this.live = null
  }
}
