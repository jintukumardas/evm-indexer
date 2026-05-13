import type { NextFunction, Request, Response } from 'express'
import { AppError } from '../../app/errors'
import { getLogger } from '../../app/logging'

/**
 * Centralized Express error middleware. Distinguishes our `AppError` hierarchy
 * (4xx semantics live on the class) from unknown errors (always 500, message
 * stripped to avoid leaking internals in production).
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const log = getLogger()
  if (err instanceof AppError) {
    if (err.statusCode >= 500) {
      log.error({ err: err.message, code: err.code, path: req.path }, 'Handled AppError (5xx)')
    } else {
      log.warn({ err: err.message, code: err.code, path: req.path }, 'Handled AppError (4xx)')
    }
    res.status(err.statusCode).json({ error: { code: err.code, message: err.message } })
    return
  }
  log.error({ err: (err as Error).message, path: req.path }, 'Unhandled error')
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: process.env.NODE_ENV === 'production' ? 'Internal Server Error' : (err as Error).message,
    },
  })
}

/** 404 handler — placed last so it only catches truly unmatched routes. */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `No route ${req.method} ${req.path}` } })
}
