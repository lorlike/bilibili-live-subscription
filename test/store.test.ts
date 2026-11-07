import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LiveStore } from '../src/store.ts'

test('重复的 live_key 只写入一次', () => {
  const store = new LiveStore(':memory:')
  try {
    const first = store.insertLive({ roomId: 1, roomName: 'A', liveTime: 1000, liveKey: 'k1' })
    const second = store.insertLive({ roomId: 1, roomName: 'A', liveTime: 1000, liveKey: 'k1' })

    assert.ok(first)
    assert.equal(second, null)
    assert.equal(store.count(), 1)
  } finally {
    store.close()
  }
})

test('相同开播时间但不同 live_key 视为不同场次', () => {
  const store = new LiveStore(':memory:')
  try {
    store.insertLive({ roomId: 1, roomName: 'A', liveTime: 1000, liveKey: 'k1' })
    const other = store.insertLive({ roomId: 1, roomName: 'A', liveTime: 1000, liveKey: 'k2' })

    assert.ok(other)
    assert.equal(store.count(), 2)
  } finally {
    store.close()
  }
})

test('无 live_key 时按 room_id + live_time 去重', () => {
  const store = new LiveStore(':memory:')
  try {
    assert.ok(store.insertLive({ roomId: 1, roomName: 'A', liveTime: 1000 }))
    assert.equal(store.insertLive({ roomId: 1, roomName: 'A', liveTime: 1000 }), null)
    assert.ok(store.insertLive({ roomId: 2, roomName: 'B', liveTime: 1000 }))
  } finally {
    store.close()
  }
})

test('lastLive 返回该房间最新记录', () => {
  const store = new LiveStore(':memory:')
  try {
    store.insertLive({ roomId: 7, roomName: 'X', liveTime: 2000, liveKey: 'a' })
    store.insertLive({ roomId: 7, roomName: 'X', liveTime: 5000, liveKey: 'b' })
    store.insertLive({ roomId: 7, roomName: 'X', liveTime: 3000, liveKey: 'c' })

    const last = store.lastLive(7)
    assert.equal(last?.liveTime, 5000)
    assert.equal(store.lastLive(999), null)
  } finally {
    store.close()
  }
})

test('prune 删除早于阈值的记录', () => {
  const store = new LiveStore(':memory:')
  try {
    store.insertLive({ roomId: 1, roomName: 'A', liveTime: 100, liveKey: 'old' })
    store.insertLive({ roomId: 1, roomName: 'A', liveTime: 900, liveKey: 'new' })

    assert.equal(store.prune(500), 1)
    assert.equal(store.count(), 1)
    assert.equal(store.recent(1)[0]?.liveKey, 'new')
  } finally {
    store.close()
  }
})

test('recent 按开播时间倒序', () => {
  const store = new LiveStore(':memory:')
  try {
    store.insertLive({ roomId: 1, roomName: 'A', liveTime: 100, liveKey: 'a' })
    store.insertLive({ roomId: 2, roomName: 'B', liveTime: 300, liveKey: 'b' })
    store.insertLive({ roomId: 3, roomName: 'C', liveTime: 200, liveKey: 'c' })

    assert.deepEqual(
      store.recent(3).map((r) => r.liveTime),
      [300, 200, 100],
    )
  } finally {
    store.close()
  }
})

test('新记录的 title / anchorName 默认为空', () => {
  const store = new LiveStore(':memory:')
  try {
    const record = store.insertLive({ roomId: 1, roomName: 'A', liveTime: 1000, liveKey: 'k' })
    assert.equal(record?.title, '')
    assert.equal(record?.anchorName, '')
  } finally {
    store.close()
  }
})

test('updateTitle 补写标题与主播名', () => {
  const store = new LiveStore(':memory:')
  try {
    const created = store.insertLive({ roomId: 1, roomName: 'A', liveTime: 1000, liveKey: 'k' })!
    const updated = store.updateTitle(created.id, '今天的标题', '主播甲')

    assert.equal(updated?.id, created.id)
    assert.equal(updated?.title, '今天的标题')
    assert.equal(updated?.anchorName, '主播甲')
    // 其它字段不受影响
    assert.equal(updated?.roomName, 'A')
    assert.equal(updated?.liveTime, 1000)
    // 落库后再查也一样
    assert.equal(store.lastLive(1)?.title, '今天的标题')
  } finally {
    store.close()
  }
})

test('updateTitle 更新不存在的 id 返回 null', () => {
  const store = new LiveStore(':memory:')
  try {
    assert.equal(store.updateTitle(999, 't', 'a'), null)
  } finally {
    store.close()
  }
})

test('旧库自动补上 title / anchor_name 列', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const file = join(mkdtempSync(join(tmpdir(), 'bls-migrate-')), 'old.db')

  // 造一个没有新列的旧库
  const legacy = new DatabaseSync(file)
  legacy.exec(`
    CREATE TABLE live_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER NOT NULL,
      room_name TEXT NOT NULL,
      live_time INTEGER NOT NULL,
      detected_at INTEGER NOT NULL,
      live_key TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `)
  legacy
    .prepare('INSERT INTO live_records (room_id, room_name, live_time, detected_at, live_key) VALUES (?,?,?,?,?)')
    .run(7, '老房间', 1000, 1000_000, 'old-key')
  legacy.close()

  // 打开后应自动迁移，且旧数据可读
  const store = new LiveStore(file)
  try {
    const record = store.lastLive(7)
    assert.equal(record?.roomName, '老房间')
    assert.equal(record?.title, '')
    assert.ok(store.updateTitle(record!.id, '补上的标题', '补上的主播'))
  } finally {
    store.close()
  }
})

