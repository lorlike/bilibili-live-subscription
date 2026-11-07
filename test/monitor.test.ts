import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LIVE, Message } from 'tiny-bilibili-ws'
import { parseLiveMessage } from '../src/monitor.ts'

const room = { id: 123, name: '测试直播间', enabled: true }

function message(data: Partial<LIVE>): Message<LIVE> {
  return {
    meta: {
      op: 5,
      ver: 0,
      packetLength: 0,
      headerLength: 16,
      sequence: 1,
    },
    data: data as LIVE,
  }
}

test('解析正常的 LIVE 消息', () => {
  const detail = parseLiveMessage(
    message({ cmd: 'LIVE', live_time: 1730000000, live_key: 'abc', roomid: 123 }),
    room,
  )

  assert.deepEqual(detail, {
    roomId: 123,
    roomName: '测试直播间',
    liveTime: 1730000000,
    liveKey: 'abc',
  })
})

test('live_time 缺失时返回 null', () => {
  assert.equal(parseLiveMessage(message({ cmd: 'LIVE', roomid: 123 }), room), null)
})

test('live_time 为 0 时返回 null', () => {
  assert.equal(parseLiveMessage(message({ cmd: 'LIVE', live_time: 0, roomid: 123 }), room), null)
})

test('缺少 live_key 时使用空字符串', () => {
  const detail = parseLiveMessage(message({ cmd: 'LIVE', live_time: 1730000000 }), room)
  assert.equal(detail?.liveKey, '')
})

test('以清单中的房间号为准，忽略推送的房间号', () => {
  const detail = parseLiveMessage(
    message({ cmd: 'LIVE', live_time: 1730000000, roomid: 999999 }),
    room,
  )
  assert.equal(detail?.roomId, 123)
})

test('message 为 undefined 时返回 null', () => {
  assert.equal(parseLiveMessage(undefined, room), null)
})
