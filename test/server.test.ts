import type { AppConfig } from '../src/config.ts'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { RoomRepo } from '../src/repo/rooms.ts'
import { UserRepo } from '../src/repo/users.ts'
import { WebServer } from '../src/server.tsx'
import { LiveStore } from '../src/store.ts'
import { dayRange } from '../src/time.ts'

const dir = mkdtempSync(join(tmpdir(), 'bls-ssr-'))
const dbPath = join(dir, 'test.db')

const config: AppConfig = {
  cookie: '',
  uid: 0,
  dbPath,
  retentionDays: 0,
  webHost: '127.0.0.1',
  webPort: 0,
  reconnectTime: 5000,
  heartbeatTime: 30000,
  logLevel: 'error',
  jwtSecret: 'test-secret',
  jwtTtlHours: 24,
  webOnly: true,
  syncIntervalMs: 0,
}

let server: WebServer
let store: LiveStore
let rooms: RoomRepo
let users: UserRepo
let base = ''
let cookie = ''

before(async () => {
  store = new LiveStore(dbPath)
  rooms = new RoomRepo(store.db)
  users = new UserRepo(store.db)
  await users.create('tester', 'password123')

  server = new WebServer({ config, store, rooms, users, app: null, port: 0, host: '127.0.0.1' })
  const port = await server.listen()
  base = `http://127.0.0.1:${port}`

  const res = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'username=tester&password=password123',
    redirect: 'manual',
  })

  assert.equal(res.status, 303)
  cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!
})

after(async () => {
  await server.close()
  store.close()
})

/** 带登录态的 GET，不自动跟随重定向 */
function get(path: string, withAuth = true): Promise<Response> {
  return fetch(`${base}${path}`, {
    headers: withAuth ? { cookie } : {},
    redirect: 'manual',
  })
}

/** 表单 POST */
function post(path: string, fields: Record<string, string>, withAuth = true): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(withAuth ? { cookie } : {}),
    },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  })
}

// ---------- 服务端渲染 ----------

test('登录页由服务端渲染成完整 HTML', async () => {
  const res = await get('/login', false)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') ?? '', /text\/html/)

  const html = await res.text()
  assert.match(html, /<form class="login"/)
  assert.match(html, /name="username"/)
  assert.match(html, /name="password"/)
  // 是完整文档，不是挂载点
  assert.match(html, /^<!DOCTYPE html>|<html/i)
  assert.doesNotMatch(html, /id="root"/)
})

test('/ 重定向到 /records', async () => {
  const res = await get('/', false)
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), '/records')
})

test('CSS 可访问，目录穿越被拒绝', async () => {
  assert.equal((await get('/style.css', false)).status, 200)

  const escaped = await get('/../package.json', false)
  assert.notEqual(escaped.status, 200)
})

// ---------- 鉴权 ----------

test('未登录访问页面会被重定向到 /login', async () => {
  for (const path of ['/records', '/rooms', '/users']) {
    const res = await get(path, false)
    assert.equal(res.status, 303, path)
    assert.equal(res.headers.get('location'), '/login', path)
  }
})

test('密码错误时返回 401 并重新渲染登录页', async () => {
  const res = await post('/login', { username: 'tester', password: 'wrong' }, false)
  assert.equal(res.status, 401)

  const html = await res.text()
  assert.match(html, /用户名或密码错误/)
  // 保留用户输入的用户名
  assert.match(html, /value="tester"/)
})

test('用户不存在与密码错误返回相同响应，不泄漏用户是否存在', async () => {
  const wrongPass = await post('/login', { username: 'tester', password: 'x' }, false)
  const noUser = await post('/login', { username: 'ghost', password: 'x' }, false)

  assert.equal(wrongPass.status, 401)
  assert.equal(noUser.status, 401)

  const a = await wrongPass.text()
  const b = await noUser.text()
  // 只有回填的用户名不同，错误文案要一致
  assert.match(a, /用户名或密码错误/)
  assert.match(b, /用户名或密码错误/)
})

test('伪造的 token 无效', async () => {
  const res = await fetch(`${base}/records`, {
    headers: { cookie: 'bls_token=forged.value' },
    redirect: 'manual',
  })
  assert.equal(res.status, 303)
  assert.equal(res.headers.get('location'), '/login')
})

