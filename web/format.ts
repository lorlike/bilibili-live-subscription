/** 日期与时间格式化（纯前端使用） */

export const pad = (n: number): string => String(n).padStart(2, '0')

export function todayString(): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function dateFromUnix(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function timeString(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function fullString(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000)
  return `${dateFromUnix(unixSeconds)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function dateTimeString(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000)
  return `${dateFromUnix(unixSeconds)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const DAY = 86400

/** 距今天数描述，例：今天 / 昨天 / 3 天前 */
export function agoString(unixSeconds: number | null): string {
  if (!unixSeconds) return '—'

  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  const days = Math.floor((startOfToday.getTime() / 1000 - unixSeconds) / DAY)

  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 30) return `${days} 天前`
  if (days < 365) return `${Math.floor(days / 30)} 个月前`
  return `${Math.floor(days / 365)} 年前`
}

/**
 * 开播时长：下一条记录之前视为一场。
 * 最后一条用当前时间推算；若开播时间还在未来（时钟偏差）则显示 —。
 */
export function durationOf(record: { liveTime: number }, next: { liveTime: number } | null): string {
  const now = Math.floor(Date.now() / 1000)
  const end = next ? next.liveTime : now
  const secs = end - record.liveTime

  if (secs <= 0) return '—'

  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = secs % 60

  if (h > 0) return `${h}h${pad(m)}m`
  if (m > 0) return `${m}m${pad(s)}s`
  return `${s}s`
}

export function shiftDateString(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const next = new Date(y!, (m ?? 1) - 1, (d ?? 1) + days)
  return `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`
}
