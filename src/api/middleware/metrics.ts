import type { NextFunction, Request, Response } from 'express'
import { getMetrics } from '../../app/metrics'

/**
 * Tiny HTTP metrics middleware. Counts requests and records latency.
 *
 * `route` is the matched Express route pattern (e.g. `/fee-events`), not the
 * raw URL — keeps label cardinality bounded.
 */
export function httpMetricsMiddleware() {
  const metrics = getMetrics()
  return function (req: Request, res: Response, next: NextFunction): void {
    const end = metrics.httpDuration.startTimer()
    res.on('finish', () => {
      const labels = {
        method: req.method,
        route: req.route?.path ?? (res.statusCode === 404 ? 'unmatched' : req.path),
        status: String(res.statusCode),
      }
      end(labels)
      metrics.httpRequests.inc(labels)
    })
    next()
  }
}
