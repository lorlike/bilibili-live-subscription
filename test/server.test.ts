import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import type { AppConfig } from '../src/config.ts'
import type { WebServer } from '../src/server.ts'
import { WebServer as Server } from '../src/server.ts'
import { LiveStore } from '../src/store.ts'
import { dayRange } from '../src/time.ts'

const dir = mkdtempSync(join(tmpdir(), 'bls-web-'))
const dbPath = join(dir, 'test.db')

// 测试用清单，写在临时目录里，不依赖仓库中的 rooms.toml
const roomsFile = join(dir, 'rooms.toml')
writeFileSync(
  roomsFile,
  `
[[room]]
id = 1
name = "房间一"

[[room]]
id = 2
name = "auto"
enabled = false
`,
)

const config: AppConfig = {
  cookie: '',
  uid: 0,
  roomsFile,
  dbPath,
  retentionDays: 0,
  webHost: '127.0.0.1',
  webPort: 0,
  reconnectTime: 5000,
  heartbeatTime: 30000,
  logLevel: 'error',
}

let server: WebServer
let base = ''

before(async () => {
  server = new Server({ config, port: 0, host: '127.0.0.1' })
  const port = await server.listen()
  base = `http://127.0.0.1:${port}`
})

after(async () => {
  await server.close()
})

test('GET / 返回终端页面', async () => {
  const res = await fetch(`${base}/`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') ?? '', /text\/html/)
  const html = await res.text()
  assert.match(html, /id="lines"/)
  assert.match(html, /app\.js/)
})

test('静态资源可访问，且目录穿越被拒绝', async () => {
  assert.equal((await fetch(`${base}/style.css`)).status, 200)
  assert.equal((await fetch(`${base}/app.js`)).status, 200)
  assert.equal((await fetch(`${base}/nope.js`)).status, 404)

  const escaped = await fetch(`${base}/../package.json`)
  assert.notEqual(escaped.status, 200)
})

test('POST 被拒绝', async () => {
  const res = await fetch(`${base}/api/records`, { method: 'POST' })
  assert.equal(res.status, 405)
})

test('/api/records 需要合法日期', async () => {
  const bad = await fetch(`${base}/api/records?date=2026-02-31`)
  assert.equal(bad.status, 400)

  const ok = await fetch(`${base}/api/records?date=2026-11-07`)
  assert.equal(ok.status, 200)
  const body = (await ok.json()) as { date: string; records: unknown[] }
  assert.equal(body.date, '2026-11-07')
  assert.ok(Array.isArray(body.records))
})

test('/api/records 只返回当天记录并按时间正序', async () => {
  const range = dayRange(new Date(2026, 11, 25))
  const store = new LiveStore(dbPath)
  try {
    store.insertLive({ roomId: 1, roomName: 'A', liveTime: range.start - 100, liveKey: 'x' })
    store.insertLive({ roomId: 1, roomName: 'A', liveTime: range.start + 300, liveKey: 'b' })
    store.insertLive({ roomId: 2, roomName: 'B', liveTime: range.start + 100, liveKey: 'a' })
  } finally {
    store.close()
  }

  const body = (await (await fetch(`${base}/api/records?date=2026-12-25`)).json()) as {
    total: number
    rooms: number
    records: Array<{ liveKey: string }>
  }
  assert.equal(body.total, 2)
  assert.equal(body.rooms, 2)
  assert.deepEqual(
    body.records.map((r) => r.liveKey),
    ['a', 'b'],
  )
})

test('/api/meta 返回当日与总数', async () => {
  const body = (await (await fetch(`${base}/api/meta?date=2026-12-25`)).json()) as {
    date: string
    total: number
    all: number
  }
  assert.equal(body.date, '2026-12-25')
  assert.equal(body.total, 2)
  assert.equal(typeof body.all, 'number')
})

test('/api/stream 返回 SSE 并支持实时推送', async () => {
  const controller = new AbortController()
  const res = await fetch(`${base}/api/stream?date=2026-12-25`, { signal: controller.signal })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/)

  const reader = res.body!.getReader()
  const decoder = new TextDecoder()

  const readSome = async (needle: string, timeoutMs = 4000): Promise<string> => {
    const deadline = Date.now() + timeoutMs
    let buffer = ''
    while (Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      if (buffer.includes(needle)) return buffer
    }
    throw new Error(`未在 ${timeoutMs}ms 内收到 ${needle}`)
  }

  const ready = await readSome('event: ready')
  assert.match(ready, /2026-12-25/)

  // 另一个连接写入新记录，应通过轮询推送过来
  const range = dayRange(new Date(2026, 11, 25))
  const store = new LiveStore(dbPath)
  try {
    store.insertLive({ roomId: 3, roomName: 'C', liveTime: range.start + 999, liveKey: 'pushed' })
  } finally {
    store.close()
  }

  const pushed = await readSome('event: record', 6000)
  assert.match(pushed, /"liveKey":"pushed"/)

  controller.abort()
})

