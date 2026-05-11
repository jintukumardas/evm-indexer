import pino, { type Logger } from 'pino'

let rootLogger: Logger | null = null

export interface CreateLoggerOptions {
  level?: string
  pretty?: boolean
}

/**
 * Returns a process-wide structured logger. Pretty-prints in development,
 * emits NDJSON in production.
 */
export function getLogger(opts: CreateLoggerOptions = {}): Logger {
  if (rootLogger) return rootLogger
  const level = opts.level ?? process.env.LOG_LEVEL ?? 'info'
  const pretty = opts.pretty ?? process.env.NODE_ENV !== 'production'

  rootLogger = pino({
    level,
    base: { service: 'lifi-indexer' },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', singleLine: false },
          },
        }
      : {}),
  })
  return rootLogger
}

/** Test helper to drop the cached logger so a new level can be applied. */
export function resetLoggerForTests(): void {
  rootLogger = null
}
