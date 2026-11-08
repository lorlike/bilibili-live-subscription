import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LiveStore } from '../src/store.ts'
import { dayRange, parseDate, shiftDate, todayRange } from '../src/time.ts'

test('dayRange 覆盖本地时区整天，左闭右开', () => {
  const range = dayRange(new Date(2026, 10, 7))
  assert.equal(range.date, '2026-11-07')
  assert.equal(range.end - range.start, 24 * 3600)
  assert.equal(new Date(range.start * 1000).getDate(), 7)
  assert.equal(new Date(range.end * 1000).getDate(), 8)
})

test('parseDate 拒绝非法日期', () => {
  assert.ok(parseDate('2026-11-07'))
  assert.equal(parseDate('2026-13-01'), null)
  assert.equal(parseDate('2026-02-31'), null)
  assert.equal(parseDate('2026-1-7'), null)
  assert.equal(parseDate('today'), null)
})

test('shiftDate 跨月', () => {
  assert.equal(shiftDate(new Date(2026, 10, 1), -1).getMonth(), 9)
  assert.equal(shiftDate(new Date(2026, 11, 31), 1).getDate(), 1)
})

test('recordsBetween 只返回当天区间，按时间从新到旧', () => {
  const store = new LiveStore(':memory:')
  try {
    const range = dayRange(new Date(2026, 10, 7))
    store.insertLive({ roomId: 1, roomName: 'A', liveTime: range.start - 1, liveKey: 'before' })
    store.insertLive({ roomId: 1, roomName: 'A', liveTime: range.start, liveKey: 'first' })
    store.insertLive({ roomId: 2, roomName: 'B', liveTime: range.start + 500, liveKey: 'mid' })
    store.insertLive({ roomId: 1, roomName: 'A', liveTime: range.end - 1, liveKey: 'last' })
    store.insertLive({ roomId: 1, roomName: 'A', liveTime: range.end, liveKey: 'after' })

    const records = store.recordsBetween(range.start, range.end)
    assert.deepEqual(
      records.map((r) => r.liveKey),
      ['last', 'mid', 'first'],
    )
  } finally {
    store.close()
  }
})

test('recordsAfter 只返回游标之后的记录', () => {
  const store = new LiveStore(':memory:')
  try {
    const range = dayRange(new Date(2026, 10, 7))
    for (let i = 0; i < 5; i++) {
      store.insertLive({
        roomId: 1,
        roomName: 'A',
        liveTime: range.start + i * 100,
        liveKey: `k${i}`,
      })
    }

    // recordsAfter 按 id 升序做增量查询，与页面排序无关，
    // 这里用固定游标验证它本身的语义
    const all = store.recordsBetween(range.start, range.end)
    assert.equal(all.length, 5)

    const after = store.recordsAfter(2, range.start, range.end)
    assert.deepEqual(
      after.map((r) => r.liveKey),
      ['k2', 'k3', 'k4'],
    )

    const maxId = store.maxIdInRange(range.start, range.end)
    assert.equal(maxId, 5)
    assert.deepEqual(store.recordsAfter(maxId, range.start, range.end), [])
  } finally {
    store.close()
  }
})

test('maxIdInRange 返回区间内最大 id', () => {
  const store = new LiveStore(':memory:')
  try {
    const range = dayRange(new Date(2026, 10, 7))
    assert.equal(store.maxIdInRange(range.start, range.end), 0)

    store.insertLive({ roomId: 1, roomName: 'A', liveTime: range.start + 10, liveKey: 'a' })
    const second = store.insertLive({
      roomId: 1,
      roomName: 'A',
      liveTime: range.start + 20,
      liveKey: 'b',
    })
    store.insertLive({ roomId: 1, roomName: 'A', liveTime: range.start - 10, liveKey: 'outside' })

    assert.equal(store.maxIdInRange(range.start, range.end), second!.id)
  } finally {
    store.close()
  }
})

test('todayRange 与 dayRange(new Date()) 一致', () => {
  assert.deepEqual(todayRange(), dayRange(new Date()))
})
