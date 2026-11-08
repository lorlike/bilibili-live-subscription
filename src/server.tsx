import type { AppConfig } from './config.ts'
import type { Context } from 'hono'
import type { RoomRepo } from './repo/rooms.ts'
import type { UserRepo } from './repo/users.ts'
import type { LiveStore } from './store.ts'
import type { JwtPayload } from './auth/jwt.ts'
import type { SubscriptionApp } from './app.ts'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { jsxRenderer } from 'hono/jsx-renderer'
import { signJwt, verifyJwt } from './auth/jwt.ts'
import { LoginRateLimiter } from './auth/rate-limit.ts'
import { LoginPage } from '../web/ssr/LoginPage.tsx'
import { RecordsPage } from '../web/ssr/RecordsPage.tsx'
import { RoomsPage } from '../web/ssr/RoomsPage.tsx'
import { UsersPage } from '../web/ssr/UsersPage.tsx'
import { Shell } from '../web/ssr/Layout.tsx'
import { describeError, logger } from './logger.ts'
import { dayRange, parseDate, todayRange } from './time.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 静态资源目录（构建产物） */
const PUBLIC_DIR = resolve(HERE, 'public')

const MIME: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

const COOKIE = 'bls_token'

export interface WebServerOptions {
  config: AppConfig
  store: LiveStore
  rooms: RoomRepo
  users: UserRepo
  app: SubscriptionApp | null
  port?: number
  host?: string
}

interface JwtVariables {
  jwtPayload: Record<string, unknown>
}

/**
 * 服务端渲染的 Web 界面。
 *
 * 页面由 hono/jsx 在服务端渲染成完整 HTML（无 index.html、无 SPA 打包），
 * 所有增删改都是普通表单 POST + 重定向，不需要客户端 JS。
 */
export class WebServer {
  private readonly options: WebServerOptions
  private readonly port: number
  private readonly host: string
  private readonly http: Hono<{ Variables: JwtVariables }>
  private server: { close: (cb: () => void) => void } | null = null
  private readonly limiter = new LoginRateLimiter({
    maxFailures: 5,
    windowMs: 5 * 60 * 1000,
    blockMs: 15 * 60 * 1000,
  })

  constructor(options: WebServerOptions) {
    this.options = options
    this.port = options.port ?? 3000
    this.host = options.host ?? '127.0.0.1'
    this.http = new Hono<{ Variables: JwtVariables }>()
    this.routes()
  }

  private get secret(): string {
    return this.options.config.jwtSecret
  }

  private async payloadOf(c: Context): Promise<JwtPayload | null> {
    const token = getCookie(c.req.header('cookie'), COOKIE)
    if (!token) return null
    return verifyJwt(token, this.secret)
  }

