import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export interface LiveRecord {
  id: number
  roomId: number
  roomName: string
  /** 开播时间（B 站下发的 live_time，Unix 秒） */
  liveTime: number
  /** 本地收到开播事件的时间（Unix 毫秒） */
  detectedAt: number
  /** 本次开播的唯一标识，用于去重 */
  liveKey: string
  /** 开播时的直播间标题（事后通过 API 补全，可能为空） */
  title: string
  /** 主播名（事后通过 API 补全，可能为空） */
  anchorName: string
}

export interface LiveRecordInput {
  roomId: number
  roomName: string
  liveTime: number
  detectedAt?: number
  liveKey?: string
}

interface Row {
  id: number
  room_id: number
  room_name: string
  live_time: number
  detected_at: number
  live_key: string | null
  title: string | null
  anchor_name: string | null
}

function toRecord(row: Row): LiveRecord {
  return {
    id: row.id,
    roomId: row.room_id,
    roomName: row.room_name,
    liveTime: row.live_time,
    detectedAt: row.detected_at,
    liveKey: row.live_key ?? '',
    title: row.title ?? '',
    anchorName: row.anchor_name ?? '',
  }
}

/** 所有查询共用的字段列表 */
const FIELDS = 'id, room_id, room_name, live_time, detected_at, live_key, title, anchor_name'

export class LiveStore {
  private readonly db: DatabaseSync

