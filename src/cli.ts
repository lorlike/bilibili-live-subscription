#!/usr/bin/env node
import process from 'node:process'
import { SubscriptionApp } from './app.ts'
import { config } from './config.ts'
import { describeError, logger } from './logger.ts'
import { RoomRepo } from './repo/rooms.ts'
import { UserRepo } from './repo/users.ts'
import { WebServer } from './server.tsx'
import { LiveStore } from './store.ts'

function usage(): void {
  console.log(`bilibili-live-subscription

用法:
  pnpm dev                  启动完整服务（Web + 监听，同一个进程）
  pnpm start                同上，但按生产模式跑（cookie 加 Secure）
  pnpm build                构建前端（改过 web/ 后必须跑）

分开跑（可选，用于独立重启其中一方）:
  WEB_ONLY=1 pnpm web       只启动 Web
  pnpm listen               只启动监听（无端口）

注：pnpm web 与 pnpm dev 等价，都包含监听。

管理:
  pnpm user:add <用户名> <密码>   创建用户（首次需手动建一个）
  pnpm user:list                  列出用户

只读命令:
  pnpm list [n]             查看最近的开播记录
  pnpm today                查看今天的开播记录
  pnpm info [房间号...]      查询直播间的标题与主播名
  pnpm rooms                列出数据库里的房间

构建:
  pnpm build                构建前端
  pnpm typecheck            类型检查
  pnpm test                 单元测试

环境变量见 .env.example
`)
}

function open(): { store: LiveStore; rooms: RoomRepo; users: UserRepo } {
  const store = new LiveStore(config.dbPath)
  return {
    store,
    rooms: new RoomRepo(store.db),
    users: new UserRepo(store.db),
  }
}

// ---------- 只读命令 ----------

function runList(): void {
  const { store } = open()
  try {
    const limit = clampInt(process.argv[3], 1, 500, 20)
    const records = store.recent(limit)

    if (records.length === 0) {
      console.log('暂无开播记录')
      return
    }

    for (const record of records) {
      const d = new Date(record.liveTime * 1000)
      const time = d.toLocaleString('zh-CN', { hour12: false })
      console.log(`#${String(record.id).padStart(4, '0')}  ${time}  ${record.roomName}(${record.roomId})`)
    }
  } finally {
    store.close()
  }
}

function runToday(): void {
  const { store } = open()
  try {
    const now = new Date()
    const start = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000)
    const records = store.recordsBetween(start, start + 86400)

    console.log(`── ${now.toISOString().slice(0, 10)} ──`)
    if (records.length === 0) {
      console.log('今天还没有开播记录')
      return
    }

    for (const record of records) {
      const d = new Date(record.liveTime * 1000)
      const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      const title = record.title ? `  ${record.title}` : ''
      console.log(`${time}  ▶  ${record.roomName}  #${record.roomId}${title}`)
    }

    console.log(`\n共 ${records.length} 条`)
  } finally {
    store.close()
  }
}

function runRooms(): void {
  const { store, rooms } = open()
  try {
    const list = rooms.list()
    console.log(`数据库中的房间（共 ${list.length} 个）`)
    for (const room of list) {
      const flags = [room.enabled ? '启用' : '禁用'].join(' ')
      console.log(`- ${room.name ?? room.anchorName ?? '(未取名)'}(${room.id}) [${flags}]`)
    }
  } finally {
    store.close()
  }
}

async function runInfo(): Promise<void> {
  const { fetchRoomsInfo } = await import('./bilibili.ts')
  const ids = process.argv
    .slice(3)
    .flatMap((arg) => arg.split(','))
    .map((arg) => Number(arg.trim()))
    .filter((id) => Number.isInteger(id) && id > 0)

  if (ids.length === 0) {
    const { store, rooms } = open()
    try {
      ids.push(...rooms.list().map((room) => room.id))
    } finally {
      store.close()
    }
  }

  if (ids.length === 0) {
    console.log('用法: pnpm info <房间号> [房间号...]')
    return
  }

  const results = await fetchRoomsInfo(ids, { cookie: config.cookie })
  const pad = (text: string, width: number) => text + ' '.repeat(Math.max(0, width - [...text].length))

  console.log(`${pad('房间号', 12)}${pad('主播', 22)}${pad('状态', 8)}标题`)
  console.log('─'.repeat(96))

  for (const { roomId, info, error } of results) {
    if (error || !info) {
      console.log(`${pad(String(roomId), 12)}${pad('—', 22)}${pad('查询失败', 8)}${error ?? '未知错误'}`)
      continue
    }

    const status = info.liveStatus === 1 ? '直播中' : '未开播'
    console.log(
      `${pad(String(info.roomId), 12)}${pad(info.anchorName ?? '—', 22)}${pad(status, 8)}${info.title || '（无标题）'}`,
    )
  }
}