  private routes(): void {
    const app = this.http
    const { store, rooms, users } = this.options

    // ---------- 静态资源（只有 CSS） ----------
    app.get('/:file{.+\\.[a-z]+}', async (c) => {
      const name = c.req.param('file')
      const filePath = resolve(PUBLIC_DIR, name)

      if (!filePath.startsWith(`${PUBLIC_DIR}/`)) {
        return c.text('forbidden', 403)
      }

      try {
        const body = await readFile(filePath)
        const ext = name.slice(name.lastIndexOf('.'))
        return c.body(body, 200, {
          'content-type': MIME[ext] ?? 'application/octet-stream',
          'cache-control': 'no-cache',
        })
      } catch {
        return c.text('not found', 404)
      }
    })

    // ---------- 登录 ----------
    app.get('/login', (c) => c.render(<LoginPage />))

    app.post('/login', async (c) => {
      const clientKey = clientIp(c)
      this.limiter.sweep()

      const gate = this.limiter.check(clientKey)
      if (gate.blocked) {
        c.header('Retry-After', String(gate.retryAfter))
        c.status(429)
        return c.render(
          <LoginPage error={`尝试次数过多，请 ${gate.retryAfter} 秒后再试`} />,
        )
      }

      const body = await c.req.parseBody()
      const username = String(body.username ?? '').trim()
      const password = String(body.password ?? '')

      const user = await users.verify(username, password)
      if (!user) {
        const failed = this.limiter.recordFailure(clientKey)
        // 重新渲染登录页并带上错误，不重定向（保留用户输入的用户名）
        c.status(failed.blocked ? 429 : 401)
        if (failed.blocked) c.header('Retry-After', String(failed.retryAfter))
        return c.render(
          <LoginPage
            error={
              failed.blocked
                ? `尝试次数过多，请 ${failed.retryAfter} 秒后再试`
                : '用户名或密码错误'
            }
            username={username}
          />,
        )
      }

      this.limiter.recordSuccess(clientKey)

      const token = await signJwt(
        { sub: user.id, username: user.username },
        this.secret,
        this.options.config.jwtTtlHours * 3600,
      )

      c.header('set-cookie', buildCookie(COOKIE, token, this.options.config.jwtTtlHours * 3600))
      return c.redirect('/records', 303)
    })

    app.post('/logout', (c) => {
      c.header('set-cookie', buildCookie(COOKIE, '', 0))
      return c.redirect('/login', 303)
    })

    // ---------- 以下都需要登录 ----------
    const requireUser = async (c: Context): Promise<JwtPayload | Response> => {
      const payload = await this.payloadOf(c)
      if (payload) return payload
      return c.redirect('/login', 303)
    }

    /** JwtPayload → 页面需要的形状 */
    const asSessionUser = (payload: JwtPayload) => ({
      id: payload.sub,
      username: payload.username,
    })

    // ---------- 记录页 ----------
    app.get('/records', async (c) => {
      const user = await requireUser(c)
      if (user instanceof Response) return user

      const limit = 50
      const offset = Math.max(0, Number(c.req.query('offset') ?? 0) || 0)
      const dateParam = c.req.query('date') ?? todayRange().date
      const parsed = parseDate(dateParam)

      if (!parsed) {
        c.status(400)
        return c.render(
          <Shell user={asSessionUser(user)} view="records" date={dateParam}>
            <div class="empty">
              <span class="big">日期格式错误</span>
              <span>应为 YYYY-MM-DD</span>
            </div>
          </Shell>,
        )
      }

      const range = dayRange(parsed)
      const all = store.recordsBetween(range.start, range.end)
      const page = all.slice(offset, offset + limit)

      return c.render(
        <Shell user={asSessionUser(user)} view="records" date={range.date}>
          <RecordsPage
            records={page}
            total={all.length}
            date={range.date}
            limit={limit}
            offset={offset}
          />
        </Shell>,
      )
    })

    app.post('/records/:id/delete', async (c) => {
      const user = await requireUser(c)
      if (user instanceof Response) return user

      const id = Number(c.req.param('id'))
      if (Number.isInteger(id)) store.delete(id)

      return c.redirect(c.req.header('referer') ?? '/records', 303)
    })

    // ---------- 房间页 ----------
    app.get('/rooms', async (c) => {
      const user = await requireUser(c)
      if (user instanceof Response) return user

      return c.render(
        <Shell user={asSessionUser(user)} view="rooms">
          <RoomsPage {...this.roomsViewData()} />
        </Shell>,
      )
    })

    app.post('/rooms', async (c) => {
      const user = await requireUser(c)
      if (user instanceof Response) return user

      const body = await c.req.parseBody()
      const id = Number(String(body.id ?? '').trim())
      const name = String(body.name ?? '').trim()

      if (Number.isInteger(id) && id > 0 && !rooms.get(id)) {
        rooms.create({ id, name: name || null })
        // 同进程时立即让监听跟上
        void this.options.app?.sync()
      }

      return c.redirect('/rooms', 303)
    })

    app.post('/rooms/:id/update', async (c) => {
      const user = await requireUser(c)
      if (user instanceof Response) return user

      const id = Number(c.req.param('id'))
      const body = await c.req.parseBody()

      if (Number.isInteger(id)) {
        rooms.update(id, {
          name: String(body.name ?? '').trim() || null,
          note: String(body.note ?? ''),
        })
      }

      return c.redirect('/rooms', 303)
    })

    app.post('/rooms/:id/toggle', async (c) => {
      const user = await requireUser(c)
      if (user instanceof Response) return user

      const id = Number(c.req.param('id'))
      const room = Number.isInteger(id) ? rooms.get(id) : null

      if (room) {
        rooms.update(id, { enabled: !room.enabled })
        void this.options.app?.sync()
      }

      return c.redirect('/rooms', 303)
    })

    app.post('/rooms/:id/delete', async (c) => {
      const user = await requireUser(c)
      if (user instanceof Response) return user

      const id = Number(c.req.param('id'))
      if (Number.isInteger(id)) {
        rooms.delete(id)
        void this.options.app?.sync()
      }

      return c.redirect('/rooms', 303)
    })

    // ---------- 用户页 ----------
    app.get('/users', async (c) => {
      const user = await requireUser(c)
      if (user instanceof Response) return user

      return c.render(
        <Shell user={asSessionUser(user)} view="users">
          <UsersPage
            users={users.list()}
            currentUser={{ id: user.sub, username: user.username }}
          />
        </Shell>,
      )
    })

    app.post('/users', async (c) => {
      const user = await requireUser(c)
      if (user instanceof Response) return user

      const body = await c.req.parseBody()
      const username = String(body.username ?? '').trim()
      const password = String(body.password ?? '')

      if (username && password.length >= 8 && !users.findByUsername(username)) {
        await users.create(username, password)
      }

      return c.redirect('/users', 303)
    })

    app.post('/users/password', async (c) => {
      const user = await requireUser(c)
      if (user instanceof Response) return user

      const body = await c.req.parseBody()
      const current = String(body.current ?? '')
      const next = String(body.next ?? '')

      if (next.length >= 8) {
        const verified = await users.verify(user.username, current)
        if (verified) await users.updatePassword(user.sub, next)
      }

      return c.redirect('/users', 303)
    })

    // ---------- 兜底 ----------
    app.get('/', (c) => c.redirect('/records', 302))
    app.notFound((c) => c.text('not found', 404))
  }