test('同一 id 的补全记录会被再次推送（用于刷新标题）', async () => {
  const controller = new AbortController()
  const res = await fetch(`${base}/api/stream?date=2026-12-25`, { signal: controller.signal })
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()

  const readUntil = async (needle: string, timeoutMs = 6000): Promise<string> => {
    const deadline = Date.now() + timeoutMs
    let buffer = ''
    while (Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      if (buffer.includes(needle)) return buffer
    }
    throw new Error(`未收到 ${needle}`)
  }

  await readUntil('event: ready')

  const range = dayRange(new Date(2026, 11, 25))
  const store = new LiveStore(dbPath)
  let updated
  try {
    store.insertLive({ roomId: 4, roomName: 'D', liveTime: range.start + 1234, liveKey: 'enrich' })
    const record = store.lastLive(4)!
    updated = store.updateTitle(record.id, '补全后的标题', '主播D')!
  } finally {
    store.close()
  }

  // 直接调用 publish 两次（模拟落库 + 补全）
  server.publish({ ...updated, title: '' })
  server.publish(updated)

  const text = await readUntil('补全后的标题')
  assert.match(text, /"id":\d+/)
  controller.abort()
})


test('/api/rooms 返回清单与每个房间的统计', async () => {
  const body = (await (await fetch(`${base}/api/rooms`)).json()) as {
    roomsFile: string
    total: number
    enabled: number
    records: number
    rooms: Array<{
      id: number
      name: string | null
      enabled: boolean
      recordCount: number
      lastLive: number | null
      firstLive: number | null
    }>
    orphaned: Array<{ id: number; recordCount: number; orphaned?: boolean }>
  }

  assert.equal(body.roomsFile, roomsFile)
  assert.equal(body.total, 2)
  assert.equal(body.enabled, 1)
  assert.equal(body.rooms[0]!.id, 1)
  assert.equal(body.rooms[0]!.name, '房间一')
  assert.equal(body.rooms[1]!.name, null, 'name = "auto" 应为 null')
  assert.equal(body.rooms[1]!.enabled, false)
  assert.equal(typeof body.records, 'number')

  // 清单里的房间都应在结果中，且带统计字段
  for (const room of body.rooms) {
    assert.equal(typeof room.id, 'number')
    assert.equal(typeof room.enabled, 'boolean')
    assert.equal(typeof room.recordCount, 'number')
    assert.ok(room.lastLive === null || typeof room.lastLive === 'number')
  }
})

test('/api/rooms 在清单不存在时返回 500 且带错误信息', async () => {
  const broken = new Server({
    config: { ...config, roomsFile: 'this-file-does-not-exist.toml' },
    port: 0,
    host: '127.0.0.1',
  })
  const port = await broken.listen()
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/rooms`)
    assert.equal(res.status, 500)
    const body = (await res.json()) as { error: string; roomsFile: string }
    assert.match(body.error, /无法读取房间清单/)
    assert.equal(body.roomsFile, 'this-file-does-not-exist.toml')
  } finally {
    await broken.close()
  }
})