  constructor(filePath: string) {
    const inMemory = filePath === ':memory:'
    const absolute = inMemory ? filePath : resolve(filePath)
    if (!inMemory) mkdirSync(dirname(absolute), { recursive: true })

    this.db = new DatabaseSync(absolute)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS live_records (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id     INTEGER NOT NULL,
        room_name   TEXT    NOT NULL,
        live_time   INTEGER NOT NULL,
        detected_at INTEGER NOT NULL,
        live_key    TEXT,
        created_at  INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_live_records_room_time
        ON live_records (room_id, live_time DESC);

      CREATE INDEX IF NOT EXISTS idx_live_records_live_time
        ON live_records (live_time DESC);

      CREATE UNIQUE INDEX IF NOT EXISTS uniq_live_records_key
        ON live_records (room_id, live_key)
        WHERE live_key IS NOT NULL AND live_key <> '';
    `)

    this.migrate()
  }

  /** 为旧库补上后加的列（幂等） */
  private migrate(): void {
    const existing = new Set(
      (this.db.prepare('PRAGMA table_info(live_records)').all() as unknown as Array<{
        name: string
      }>).map((column) => column.name),
    )

    if (!existing.has('title')) {
      this.db.exec('ALTER TABLE live_records ADD COLUMN title TEXT')
    }
    if (!existing.has('anchor_name')) {
      this.db.exec('ALTER TABLE live_records ADD COLUMN anchor_name TEXT')
    }
  }

  /**
   * 写入一条开播记录。
   * · 有 live_key 时按 (room_id, live_key) 去重；
   * · 否则按 (room_id, live_time) 去重。
   * 命中重复时返回 null。
   */
  insertLive(input: LiveRecordInput): LiveRecord | null {
    const detectedAt = input.detectedAt ?? Date.now()
    const liveKey = input.liveKey ?? ''

    const existing = liveKey
      ? this.db
          .prepare('SELECT id FROM live_records WHERE room_id = ? AND live_key = ? LIMIT 1')
          .get(input.roomId, liveKey)
      : this.db
          .prepare('SELECT id FROM live_records WHERE room_id = ? AND live_time = ? LIMIT 1')
          .get(input.roomId, input.liveTime)

    if (existing) return null

    const result = this.db
      .prepare(`
        INSERT INTO live_records (room_id, room_name, live_time, detected_at, live_key)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(input.roomId, input.roomName, input.liveTime, detectedAt, liveKey)

    return {
      id: Number(result.lastInsertRowid),
      roomId: input.roomId,
      roomName: input.roomName,
      liveTime: input.liveTime,
      detectedAt,
      liveKey,
      title: '',
      anchorName: '',
    }
  }

  /** 补写标题与主播名（开播事件本身不带这些信息） */
  updateTitle(id: number, title: string, anchorName: string): LiveRecord | null {
    this.db
      .prepare('UPDATE live_records SET title = ?, anchor_name = ? WHERE id = ?')
      .run(title, anchorName, id)

    const row = this.db
      .prepare(`SELECT ${FIELDS} FROM live_records WHERE id = ?`)
      .get(id) as unknown as Row | undefined

    return row ? toRecord(row) : null
  }

  /** 删除 live_time 早于指定时间（Unix 秒）的记录，返回删除条数 */
  prune(olderThan: number): number {
    const result = this.db.prepare('DELETE FROM live_records WHERE live_time < ?').run(olderThan)
    return Number(result.changes)
  }

  /** 最近的开播记录，按开播时间倒序 */
  recent(limit = 20): LiveRecord[] {
    const rows = this.db
      .prepare(`
        SELECT ${FIELDS}
        FROM live_records
        ORDER BY live_time DESC
        LIMIT ?
      `)
      .all(limit) as unknown as Row[]

    return rows.map(toRecord)
  }

  /**
   * 给定时间区间内的记录，按开播时间从早到晚。
   * 区间为「左闭右开」：start <= live_time < end
   */
  recordsBetween(start: number, end: number): LiveRecord[] {
    const rows = this.db
      .prepare(`
        SELECT ${FIELDS}
        FROM live_records
        WHERE live_time >= ? AND live_time < ?
        ORDER BY live_time ASC, id ASC
      `)
      .all(start, end) as unknown as Row[]

    return rows.map(toRecord)
  }

  /** 区间内 id 大于 cursor 的记录，按 id 升序（用于增量推送） */
  recordsAfter(cursor: number, start: number, end: number): LiveRecord[] {
    const rows = this.db
      .prepare(`
        SELECT ${FIELDS}
        FROM live_records
        WHERE id > ? AND live_time >= ? AND live_time < ?
        ORDER BY id ASC
      `)
      .all(cursor, start, end) as unknown as Row[]

    return rows.map(toRecord)
  }

  /** 区间内最大的记录 id，无记录时返回 0 */
  maxIdInRange(start: number, end: number): number {
    const row = this.db
      .prepare('SELECT MAX(id) AS id FROM live_records WHERE live_time >= ? AND live_time < ?')
      .get(start, end) as { id: number | null }

    return Number(row.id ?? 0)
  }

  /** 某个房间最近一次开播，无记录时返回 null */
  lastLive(roomId: number): LiveRecord | null {
    const row = this.db
      .prepare(`
        SELECT ${FIELDS}
        FROM live_records
        WHERE room_id = ?
        ORDER BY live_time DESC
        LIMIT 1
      `)
      .get(roomId) as unknown as Row | undefined

    return row ? toRecord(row) : null
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM live_records').get() as { n: number }
    return Number(row.n)
  }

  /** 每个房间的汇总：记录数、最近/首次开播时间 */
  roomSummaries(): Array<{
    roomId: number
    count: number
    lastLive: number
    firstLive: number
  }> {
    const rows = this.db
      .prepare(`
        SELECT room_id,
               COUNT(*)      AS n,
               MAX(live_time) AS last_live,
               MIN(live_time) AS first_live
        FROM live_records
        GROUP BY room_id
      `)
      .all() as unknown as Array<{
      room_id: number
      n: number
      last_live: number
      first_live: number
    }>

    return rows.map((row) => ({
      roomId: row.room_id,
      count: Number(row.n),
      lastLive: Number(row.last_live),
      firstLive: Number(row.first_live),
    }))
  }

  close(): void {
    this.db.close()
  }
}
