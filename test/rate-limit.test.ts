import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LoginRateLimiter } from '../src/auth/rate-limit.ts'

const make = () =>
  new LoginRateLimiter({ maxFailures: 3, windowMs: 60_000, blockMs: 120_000 })

test('初始状态不锁定', () => {
  const limiter = make()
  assert.deepEqual(limiter.check('1.2.3.4'), { blocked: false, retryAfter: 0 })
})

test('达到阈值后锁定', () => {
  const limiter = make()

  assert.equal(limiter.recordFailure('a').blocked, false)
  assert.equal(limiter.recordFailure('a').blocked, false)
  const third = limiter.recordFailure('a')

  assert.equal(third.blocked, true)
  assert.equal(third.retryAfter, 120)

  const check = limiter.check('a')
  assert.equal(check.blocked, true)
  assert.ok(check.retryAfter > 0 && check.retryAfter <= 120)
})

test('锁定后不再累加失败次数', () => {
  const limiter = make()
  for (let i = 0; i < 3; i++) limiter.recordFailure('a')

  // 被锁定时后续的失败不会把 blockedUntil 无限往后推
  const before = limiter.check('a').retryAfter
  limiter.recordFailure('a')
  const after = limiter.check('a').retryAfter
  assert.ok(after <= before)
})

test('不同 IP 互不影响', () => {
  const limiter = make()
  for (let i = 0; i < 3; i++) limiter.recordFailure('a')

  assert.equal(limiter.check('a').blocked, true)
  assert.equal(limiter.check('b').blocked, false)
})

test('登录成功会清掉计数', () => {
  const limiter = make()
  limiter.recordFailure('a')
  limiter.recordFailure('a')
  limiter.recordSuccess('a')

  assert.equal(limiter.check('a').blocked, false)
  // 成功后重新开始计数
  assert.equal(limiter.recordFailure('a').blocked, false)
})

test('sweep 不会误删仍在锁定的条目', () => {
  const limiter = make()
  for (let i = 0; i < 3; i++) limiter.recordFailure('a')

  limiter.sweep()
  assert.equal(limiter.check('a').blocked, true)
})
