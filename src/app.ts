import type { AppConfig } from './config.ts'
import type { LiveEventDetail } from './monitor.ts'
import type { LiveRecord } from './store.ts'
import type { Room, RoomRepo } from './repo/rooms.ts'
import { fetchRoomInfo } from './bilibili.ts'
import { RoomMonitor } from './monitor.ts'
import { describeError, logger } from './logger.ts'
import { LiveStore } from './store.ts'

function formatTime(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

export function formatRecord(record: LiveRecord): string {
  const base = `${formatTime(record.liveTime)}  ${record.roomName}(${record.roomId})`
  return record.title ? `${base}  ${record.title}` : base
}

export interface SubscriptionAppOptions {
  config: AppConfig
  store: LiveStore
  rooms: RoomRepo
  /** 同步间隔（毫秒）；0 表示不自动同步，只手动调 sync() */
  syncIntervalMs?: number
}

/**
 * 监听编排。
 *
 * 房间集合来自数据库的 rooms 表，进程定期把「数据库里的启用房间」与
 * 「当前正在监听的房间」做差分，只对差异部分建立/断开连接 ——
 * 已在监听的房间绝不断开，否则每轮同步都会丢掉 WS 连接。
 */
export class SubscriptionApp {
  private readonly config: AppConfig
  private readonly store: LiveStore
  private readonly rooms: RoomRepo
  private readonly syncIntervalMs: number

  /** roomId -> monitor，用 Map 便于按 id 差分 */
  private readonly monitors = new Map<number, RoomMonitor>()
  private stopping = false
  private syncing = false
  private syncTimer: NodeJS.Timeout | null = null
  private pruneTimer: NodeJS.Timeout | null = null

  constructor(options: SubscriptionAppOptions) {
    this.config = options.config
    this.store = options.store
    this.rooms = options.rooms
    this.syncIntervalMs = options.syncIntervalMs ?? 5000
  }

  async start(): Promise<void> {
    logger.info(`数据库: ${this.config.dbPath}，已有记录 ${this.store.count()} 条`)

    await this.sync()

    if (this.syncIntervalMs > 0) {
      this.syncTimer = setInterval(() => void this.sync(), this.syncIntervalMs)
    }

    if (this.config.retentionDays > 0) {
      this.runPrune()
      this.pruneTimer = setInterval(() => this.runPrune(), 24 * 60 * 60 * 1000)
    }
  }

  /**
   * 按数据库的房间集合调整监听。
   * 幂等，可以随时调用（Web 侧增删房间后也会触发）。
   */
  async sync(): Promise<void> {
    if (this.stopping || this.syncing) return
    this.syncing = true

    try {
      const desired = this.rooms.listEnabled()
      const desiredIds = new Set(desired.map((room) => room.id))

      // 1. 断开已经从清单移除 / 被禁用的房间
      for (const [roomId, monitor] of this.monitors) {
        if (desiredIds.has(roomId)) continue
        logger.info(`停止监听 ${monitor.label}（已移除或禁用）`)
        monitor.stop()
        this.monitors.delete(roomId)
      }

      // 2. 为新出现的房间建立连接
      for (const room of desired) {
        if (this.monitors.has(room.id)) continue
        await this.startMonitor(room)
      }
    } catch (error) {
      logger.error(`同步房间失败: ${describeError(error)}`)
    } finally {
      this.syncing = false
    }
  }

  private async startMonitor(room: Room): Promise<void> {
    const name = room.name ?? (await this.resolveName(room))

    const monitor = new RoomMonitor({ id: room.id, name, enabled: true }, this.config, (detail) =>
      this.handleLive(detail),
    )

    this.monitors.set(room.id, monitor)
    monitor.start()
  }

  /** 清单里没写名字的房间，查一次主播名并写回数据库（下次就不用再查） */
  private async resolveName(room: Room): Promise<string> {
    try {
      const info = await fetchRoomInfo(room.id, { cookie: this.config.cookie })
      const anchorName = info.anchorName ?? null

      if (anchorName) {
        // 只回填主播名，不覆盖用户手写的 name
        this.rooms.setName(room.id, room.anchorName ? room.name : (room.name ?? anchorName), anchorName)
        logger.info(`房间 ${room.id} → ${anchorName}`)
        return anchorName
      }
    } catch (error) {
      logger.warn(`房间 ${room.id} 取名失败（${describeError(error)}），用房间号代替`)
    }

    return `房间${room.id}`
  }

  private handleLive(detail: LiveEventDetail): void {
    try {
      const record = this.store.insertLive({
        roomId: detail.roomId,
        roomName: detail.roomName,
        liveTime: detail.liveTime,
        liveKey: detail.liveKey,
      })

      if (!record) {
        logger.debug(`${detail.roomName}(${detail.roomId}) 开播事件重复，已忽略`)
        return
      }

      logger.info(`🔴 ${formatRecord(record)} 开播（记录 #${record.id}）`)

      // 开播帧本身不带标题，异步补全，不阻塞入库
      void this.enrichTitle(record)
    } catch (error) {
      logger.error(`写入开播记录失败: ${describeError(error)}`)
    }
  }

  /** 查一次接口，把「本场标题 + 主播名」补写进记录 */
  private async enrichTitle(record: LiveRecord): Promise<void> {
    try {
      const info = await fetchRoomInfo(record.roomId, { cookie: this.config.cookie })
      if (!info.title && !info.anchorName) return

      this.store.updateTitle(record.id, info.title, info.anchorName ?? '')
      if (info.title) logger.debug(`   标题: ${info.title}`)
    } catch (error) {
      // 补全失败不影响主流程，记录已经落库
      logger.debug(`补全标题失败（房间 ${record.roomId}）: ${describeError(error)}`)
    }
  }

  private runPrune(): void {
    const cutoff = Math.floor(Date.now() / 1000) - this.config.retentionDays * 24 * 60 * 60
    try {
      const removed = this.store.prune(cutoff)
      if (removed > 0) logger.info(`已清理 ${removed} 条超过 ${this.config.retentionDays} 天的记录`)
    } catch (error) {
      logger.error(`清理历史记录失败: ${describeError(error)}`)
    }
  }

  /** 当前监听状态，供后台页面展示 */
  status(): Array<{ roomId: number; room: string; state: string }> {
    return [...this.monitors.values()].map((monitor) => ({
      roomId: monitor.room.id,
      room: monitor.room.name,
      state: monitor.status,
    }))
  }

  get listeningCount(): number {
    return this.monitors.size
  }

  stop(): void {
    if (this.stopping) return
    this.stopping = true

    if (this.syncTimer) {
      clearInterval(this.syncTimer)
      this.syncTimer = null
    }
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer)
      this.pruneTimer = null
    }

    for (const monitor of this.monitors.values()) monitor.stop()
    this.monitors.clear()
  }
}
