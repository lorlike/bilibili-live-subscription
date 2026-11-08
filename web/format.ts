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
 * 「距今」时长：这条开播距现在过了多久。
 * 列表按新→旧排列，所以用它比「距上一条的间隔」更直观。
 */
export function durationOf(record: { liveTime: number }): string {
  const secs = Math.floor(Date.now() / 1000) - record.liveTime
  if (secs <= 0) return '—'

  const d = Math.floor(secs / 86400)
  const h = Math.floor((secs % 86400) / 3600)
  const m = Math.floor((secs % 3600) / 60)

  if (d > 0) return `${d}天前`
  if (h > 0) return `${h}h${pad(m)}m前`
  if (m > 0) return `${m}m前`
  return '刚刚'
}

export function shiftDateString(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const next = new Date(y!, (m ?? 1) - 1, (d ?? 1) + days)
  return `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`
}
