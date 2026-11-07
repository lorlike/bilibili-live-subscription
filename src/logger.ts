type Level = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

function currentLevel(): Level {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase()
  return (raw in LEVEL_ORDER ? raw : 'info') as Level
}

function write(level: Level, message: string, extra?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel()]) return

  const time = new Date().toISOString().replace('T', ' ').slice(0, 19)
  const line = `[${time}] ${level.toUpperCase().padEnd(5)} ${message}`

  if (level === 'error' || level === 'warn') {
    console.error(line, ...(extra === undefined ? [] : [extra]))
  } else {
    console.log(line, ...(extra === undefined ? [] : [extra]))
  }
}

export const logger = {
  debug: (message: string, extra?: unknown) => write('debug', message, extra),
  info: (message: string, extra?: unknown) => write('info', message, extra),
  warn: (message: string, extra?: unknown) => write('warn', message, extra),
  error: (message: string, extra?: unknown) => write('error', message, extra),
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}
