import express, { type Express } from 'express'
import { healthRouter } from './routes/health'
import { metricsRouter } from './routes/metrics'
import { openApiRouter } from './routes/openapi'
import { errorHandler, notFoundHandler } from './middleware/errorHandler'
import { httpMetricsMiddleware } from './middleware/metrics'
import { rateLimit } from './middleware/rateLimit'
import type { ContractEventPlugin } from '../indexer/types'

export interface BuildAppOptions {
  /**
   * Plugins whose `registerRoutes` hook should be invoked. The app calls each
   * one in order so plugin-owned endpoints (e.g. `/fee-events`) are mounted
   * via the plugin rather than imported globally.
   *
   * Tests pass an empty list (or a fake plugin) to exercise the generic
   * middleware in isolation.
   */
  plugins?: ContractEventPlugin[]
  /**
   * Per-IP token-bucket rate limit. `burst <= 0` disables the limiter.
   * Defaults are sized for a small service: 60 burst, 30/s sustained.
   */
  rateLimit?: { burst: number; refillPerSec: number }
}

/**
 * Express app factory. Returned as a plain `Express` so tests can
 * `supertest(app)` without binding a port.
 *
 * Middleware order:
 *   json body parser → rate limit → HTTP metrics → core routes → plugin
 *   routes → notFound → errorHandler
 *
 * `/health` and `/metrics` are exempt from the limiter so probes and scrapers
 * keep working under load.
 *
 * Generic routes (`/health`, `/metrics`, `/openapi.json`, `/docs`) are
 * always mounted. Plugin-owned routes are mounted via `plugin.registerRoutes`,
 * which keeps the API surface in lockstep with whichever plugins are
 * registered for this deployment.
 */
export function buildApp(opts: BuildAppOptions = {}): Express {
  const app = express()
  app.disable('x-powered-by')
  // Trust the first proxy hop so `req.ip` reflects the real client behind a
  // load balancer. This is the right default for the supported deployments
  // (Docker behind nginx/ALB); harmless on direct exposure.
  app.set('trust proxy', 1)
  app.use(express.json({ limit: '64kb' }))

  const rl = opts.rateLimit ?? { burst: 60, refillPerSec: 30 }
  if (rl.burst > 0) {
    app.use(
      rateLimit({
        burst: rl.burst,
        refillPerSec: rl.refillPerSec,
        // Liveness probes and Prometheus scrapes must never be throttled.
        skipPaths: ['/health', '/metrics'],
      }),
    )
  }
  app.use(httpMetricsMiddleware())

  app.use(healthRouter())
  app.use(metricsRouter())
  app.use(openApiRouter())

  // Plugin-owned routes. Each plugin decides which paths it wants to expose.
  for (const plugin of opts.plugins ?? []) {
    plugin.registerRoutes?.(app)
  }

  app.use(notFoundHandler)
  app.use(errorHandler)
  return app
}
