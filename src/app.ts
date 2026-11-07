import type { AppConfig } from './config.ts'
import type { LiveEventDetail } from './monitor.ts'
import type { RoomConfig } from './rooms.ts'
import type { LiveRecord } from './store.ts'
import { fetchRoomInfo } from './bilibili.ts'
import { RoomMonitor } from './monitor.ts'
import { describeError, logger } from './logger.ts'
import { loadRooms } from './rooms.ts'
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

export class SubscriptionApp {
  private readonly config: AppConfig
  private readonly store: LiveStore
  private monitors: RoomMonitor[] = []
  private stopping = false
  private pruneTimer: NodeJS.Timeout | null = null

  /** 新记录写入后回调（供 Web 推送） */
  onRecord: ((record: LiveRecord) => void) | null = null

  constructor(config: AppConfig, store: LiveStore) {
    this.config = config
    this.store = store
  }

  async start(): Promise<void> {
    const rooms = loadRooms(this.config.roomsFile)
    const enabled = rooms.filter((room) => room.enabled)

    if (enabled.length === 0) {
      logger.warn('房间清单中没有启用中的房间，进程将保持空转')
    }

    logger.info(`已从 ${this.config.roomsFile} 载入 ${rooms.length} 个房间，启用 ${enabled.length} 个`)
    logger.info(`数据库: ${this.config.dbPath}，已有记录 ${this.store.count()} 条`)

    const resolved = await this.resolveNames(enabled)

    this.monitors = resolved.map((room) => {
      const monitor = new RoomMonitor(room, this.config, (detail) => this.handleLive(detail))
      monitor.start()
      return monitor
    })

    if (this.config.retentionDays > 0) {
      this.runPrune()
      this.pruneTimer = setInterval(
        () => this.runPrune(),
        24 * 60 * 60 * 1000,
      )
    }
  }

  /** 清单里 name 留空的房间，向 B 站查询主播名补全 */
  private async resolveNames(rooms: RoomConfig[]): Promise<Array<RoomConfig & { name: string }>> {
    const pending = rooms.filter((room) => room.name === null)

    if (pending.length === 0) {
      return rooms.map((room) => ({ ...room, name: room.name as string }))
    }

    logger.info(`有 ${pending.length} 个房间未填名字，正在查询主播名…`)

    const settled = await Promise.allSettled(
      pending.map((room) => fetchRoomInfo(room.id, { cookie: this.config.cookie })),
    )

    const resolved = new Map<number, string>()
    settled.forEach((result, index) => {
      const room = pending[index]!
      if (result.status === 'fulfilled' && result.value.anchorName) {
        resolved.set(room.id, result.value.anchorName)
        logger.info(`房间 ${room.id} → ${result.value.anchorName}`)
      } else {
        const reason =
          result.status === 'rejected' ? describeError(result.reason) : '接口未返回主播名'
        logger.warn(`房间 ${room.id} 取名失败（${reason}），将使用房间号作为名字`)
      }
    })

    return rooms.map((room) => ({
      ...room,
      name: room.name ?? resolved.get(room.id) ?? `房间${room.id}`,
    }))
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

      try {
        this.onRecord?.(record)
      } catch (error) {
        logger.error(`推送新记录失败: ${describeError(error)}`)
      }

      // 开播帧本身不带标题，异步补全，不阻塞入库和通知
      void this.enrichTitle(record)
    } catch (error) {
      logger.error(`写入开播记录失败: ${describeError(error)}`)
    }
  }

  /** 查一次接口，把「本场标题 + 主播名」补写进记录，并通知前端刷新 */
  private async enrichTitle(record: LiveRecord): Promise<void> {
    try {
      const info = await fetchRoomInfo(record.roomId, { cookie: this.config.cookie })

      // 标题可能刚好在两次开播之间被改，这里以接口当前值为准
      if (!info.title && !info.anchorName) return

      const updated = this.store.updateTitle(record.id, info.title, info.anchorName ?? '')
      if (!updated) return

      if (info.title) logger.info(`   标题: ${info.title}`)

      try {
        this.onRecord?.(updated)
      } catch (error) {
        logger.error(`推送补全后的记录失败: ${describeError(error)}`)
      }
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

  status(): Array<{ room: string; roomId: number; state: string; lastLive: string }> {
    return this.monitors.map((monitor) => {
      const last = this.store.lastLive(monitor.room.id)
      return {
        room: monitor.room.name,
        roomId: monitor.room.id,
        state: monitor.status,
        lastLive: last ? formatTime(last.liveTime) : '无记录',
      }
    })
  }

  stop(): void {
    if (this.stopping) return
    this.stopping = true

    if (this.pruneTimer) {
      clearInterval(this.pruneTimer)
      this.pruneTimer = null
    }

    for (const monitor of this.monitors) monitor.stop()
    this.monitors = []
  }
}
