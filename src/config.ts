import { randomBytes } from 'node:crypto'
import 'dotenv/config'

function str(key: string, fallback = ''): string {
  const value = process.env[key]
  return value === undefined || value.trim() === '' ? fallback : value.trim()
}

function num(key: string, fallback: number): number {
  const raw = str(key)
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

export const config = {
  /** Cookie，用于规避风控（否则拿不到弹幕发送者用户名） */
  cookie: str('BILIBILI_COOKIE'),
  /** Cookie 对应的 UID */
  /**
   * Cookie 对应的 UID。
   * 注意：实测传入非 0 的 uid 会被 B 站弹幕服务器直接断开（close 1006），
   * 而 uid=0 + Cookie 仍能正常获取弹幕用户名，所以默认 0。
   */
  uid: num('UID', 0),
  /** 房间清单文件 */
  /** SQLite 数据库文件 */
  dbPath: str('DB_PATH', 'data/live.db'),
  /** 记录保留天数，0 表示永久保留 */
  retentionDays: num('RETENTION_DAYS', 0),
  /** Web 监听地址 */
  webHost: str('WEB_HOST', '127.0.0.1'),
  /** Web 端口 */
  webPort: num('WEB_PORT', 3000),
  /** 断线重连间隔（毫秒） */
  reconnectTime: num('RECONNECT_TIME', 5000),
  /** 心跳间隔（毫秒） */
  heartbeatTime: num('HEARTBEAT_TIME', 30000),
  /** 日志级别 */
  logLevel: str('LOG_LEVEL', 'info'),

  /** JWT 签名密钥；未配置时用随机值（重启后所有会话失效） */
  jwtSecret: str('JWT_SECRET') || randomBytes(32).toString('hex'),
  /** JWT 有效期（小时） */
  jwtTtlHours: num('JWT_TTL_HOURS', 24),

  /** 只启动 Web（不监听），用于分进程部署 */
  webOnly: str('WEB_ONLY') === '1',
  /** 监听进程与数据库同步房间的间隔（毫秒），0 表示不自动同步 */
  syncIntervalMs: num('SYNC_INTERVAL_MS', 5000),
}

export type AppConfig = typeof config
