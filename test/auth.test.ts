import assert from 'node:assert/strict'
import { test } from 'node:test'
import { signJwt, verifyJwt } from '../src/auth/jwt.ts'
import { hashPassword, verifyPassword } from '../src/repo/users.ts'

const SECRET = 'test-secret-key'

test('签发的 JWT 可以被校验', async () => {
  const token = await signJwt({ sub: 1, username: 'alice' }, SECRET, 60)
  const payload = await verifyJwt(token, SECRET)

  assert.ok(payload)
  assert.equal(payload.sub, 1)
  assert.equal(payload.username, 'alice')
})

test('密钥不对时校验失败', async () => {
  const token = await signJwt({ sub: 1, username: 'alice' }, SECRET, 60)
  assert.equal(await verifyJwt(token, 'other-secret'), null)
})

test('过期的 token 校验失败', async () => {
  // ttl = -1 表示立即过期
  const token = await signJwt({ sub: 1, username: 'alice' }, SECRET, -1)
  assert.equal(await verifyJwt(token, SECRET), null)
})

test('篡改 payload 会导致签名校验失败', async () => {
  const token = await signJwt({ sub: 1, username: 'alice' }, SECRET, 60)
  const [header, , signature] = token.split('.')

  const forgedBody = Buffer.from(
    JSON.stringify({ sub: 999, username: 'admin', iat: 0, exp: 9_999_999_999 }),
  ).toString('base64url')

  assert.equal(await verifyJwt(`${header}.${forgedBody}.${signature}`, SECRET), null)
})

test('格式错误的 token 返回 null', async () => {
  for (const bad of ['', 'a', 'a.b', 'a.b.c.d', '....']) {
    assert.equal(await verifyJwt(bad, SECRET), null, JSON.stringify(bad))
  }
})

test('密码哈希可验证，错误密码不通过', async () => {
  const hash = await hashPassword('correct-horse')

  assert.match(hash, /^scrypt\$[0-9a-f]+\$[0-9a-f]+$/)
  assert.equal(await verifyPassword('correct-horse', hash), true)
  assert.equal(await verifyPassword('wrong', hash), false)
})

test('相同密码每次哈希都不同（盐随机）', async () => {
  const a = await hashPassword('same-password')
  const b = await hashPassword('same-password')

  assert.notEqual(a, b)
  assert.equal(await verifyPassword('same-password', a), true)
  assert.equal(await verifyPassword('same-password', b), true)
})

test('损坏的哈希格式不会抛异常', async () => {
  for (const bad of ['', 'plain', 'scrypt$x', 'bcrypt$aa$bb']) {
    assert.equal(await verifyPassword('anything', bad), false, JSON.stringify(bad))
  }
})
