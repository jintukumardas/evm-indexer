import { Router } from 'express'
import { getMetrics } from '../../app/metrics'

/**
 * `GET /metrics` — Prometheus scrape endpoint. Content-Type is set per
 * registry to honour the OpenMetrics negotiation prom-client performs.
 */
export function metricsRouter(): Router {
  const router = Router()
  router.get('/metrics', async (_req, res, next) => {
    try {
      const metrics = getMetrics()
      res.set('Content-Type', metrics.registry.contentType)
      res.end(await metrics.registry.metrics())
    } catch (err) {
      next(err)
    }
  })
  return router
}