  private roomsViewData() {
    const { store, rooms } = this.options
    const listening = new Set((this.options.app?.status() ?? []).map((s) => s.roomId))
    const summaries = new Map(store.roomSummaries().map((s) => [s.roomId, s]))

    const list = rooms.list().map((room) => {
      const summary = summaries.get(room.id)
      return {
        ...room,
        listening: listening.has(room.id),
        recordCount: summary?.count ?? 0,
        lastLive: summary?.lastLive ?? null,
      }
    })

    return { rooms: list, listeningCount: listening.size }
  }

  async listen(): Promise<number> {
    const { serve } = await import('@hono/node-server')

    return new Promise((resolveListen, rejectListen) => {
      const server = serve(
        { fetch: this.http.fetch, port: this.port, hostname: this.host },
        (info) => resolveListen(info.port),
      )

      this.server = server
      server.once('error', rejectListen)
    })
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = null
    if (server) await new Promise<void>((done) => server.close(() => done()))
  }
}

// ---------- 工具 ----------

/**
 * 客户端 IP。默认只信 X-Forwarded-For 的第一段；
 * 但只有显式设置 TRUST_PROXY=1 时才读它（否则任何人都能伪造该头绕过限流）。
 */
function clientIp(c: Context): string {
  if (process.env.TRUST_PROXY === '1') {
    const forwarded = c.req.header('x-forwarded-for')
    if (forwarded) return forwarded.split(',')[0]!.trim()
  }

  // @hono/node-server 会把 socket 地址放在 env 里
  const addr = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
    ?.incoming?.socket?.remoteAddress

  return addr ?? 'unknown'
}

function getCookie(header: string | undefined, name: string): string | null {
  if (!header) return null

  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return null
}

function buildCookie(name: string, value: string, maxAge: number): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ]
  if (process.env.COOKIE_SECURE === '1') parts.push('Secure')
  return parts.join('; ')
}

export { describeError, logger }
