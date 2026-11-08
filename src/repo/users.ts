import type { DatabaseSync } from 'node:sqlite'
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>

const KEY_LEN = 64
const SALT_LEN = 16

export interface User {
  id: number
  username: string
  createdAt: number
}

interface UserRow {
  id: number
  username: string
  password_hash: string
  created_at: number
}

/** scrypt 哈希，格式：scrypt$<salt hex>$<hash hex> */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN)
  const derived = await scryptAsync(password, salt, KEY_LEN)
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false

  const salt = Buffer.from(parts[1]!, 'hex')
  const expected = Buffer.from(parts[2]!, 'hex')
  const actual = await scryptAsync(password, salt, expected.length)

  // 定长比较，避免时序泄漏
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export class UserRepo {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        username      TEXT    NOT NULL UNIQUE,
        password_hash TEXT    NOT NULL,
        created_at    INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `)
  }

  /** 用户表是否为空（用于首次启动引导创建管理员） */
  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }
    return Number(row.n)
  }

  findByUsername(username: string): UserRow | null {
    const row = this.db
      .prepare('SELECT id, username, password_hash, created_at FROM users WHERE username = ?')
      .get(username) as unknown as UserRow | undefined
    return row ?? null
  }

  findById(id: number): User | null {
    const row = this.db
      .prepare('SELECT id, username, created_at FROM users WHERE id = ?')
      .get(id) as unknown as Omit<UserRow, 'password_hash'> | undefined

    return row ? { id: row.id, username: row.username, createdAt: row.created_at } : null
  }

  async create(username: string, password: string): Promise<User> {
    const hash = await hashPassword(password)
    const result = this.db
      .prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
      .run(username, hash)

    return this.findById(Number(result.lastInsertRowid))!
  }

  async updatePassword(id: number, password: string): Promise<boolean> {
    const hash = await hashPassword(password)
    const result = this.db
      .prepare('UPDATE users SET password_hash = ? WHERE id = ?')
      .run(hash, id)
    return Number(result.changes) > 0
  }

  delete(id: number): boolean {
    const result = this.db.prepare('DELETE FROM users WHERE id = ?').run(id)
    return Number(result.changes) > 0
  }

  list(): User[] {
    const rows = this.db
      .prepare('SELECT id, username, created_at FROM users ORDER BY id ASC')
      .all() as unknown as Array<Omit<UserRow, 'password_hash'>>

    return rows.map((row) => ({ id: row.id, username: row.username, createdAt: row.created_at }))
  }

  async verify(username: string, password: string): Promise<User | null> {
    const row = this.findByUsername(username)
    if (!row) return null

    const ok = await verifyPassword(password, row.password_hash)
    return ok ? { id: row.id, username: row.username, createdAt: row.created_at } : null
  }
}
