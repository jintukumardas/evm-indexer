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
      // Always fall back to a constant when Express never matched a route —
      // the request might have been short-circuited by rate-limit / error
      // middleware before routing, or hit a non-404 dead end (405, 429, etc.).
      // Using `req.path` here would make the `route` label unbounded under
      // a wide-source flood and blow up prom-client memory.
      const labels = {
        method: req.method,
        route: req.route?.path ?? 'unmatched',
        status: String(res.statusCode),
      }
      end(labels)
      metrics.httpRequests.inc(labels)
    })
    next()
  }
}
