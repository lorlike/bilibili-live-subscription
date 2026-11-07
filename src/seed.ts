/**
 * 写入一批演示数据，用于本地预览 Web 界面。
 * 默认写入「今天」，可用 --date YYYY-MM-DD 指定，--count n 指定条数。
 */
import process from 'node:process'
import { fetchRoomInfo } from './bilibili.ts'
import { config } from './config.ts'
import { loadRooms } from './rooms.ts'
import { LiveStore } from './store.ts'
import { dayRange, parseDate, todayRange } from './time.ts'

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  return process.argv[index + 1] ?? fallback
}

const dateArg = arg('--date')
const range = dateArg ? (() => {
  const parsed = parseDate(dateArg)
  if (!parsed) {
    console.error(`日期格式错误: ${dateArg}（应为 YYYY-MM-DD）`)
    process.exit(1)
  }
  return dayRange(parsed)
})() : todayRange()

const count = Math.max(1, Number(arg('--count', '12')) || 12)

let rooms
try {
  rooms = loadRooms(config.roomsFile).filter((room) => room.enabled)
} catch (error) {
  console.error((error as Error).message)
  process.exit(1)
}

if (rooms.length === 0) {
  console.error('房间清单中没有启用中的房间，无法生成演示数据')
  process.exit(1)
}

// name 留空的房间用真实主播名，让演示数据更接近实际情况
const namedRooms = await Promise.all(
  rooms.map(async (room) => {
    if (room.name) return { ...room, name: room.name }
    try {
      const info = await fetchRoomInfo(room.id, { cookie: config.cookie })
      return { ...room, name: info.anchorName ?? `房间${room.id}` }
    } catch {
      return { ...room, name: `房间${room.id}` }
    }
  }),
)
rooms.length = 0
rooms.push(...namedRooms)

const store = new LiveStore(config.dbPath)
let written = 0

try {
  const daySeconds = range.end - range.start
  // 最早 9:00 起，晚上 23:00 前结束，避免全部堆在同一分钟
  const startOffset = Math.min(9 * 3600, Math.floor(daySeconds * 0.35))
  const span = Math.min(daySeconds - startOffset, 14 * 3600)

  for (let i = 0; i < count; i++) {
    const room = rooms[i % rooms.length]!
    const offset = startOffset + Math.floor((span * i) / Math.max(1, count - 1))
    const liveTime = range.start + offset
    const key = `demo-${range.date}-${i}`

    const record = store.insertLive({
      roomId: room.id,
      roomName: room.name ?? `房间${room.id}`,
      liveTime,
      liveKey: key,
      // 模拟 1~8 秒的推送延迟
      detectedAt: liveTime * 1000 + (1000 + (i % 8) * 1000),
    })

    if (record) {
      written++
      const d = new Date(record.liveTime * 1000)
      console.log(`${d.toLocaleTimeString('zh-CN', { hour12: false })}  ${record.roomName} #${record.roomId}`)
    }
  }

  console.log(`\n已写入 ${written} 条演示记录（${range.date}） → ${config.dbPath}`)
} finally {
  store.close()
}
