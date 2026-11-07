/** 本地时区的「当天」区间工具 */

export interface DayRange {
  /** YYYY-MM-DD */
  date: string
  /** 当天 00:00:00.000 的 Unix 秒（闭区间起点） */
  start: number
  /** 次日 00:00:00.000 的 Unix 秒（开区间终点） */
  end: number
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

export function formatDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * 解析 YYYY-MM-DD，返回本地时区的日期对象。
 * 非法输入返回 null。
 */
export function parseDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!match) return null

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])

  if (month < 1 || month > 12 || day < 1 || day > 31) return null

  const date = new Date(year, month - 1, day)
  // 排除 2024-02-31 这类溢出日期
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null
  }
  return date
}

export function dayRange(date: Date): DayRange {
  const startDate = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const endDate = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1)

  return {
    date: formatDate(startDate),
    start: Math.floor(startDate.getTime() / 1000),
    end: Math.floor(endDate.getTime() / 1000),
  }
}

export function todayRange(now = new Date()): DayRange {
  return dayRange(now)
}

export function shiftDate(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days)
}
