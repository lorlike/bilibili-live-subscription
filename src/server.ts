import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AppConfig } from './config.ts'
import type { LiveRecord } from './store.ts'
import { createReadStream, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeError, logger } from './logger.ts'
import { loadRooms } from './rooms.ts'
import { dayRange, parseDate, todayRange } from './time.ts'
import { LiveStore } from './store.ts'

const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url))

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

export interface WebServerOptions {
  config: AppConfig
  port?: number
  host?: string
}

interface SseClient {
  res: ServerResponse
  date: string
  cursor: number
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(payload)
}

export class WebServer {
  private readonly config: AppConfig
  private readonly port: number
  private readonly host: string
  private readonly store: LiveStore
  private readonly clients = new Set<SseClient>()
  private timer: NodeJS.Timeout | null = null
  private server: ReturnType<typeof createServer> | null = null

  constructor(options: WebServerOptions) {
    this.config = options.config
    this.port = options.port ?? 3000
    this.host = options.host ?? '127.0.0.1'
    // 独立连接，避免与监听进程共用同一个 DatabaseSync 实例
    this.store = new LiveStore(this.config.dbPath)
  }

  async listen(): Promise<number> {
    const server = createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        logger.error(`HTTP 处理失败: ${describeError(error)}`)
        if (!res.headersSent) sendJson(res, 500, { error: 'internal error' })
        else res.end()
      })
    })

    this.server = server

    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(this.port, this.host, () => {
        server.off('error', rejectListen)
        resolveListen()
      })
    })

    const address = server.address()
    const actualPort = typeof address === 'object' && address ? address.port : this.port

    // 定时轮询兜底：即使没有走 publish 路径，也能把新记录推给前端
    this.timer = setInterval(() => this.poll(), 2000)

    return actualPort
  }

  /**
   * 监听进程写入新记录后调用，立即推送给前端。
   * 同一 id 可能被推送多次（先落库、后补全标题），前端按 id 覆盖即可。
   */
  publish(record: LiveRecord): void {
    for (const client of this.clients) {
      const range = this.rangeFor(client.date)
      if (!range) continue
      if (record.liveTime < range.start || record.liveTime >= range.end) continue

      // 游标只前进不后退；已见过的 id 也照常推送，用于覆盖补全后的字段
      if (record.id > client.cursor) client.cursor = record.id
      this.writeEvent(client, 'record', record)
    }
  }

  /** 供 CLI 使用：不挂载监听，仅提供只读接口时也能刷新 */
  private poll(): void {
    if (this.clients.size === 0) return

    for (const client of this.clients) {
      const range = this.rangeFor(client.date)
      if (!range) continue

      try {
        const fresh = this.store.recordsAfter(client.cursor, range.start, range.end)
        for (const record of fresh) {
          client.cursor = record.id
          this.writeEvent(client, 'record', record)
        }
      } catch (error) {
        logger.error(`轮询数据库失败: ${describeError(error)}`)
      }
    }
  }

  private rangeFor(date: string) {
    const parsed = parseDate(date)
    return parsed ? dayRange(parsed) : null
  }

  private writeEvent(client: SseClient, event: string, data: unknown): void {
    try {
      client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    } catch {
      this.clients.delete(client)
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }

    switch (url.pathname) {
      case '/':
        this.serveStatic(res, 'index.html')
        return
      case '/api/records':
        this.handleRecords(url, res)
        return
      case '/api/stream':
        this.handleStream(url, res)
        return
      case '/api/meta':
        this.handleMeta(url, res)
        return
      case '/api/rooms':
        this.handleRooms(res)
        return
      default:
        if (url.pathname.startsWith('/api/')) {
          sendJson(res, 404, { error: 'not found' })
          return
        }
        this.serveStatic(res, url.pathname.slice(1))
    }
  }

  private handleRecords(url: URL, res: ServerResponse): void {
    const dateParam = url.searchParams.get('date') ?? todayRange().date
    const parsed = parseDate(dateParam)

    if (!parsed) {
      sendJson(res, 400, { error: 'date 格式应为 YYYY-MM-DD' })
      return
    }

    const range = dayRange(parsed)
    const records = this.store.recordsBetween(range.start, range.end)

    sendJson(res, 200, {
      date: range.date,
      start: range.start,
      end: range.end,
      total: records.length,
      rooms: new Set(records.map((r) => r.roomId)).size,
      records,
    })
  }

  private handleMeta(url: URL, res: ServerResponse): void {
    const dateParam = url.searchParams.get('date') ?? todayRange().date
    const parsed = parseDate(dateParam)

    if (!parsed) {
      sendJson(res, 400, { error: 'date 格式应为 YYYY-MM-DD' })
      return
    }

    const range = dayRange(parsed)
    sendJson(res, 200, {
      date: range.date,
      total: this.store.recordsBetween(range.start, range.end).length,
      all: this.store.count(),
    })
  }

  /**
   * 房间清单：清单里的每个房间 + 监听中记录的统计数据。
   * 清单读取失败时（例如文件被改坏）只返回错误，不影响历史记录页面。
   */
  private handleRooms(res: ServerResponse): void {
    let listed
    try {
      listed = loadRooms(this.config.roomsFile)
    } catch (error) {
      sendJson(res, 500, {
        error: describeError(error),
        roomsFile: this.config.roomsFile,
      })
      return
    }

    const summaries = new Map(this.store.roomSummaries().map((s) => [s.roomId, s]))

    const rooms = listed.map((room) => {
      const summary = summaries.get(room.id)
      return {
        id: room.id,
        name: room.name,
        enabled: room.enabled,
        recordCount: summary?.count ?? 0,
        lastLive: summary?.lastLive ?? null,
        firstLive: summary?.firstLive ?? null,
      }
    })

    // 有记录但已不在清单里的房间（比如被删掉了），单独列出以免数据"消失"
    const listedIds = new Set(listed.map((room) => room.id))
    const orphaned = [...summaries.values()]
      .filter((summary) => !listedIds.has(summary.roomId))
      .map((summary) => {
        const last = this.store.lastLive(summary.roomId)
        return {
          id: summary.roomId,
          name: last?.roomName ?? '',
          enabled: false,
          recordCount: summary.count,
          lastLive: summary.lastLive,
          firstLive: summary.firstLive,
          orphaned: true,
        }
      })
      .sort((a, b) => b.lastLive - a.lastLive)

    sendJson(res, 200, {
      roomsFile: this.config.roomsFile,
      total: rooms.length,
      enabled: rooms.filter((room) => room.enabled).length,
      records: this.store.count(),
      rooms,
      orphaned,
    })
  }

  private handleStream(url: URL, res: ServerResponse): void {
    const dateParam = url.searchParams.get('date') ?? todayRange().date
    const parsed = parseDate(dateParam)

    if (!parsed) {
      sendJson(res, 400, { error: 'date 格式应为 YYYY-MM-DD' })
      return
    }

    const range = dayRange(parsed)

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })

    res.write(`retry: 3000\n\n`)

    const client: SseClient = {
      res,
      date: range.date,
      cursor: this.store.maxIdInRange(range.start, range.end),
    }

    this.clients.add(client)
    this.writeEvent(client, 'ready', { date: range.date, cursor: client.cursor })

    // 客户端断开
    res.on('close', () => {
      this.clients.delete(client)
    })
  }

  private serveStatic(res: ServerResponse, relativePath: string): void {
    const safe = normalize(relativePath).replace(/^(\.\.[/\\])+/, '')
    const filePath = join(PUBLIC_DIR, safe)

    if (!filePath.startsWith(PUBLIC_DIR)) {
      sendJson(res, 403, { error: 'forbidden' })
      return
    }

    let size: number
    try {
      const stat = statSync(filePath)
      if (!stat.isFile()) throw new Error('not a file')
      size = stat.size
    } catch {
      sendJson(res, 404, { error: 'not found' })
      return
    }

    res.writeHead(200, {
      'content-type': MIME[extname(filePath)] ?? 'application/octet-stream',
      'content-length': size,
      'cache-control': 'no-cache',
    })

    // 小文件直接读，省一次流式开销
    if (size < 64 * 1024) {
      res.end(readFileSync(filePath))
      return
    }

    createReadStream(filePath).pipe(res)
  }

  async close(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }

    for (const client of this.clients) {
      try {
        client.res.end()
      } catch {
        // ignore
      }
    }
    this.clients.clear()

    this.store.close()

    const server = this.server
    this.server = null
    if (server) {
      await new Promise<void>((done) => server.close(() => done()))
    }
  }
}

export function resolvePublicPath(...segments: string[]): string {
  return resolve(PUBLIC_DIR, ...segments)
}
