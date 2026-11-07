import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fetchRoomInfo, fetchRoomsInfo } from '../src/bilibili.ts'

/** 这些用例会访问 B 站公开接口，网络不通时跳过而不是失败 */
async function networkAvailable(): Promise<boolean> {
  try {
    await fetch('https://api.live.bilibili.com/room/v1/Room/get_info?room_id=6', {
      signal: AbortSignal.timeout(5000),
    })
    return true
  } catch {
    return false
  }
}

const online = await networkAvailable()

test('房间号非法时直接报错（不请求网络）', async () => {
  await assert.rejects(() => fetchRoomInfo(0), /房间号无效/)
  await assert.rejects(() => fetchRoomInfo(-1), /房间号无效/)
  await assert.rejects(() => fetchRoomInfo(1.5), /房间号无效/)
})

test('不存在的房间号抛错', { skip: !online && '网络不可用' }, async () => {
  await assert.rejects(() => fetchRoomInfo(999999999), /未找到该房间|code=/)
})

test('拿到标题与主播名（6 号房）', { skip: !online && '网络不可用' }, async () => {
  const info = await fetchRoomInfo(6)

  assert.equal(info.roomId, 7734200)
  assert.equal(info.shortId, 6)
  assert.ok(info.title.length > 0, '标题不应为空')
  assert.ok(info.anchorName && info.anchorName.length > 0, '主播名不应为空')
  assert.ok(info.anchorUid > 0)
  assert.ok([0, 1].includes(info.liveStatus))
})

test('短号与长号查到同一个房间', { skip: !online && '网络不可用' }, async () => {
  const [short, long] = await Promise.all([fetchRoomInfo(6), fetchRoomInfo(7734200)])

  assert.equal(short.roomId, long.roomId)
  assert.equal(short.title, long.title)
  assert.equal(short.anchorName, long.anchorName)
})

test('开播中时 liveTime 是合理的 Unix 秒', { skip: !online && '网络不可用' }, async () => {
  const info = await fetchRoomInfo(6)
  if (info.liveStatus !== 1) return

  // 允许时钟偏差，但必须是 2020 年之后、且不大于当前时间太多
  const now = Math.floor(Date.now() / 1000)
  assert.ok(info.liveTime > 1_577_836_800, `liveTime 过小: ${info.liveTime}`)
  assert.ok(info.liveTime <= now + 300, `liveTime 在未来: ${info.liveTime}`)
})

test('批量查询：失败项不影响其它项', { skip: !online && '网络不可用' }, async () => {
  const results = await fetchRoomsInfo([6, 999999999], { concurrency: 2 })

  assert.equal(results.length, 2)
  assert.equal(results[0]!.error, null)
  assert.equal(results[0]!.info?.shortId, 6)
  assert.equal(results[1]!.info, null)
  assert.ok(results[1]!.error)
})