// ---------- 用户管理 ----------

async function runUserAdd(): Promise<void> {
  const [, , , username, password] = process.argv

  if (!username || !password) {
    console.error('用法: pnpm user:add <用户名> <密码>')
    process.exit(1)
  }
  if (password.length < 8) {
    console.error('密码至少 8 位')
    process.exit(1)
  }

  const { store, users } = open()
  try {
    if (users.findByUsername(username)) {
      console.error(`用户 ${username} 已存在`)
      process.exit(1)
    }

    const user = await users.create(username, password)
    console.log(`已创建用户 ${user.username}（id=${user.id}）`)
  } finally {
    store.close()
  }
}

function runUserList(): void {
  const { store, users } = open()
  try {
    const list = users.list()
    if (list.length === 0) {
      console.log('还没有用户。用 pnpm user:add <用户名> <密码> 创建一个')
      return
    }
    for (const user of list) {
      console.log(`- ${user.username}（id=${user.id}）`)
    }
  } finally {
    store.close()
  }
}

// ---------- 服务 ----------

/** 首次启动且没有用户时，随机生成一个管理员密码并打印（避免裸奔） */
async function ensureFirstUser(users: UserRepo): Promise<void> {
  if (users.count() > 0) return

  const { randomBytes } = await import('node:crypto')
  const password = randomBytes(9).toString('base64url')

  await users.create('admin', password)

  // 必须无条件输出：LOG_LEVEL=error 时 logger.warn 会被过滤，
  // 那样用户永远拿不到初始密码、也登不进系统。
  console.error(
    [
      '[bls] 首次启动：已创建管理员账号',
      '  用户名: admin',
      `  密码:   ${password}`,
      '  请登录后立即修改密码（或用 pnpm user:add 另建账号后删除它）',
    ].join('\n'),
  )
}

async function runWeb(): Promise<void> {
  const { store, rooms, users } = open()
  await ensureFirstUser(users)

  // WEB_ONLY=1 时纯 Web，不启动监听（分进程部署）
  const app = config.webOnly
    ? null
    : new SubscriptionApp({
        config,
        store,
        rooms,
        syncIntervalMs: config.syncIntervalMs,
      })

  const server = new WebServer({
    config,
    store,
    rooms,
    users,
    app,
    port: config.webPort,
    host: config.webHost,
  })

  const port = await server.listen()
  logger.info(`Web 界面: http://${config.webHost}:${port}`)

  if (app) {
    await app.start()
  } else {
    logger.info('纯 Web 模式（WEB_ONLY=1），不启动监听')
  }

  const shutdown = async (signal: string) => {
    logger.info(`收到 ${signal}，正在停止`)
    app?.stop()
    await server.close()
    store.close()
    process.exit(0)
  }

  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

async function runListen(): Promise<void> {
  const { store, rooms } = open()

  const app = new SubscriptionApp({
    config,
    store,
    rooms,
    syncIntervalMs: config.syncIntervalMs,
  })

  await app.start()

  const shutdown = (signal: string) => {
    logger.info(`收到 ${signal}，正在停止监听`)
    app.stop()
    store.close()
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  process.on('unhandledRejection', (reason) => {
    logger.error(`未处理的 Promise 拒绝: ${describeError(reason)}`)
  })
}

function clampInt(value: string | undefined, min: number, max: number, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

function main(): void {
  const command = process.argv[2] ?? 'web'

  const asyncRun = (fn: () => Promise<void>) => {
    void fn().catch((error) => {
      logger.error(`启动失败: ${describeError(error)}`)
      process.exit(1)
    })
  }

  switch (command) {
    case 'dev':
    case 'web':
      asyncRun(runWeb)
      break
    case 'start':
      // 生产模式：cookie 加 Secure（要求 https 或 localhost）
      process.env.NODE_ENV = 'production'
      asyncRun(runWeb)
      break
    case 'listen':
      asyncRun(runListen)
      break
    case 'list':
      runList()
      break
    case 'today':
      runToday()
      break
    case 'rooms':
      runRooms()
      break
    case 'info':
      asyncRun(runInfo)
      break
    case 'user:add':
      asyncRun(runUserAdd)
      break
    case 'user:list':
      runUserList()
      break
    case '-h':
    case '--help':
    case 'help':
      usage()
      break
    default:
      console.error(`未知命令: ${command}\n`)
      usage()
      process.exit(1)
  }
}

try {
  main()
} catch (error) {
  logger.error(`启动失败: ${describeError(error)}`)
  process.exit(1)
}
