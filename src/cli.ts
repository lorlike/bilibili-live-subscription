#!/usr/bin/env node
import process from 'node:process'
import { SubscriptionApp, formatRecord } from './app.ts'
import { fetchRoomInfo, fetchRoomsInfo } from './bilibili.ts'
import { config } from './config.ts'
import { describeError, logger } from './logger.ts'
import { loadRooms } from './rooms.ts'
import { WebServer } from './server.ts'
import { LiveStore } from './store.ts'
import { todayRange } from './time.ts'

function usage(): void {
  console.log(`bilibili-live-subscription

用法:
  pnpm start                监听清单中的全部房间并存库（含 Web 界面）
  pnpm run serve            只启动 Web 界面（只读数据库）
  pnpm run list             在终端查看最近的开播记录
  pnpm run today            在终端查看今天的开播记录
  pnpm run info [房间号...]  查询直播间的标题与主播名
  pnpm run rooms            校验并打印房间清单
  pnpm run seed             写入一批演示数据（便于查看界面效果）

选项:
  --no-web                  只监听，不启动 Web 界面
  --port <n>                Web 端口（默认 $WEB_PORT）

环境变量见 .env.example
`)
}

function flagValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index === -1) return undefined
  return process.argv[index + 1]
}

function runList(): void {
  const store = new LiveStore(config.dbPath)
  try {
    const limit = Number(process.argv[3] ?? 20)
    const records = store.recent(Number.isFinite(limit) && limit > 0 ? limit : 20)

    if (records.length === 0) {
      console.log('暂无开播记录')
      return
    }

    for (const record of records) {
      console.log(`#${String(record.id).padStart(4, '0')}  ${formatRecord(record)}`)
    }
  } finally {
    store.close()
  }
}

function runToday(): void {
  const store = new LiveStore(config.dbPath)
  try {
    const range = todayRange()
    const records = store.recordsBetween(range.start, range.end)

    console.log(`── ${range.date} ──`)
    if (records.length === 0) {
      console.log('今天还没有开播记录')
      return
    }

    const pad2 = (n: number) => String(n).padStart(2, '0')
    for (const record of records) {
      const d = new Date(record.liveTime * 1000)
      const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
      const title = record.title ? `  ${record.title}` : ''
      console.log(`${time}  ▶ live  ${record.roomName}  #${record.roomId}${title}`)
    }
    console.log(`\n共 ${records.length} 条，涉及 ${new Set(records.map((r) => r.roomId)).size} 个房间`)
  } finally {
    store.close()
  }
}

function runInfo(): void {
  // 支持 info 652581、info 6 21452505、多个逗号分隔
  const args = process.argv.slice(3).flatMap((arg) => arg.split(','))
  const ids = args
    .map((arg) => Number(arg.trim()))
    .filter((id) => Number.isInteger(id) && id > 0)

  if (ids.length === 0) {
    // 没给房间号就查清单里的全部房间
    let rooms
    try {
      rooms = loadRooms(config.roomsFile)
    } catch (error) {
      logger.error(describeError(error))
      process.exit(1)
    }

    if (rooms.length === 0) {
      console.log('房间清单为空，用法: pnpm run info <房间号> [房间号...]')
      return
    }

    void printRoomInfo(rooms.map((room) => room.id))
    return
  }

  void printRoomInfo(ids)
}

async function printRoomInfo(ids: number[]): Promise<void> {
  const results = await fetchRoomsInfo(ids, { cookie: config.cookie })
  const pad = (text: string, width: number) =>
    text + ' '.repeat(Math.max(0, width - [...text].length))

  console.log(`${pad('房间号', 12)}${pad('主播', 22)}${pad('状态', 8)}标题`)
  console.log('─'.repeat(96))

  for (const { roomId, info, error } of results) {
    if (error || !info) {
      console.log(`${pad(String(roomId), 12)}${pad('—', 22)}${pad('查询失败', 8)}${error ?? '未知错误'}`)
      continue
    }

    const status = info.liveStatus === 1 ? '直播中' : '未开播'
    const idText =
      info.shortId && info.shortId !== info.roomId ? `${info.roomId}(${info.shortId})` : `${info.roomId}`

    console.log(
      `${pad(idText, 12)}${pad(info.anchorName ?? '—', 22)}${pad(status, 8)}${info.title || '（无标题）'}`,
    )
  }
}

function runRooms(): void {
  const rooms = loadRooms(config.roomsFile)
  console.log(`房间清单: ${config.roomsFile}（共 ${rooms.length} 个）`)
  for (const room of rooms) {
    const name = room.name ?? '(启动时自动查询主播名)'
    console.log(`- ${name}(${room.id})${room.enabled ? '' : ' [已禁用]'}`)
  }
}

async function startWebServer(portOverride?: number): Promise<WebServer> {
  const server = new WebServer({
    config,
    port: portOverride ?? config.webPort,
    host: config.webHost,
  })

  const port = await server.listen()
  logger.info(`Web 界面: http://${config.webHost}:${port}`)
  return server
}

async function runWatch(): Promise<void> {
  const store = new LiveStore(config.dbPath)
  const app = new SubscriptionApp(config, store)

  const withWeb = !process.argv.includes('--no-web')
  const portOverride = flagValue('--port')
  const web = withWeb
    ? await startWebServer(portOverride === undefined ? undefined : Number(portOverride))
    : null

  // 监听进程写入新记录后，立刻推给 Web 前端
  app.onRecord = (record) => web?.publish(record)

  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info(`收到 ${signal}，正在停止监听`)
    app.stop()
    store.close()
    await web?.close()
    process.exit(0)
  }

  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  process.on('unhandledRejection', (reason) => {
    logger.error(`未处理的 Promise 拒绝: ${describeError(reason)}`)
  })

  await app.start()
}

async function runServe(): Promise<void> {
  const web = await startWebServer(
    flagValue('--port') === undefined ? undefined : Number(flagValue('--port')),
  )

  const shutdown = async (signal: string) => {
    logger.info(`收到 ${signal}，正在停止 Web 服务`)
    await web.close()
    process.exit(0)
  }

  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

function main(): void {
  const command = process.argv[2] ?? 'watch'

  switch (command) {
    case 'watch':
    case 'start':
      void runWatch().catch((error) => {
        logger.error(`启动失败: ${describeError(error)}`)
        process.exit(1)
      })
      break
    case 'serve':
    case 'web':
      void runServe().catch((error) => {
        logger.error(`启动失败: ${describeError(error)}`)
        process.exit(1)
      })
      break
    case 'list':
      runList()
      break
    case 'today':
      runToday()
      break
    case 'info':
      runInfo()
      break
    case 'rooms':
      runRooms()
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
