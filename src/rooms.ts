import { readFileSync } from 'node:fs'
import { basename, extname, resolve } from 'node:path'
import { parse as parseToml } from 'smol-toml'

export interface RoomConfig {
  /** B 站直播间号，短号 / 长号均可 */
  id: number
  /**
   * 房间名，写入记录时使用。
   * 为 null 表示「自动」：启动时向 B 站查询主播名补全（见 app.ts）。
   */
  name: string | null
  /** 是否开启监听，默认 true */
  enabled: boolean
}

function fail(message: string): never {
  throw new Error(`房间清单格式错误: ${message}`)
}

function parseRoom(raw: unknown, index: number): RoomConfig {
  if (typeof raw !== 'object' || raw === null) fail(`第 ${index + 1} 项不是 key-value 表`)

  const item = raw as Record<string, unknown>
  const id = Number(item.id ?? item.roomId ?? item.room_id)

  if (!Number.isInteger(id) || id <= 0) fail(`第 ${index + 1} 项的 id 无效: ${String(item.id)}`)

  // name = "auto" / 省略 / 空串 都表示自动查询
  const rawName = typeof item.name === 'string' ? item.name.trim() : ''
  const name = rawName === '' || rawName.toLowerCase() === 'auto' ? null : rawName

  const enabled = item.enabled === undefined ? true : Boolean(item.enabled)

  return { id, name, enabled }
}

/**
 * 取出条目数组。
 * TOML 用 [[room]]，JSON 用 { "rooms": [...] } 或顶层数组。
 */
function extractList(doc: unknown): unknown[] {
  if (Array.isArray(doc)) return doc
  if (typeof doc !== 'object' || doc === null) fail('内容应为 TOML 表或 JSON 对象')

  const record = doc as Record<string, unknown>
  const list = record.room ?? record.rooms
  if (!Array.isArray(list)) fail('缺少 [[room]] 数组（或 JSON 的 rooms 数组）')

  return list
}

function validate(doc: unknown): RoomConfig[] {
  const rooms = extractList(doc).map(parseRoom)

  const seen = new Set<number>()
  for (const room of rooms) {
    if (seen.has(room.id)) fail(`房间 ${room.id} 重复出现`)
    seen.add(room.id)
  }

  return rooms
}

/** 读取并校验房间清单（TOML；为兼容旧配置也接受 JSON） */
export function loadRooms(filePath: string): RoomConfig[] {
  const absolute = resolve(filePath)

  let text: string
  try {
    text = readFileSync(absolute, 'utf8')
  } catch {
    throw new Error(`无法读取房间清单: ${absolute}`)
  }

  // 默认按 TOML 解析；.json 扩展名或内容以 { 开头时按 JSON 处理，便于从旧版迁移。
  // 注意不能用 '[' 判断：TOML 的 [[room]] 也以 '[' 开头。
  const head = text.trimStart()
  const isJson = extname(absolute).toLowerCase() === '.json' || head.startsWith('{')

  if (isJson) {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new Error(`房间清单 JSON 解析失败 (${basename(absolute)}): ${(error as Error).message}`)
    }
    return validate(parsed)
  }

  let parsed: unknown
  try {
    parsed = parseToml(text)
  } catch (error) {
    throw new Error(`房间清单 TOML 解析失败 (${basename(absolute)}): ${(error as Error).message}`)
  }

  return validate(parsed)
}