test('登出清空 cookie 并跳回登录页', async () => {
  const res = await post('/logout', {})
  assert.equal(res.status, 303)
  assert.equal(res.headers.get('location'), '/login')

  const setCookie = res.headers.get('set-cookie') ?? ''
  assert.match(setCookie, /bls_token=;/)
  assert.match(setCookie, /Max-Age=0/)
})

// ---------- 记录页 ----------

test('记录页渲染出当天记录，用 details 实现展开', async () => {
  const range = dayRange(new Date(2026, 11, 25))
  for (let i = 0; i < 3; i++) {
    const record = store.insertLive({
      roomId: 1,
      roomName: '测试房间',
      liveTime: range.start + i * 100,
      liveKey: `k${i}`,
    })
    if (record) store.updateTitle(record.id, `标题${i}`, '主播名')
  }

  const res = await get('/records?date=2026-12-25')
  assert.equal(res.status, 200)

  const html = await res.text()
  assert.match(html, /<details class="row rec-row"/)
  assert.match(html, /测试房间/)
  assert.match(html, /1–3 \/ 3/)
  assert.match(html, /标题0/)
})

test('日期格式错误时返回 400', async () => {
  const res = await get('/records?date=nope')
  assert.equal(res.status, 400)
  assert.match(await res.text(), /日期格式错误/)
})

test('可以删除单条记录', async () => {
  const record = store.insertLive({
    roomId: 2,
    roomName: 'B',
    liveTime: Math.floor(Date.now() / 1000),
    liveKey: 'del-me',
  })!

  const res = await post(`/records/${record.id}/delete`, {})
  assert.equal(res.status, 303)
  assert.equal(store.get(record.id), null)
})

// ---------- 房间 CRUD ----------

test('添加房间后出现在列表里', async () => {
  const res = await post('/rooms', { id: '652581', name: '新增房间' })
  assert.equal(res.status, 303)
  assert.equal(res.headers.get('location'), '/rooms')

  const html = await (await get('/rooms')).text()
  assert.match(html, /新增房间/)
  assert.match(html, /#652581/)
})

test('重复房间号不会重复创建', async () => {
  await post('/rooms', { id: '777' })
  await post('/rooms', { id: '777', name: '第二次' })

  assert.equal(rooms.get(777)?.name, null)
})

test('房间号非法时忽略', async () => {
  for (const id of ['0', '-1', 'abc', '']) {
    await post('/rooms', { id })
  }
  assert.equal(rooms.list().filter((r) => r.id <= 0).length, 0)
})

test('可以更新房间名与备注', async () => {
  await post('/rooms', { id: '888' })
  await post('/rooms/888/update', { name: '改过的名字', note: '备注内容' })

  const room = rooms.get(888)
  assert.equal(room?.name, '改过的名字')
  assert.equal(room?.note, '备注内容')
})

test('可以切换启用状态', async () => {
  await post('/rooms', { id: '999' })
  assert.equal(rooms.get(999)?.enabled, true)

  await post('/rooms/999/toggle', {})
  assert.equal(rooms.get(999)?.enabled, false)

  await post('/rooms/999/toggle', {})
  assert.equal(rooms.get(999)?.enabled, true)
})

test('可以删除房间', async () => {
  await post('/rooms', { id: '1234' })
  await post('/rooms/1234/delete', {})
  assert.equal(rooms.get(1234), null)
})

// ---------- 用户管理 ----------

test('可以新建用户，重复用户名被忽略', async () => {
  await post('/users', { username: 'second', password: 'password123' })
  assert.ok(users.findByUsername('second'))

  await post('/users', { username: 'second', password: 'other12345' })
  // 仍是最初那个（密码没被覆盖）：用原密码能验证通过
  assert.ok(await users.verify('second', 'password123'))
})

test('密码太短时不会创建用户', async () => {
  await post('/users', { username: 'shortpw', password: '123' })
  assert.equal(users.findByUsername('shortpw'), null)
})

test('改密码需要校验当前密码', async () => {
  await post('/users/password', { current: 'wrong', next: 'newpassword123' })
  // 旧密码仍然有效
  assert.ok(await users.verify('tester', 'password123'))

  await post('/users/password', { current: 'password123', next: 'newpassword123' })
  assert.ok(await users.verify('tester', 'newpassword123'))
})
