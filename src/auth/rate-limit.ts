/**
 * 简单的登录失败限流（进程内）。
 *
 * 直接对公网暴露时，scrypt 每次校验约 60ms，
 * 没有限制的话既能被暴力破解，也容易被打满 CPU。
 *
 * 注意：这是单进程内存态，重启即清零；多副本部署要换成 Redis。
 */
export interface RateLimiterOptions {
  /** 窗口内允许的最大失败次数 */
  maxFailures: number
  /** 窗口长度（毫秒） */
  windowMs: number
  /** 触发后的锁定时长（毫秒） */
  blockMs: number
}

interface Entry {
  failures: number
  firstFailureAt: number
  blockedUntil: number
}

export class LoginRateLimiter {
  private readonly entries = new Map<string, Entry>()
  private readonly options: RateLimiterOptions
  private lastSweep = Date.now()

  constructor(options: RateLimiterOptions) {
    this.options = options
  }

  /** 当前是否被锁定，以及还需等待多少秒 */
  check(key: string): { blocked: boolean; retryAfter: number } {
    const now = Date.now()
    const entry = this.entries.get(key)

    if (!entry) return { blocked: false, retryAfter: 0 }

    if (entry.blockedUntil > now) {
      return { blocked: true, retryAfter: Math.ceil((entry.blockedUntil - now) / 1000) }
    }

    // 窗口过期，重置
    if (now - entry.firstFailureAt > this.options.windowMs) {
      this.entries.delete(key)
    }

    return { blocked: false, retryAfter: 0 }
  }

  /** 记录一次失败，返回本次是否触发了锁定 */
  recordFailure(key: string): { blocked: boolean; retryAfter: number } {
    const now = Date.now()
    let entry = this.entries.get(key)

    if (!entry || now - entry.firstFailureAt > this.options.windowMs) {
      entry = { failures: 0, firstFailureAt: now, blockedUntil: 0 }
      this.entries.set(key, entry)
    }

    entry.failures += 1

    if (entry.failures >= this.options.maxFailures) {
      entry.blockedUntil = now + this.options.blockMs
      return { blocked: true, retryAfter: Math.ceil(this.options.blockMs / 1000) }
    }

    return { blocked: false, retryAfter: 0 }
  }

  /** 登录成功后清掉计数 */
  recordSuccess(key: string): void {
    this.entries.delete(key)
  }

  /** 惰性清理，避免长期运行内存无限增长 */
  sweep(): void {
    const now = Date.now()
    if (now - this.lastSweep < 60_000) return
    this.lastSweep = now

    for (const [key, entry] of this.entries) {
      if (
        entry.blockedUntil < now &&
        now - entry.firstFailureAt > this.options.windowMs + this.options.blockMs
      ) {
        this.entries.delete(key)
      }
    }
  }
}
