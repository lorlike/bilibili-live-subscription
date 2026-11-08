import type { DatabaseSync } from 'node:sqlite'

/** 数据库里的房间（替代原来的 rooms.toml） */
export interface Room {
  id: number
  /** 显示名；为 null 表示由监听进程在启动时查主播名补全 */
  name: string | null
  /** 主播名，查到后缓存，标题每次都变所以不存这里 */
  anchorName: string | null
  /** 是否启用监听 */
  enabled: boolean
  note: string
  createdAt: number
  updatedAt: number
}

export interface RoomInput {
  id: number
  name?: string | null
  anchorName?: string | null
  enabled?: boolean
  note?: string
}

interface Row {
  id: number
  name: string | null
  anchor_name: string | null
  enabled: number
  note: string
  created_at: number
  updated_at: number
}

function toRoom(row: Row): Room {
  return {
    id: row.id,
    name: row.name,
    anchorName: row.anchor_name,
    enabled: row.enabled === 1,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const FIELDS = 'id, name, anchor_name, enabled, note, created_at, updated_at'

export class RoomRepo {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        id          INTEGER PRIMARY KEY,
        name        TEXT,
        anchor_name TEXT,
        enabled     INTEGER NOT NULL DEFAULT 1,
        note        TEXT    NOT NULL DEFAULT '',
        created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `)
  }

  list(): Room[] {
    const rows = this.db
      .prepare(`SELECT ${FIELDS} FROM rooms ORDER BY id ASC`)
      .all() as unknown as Row[]
    return rows.map(toRoom)
  }

  /** 只返回启用中的房间，监听进程用这个 */
  listEnabled(): Room[] {
    const rows = this.db
      .prepare(`SELECT ${FIELDS} FROM rooms WHERE enabled = 1 ORDER BY id ASC`)
      .all() as unknown as Row[]
    return rows.map(toRoom)
  }

  /** 用一组 id 判断监听集合是否变化（不含字段变化） */
  enabledIds(): number[] {
    const rows = this.db
      .prepare('SELECT id FROM rooms WHERE enabled = 1 ORDER BY id ASC')
      .all() as unknown as Array<{ id: number }>
    return rows.map((row) => row.id)
  }

  get(id: number): Room | null {
    const row = this.db
      .prepare(`SELECT ${FIELDS} FROM rooms WHERE id = ?`)
      .get(id) as unknown as Row | undefined
    return row ? toRoom(row) : null
  }

  create(input: RoomInput): Room {
    const now = Math.floor(Date.now() / 1000)
    this.db
      .prepare(`
        INSERT INTO rooms (id, name, anchor_name, enabled, note, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.id,
        input.name ?? null,
        input.anchorName ?? null,
        input.enabled === false ? 0 : 1,
        input.note ?? '',
        now,
        now,
      )

    return this.get(input.id)!
  }

  update(id: number, input: Partial<RoomInput>): Room | null {
    const existing = this.get(id)
    if (!existing) return null

    const name = input.name === undefined ? existing.name : input.name
    const anchorName = input.anchorName === undefined ? existing.anchorName : input.anchorName
    const enabled = input.enabled === undefined ? existing.enabled : input.enabled
    const note = input.note === undefined ? existing.note : input.note

    this.db
      .prepare(`
        UPDATE rooms
        SET name = ?, anchor_name = ?, enabled = ?, note = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(name, anchorName, enabled ? 1 : 0, note, Math.floor(Date.now() / 1000), id)

    return this.get(id)
  }

  /** 改名或补全主播名（监听进程用） */
  setName(id: number, name: string | null, anchorName: string | null): void {
    this.db
      .prepare('UPDATE rooms SET name = ?, anchor_name = ?, updated_at = ? WHERE id = ?')
      .run(name, anchorName, Math.floor(Date.now() / 1000), id)
  }

  delete(id: number): boolean {
    const result = this.db.prepare('DELETE FROM rooms WHERE id = ?').run(id)
    return Number(result.changes) > 0
  }

  /** 首次启动时从 rooms.toml 导入（只导一次，已有数据则跳过） */
  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM rooms').get() as { n: number }
    return Number(row.n)
  }
}
