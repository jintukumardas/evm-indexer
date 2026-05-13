import { Router } from 'express'
import mongoose from 'mongoose'

/**
 * Liveness + readiness check. Reports the MongoDB connection state so
 * orchestrators (k8s, ECS) can wait for the DB to be up before sending traffic.
 */
export function healthRouter(): Router {
  const router = Router()
  router.get('/health', (_req, res) => {
    const dbState = mongoose.connection.readyState
    const dbStateText =
      ({ 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' } as const)[
        dbState as 0 | 1 | 2 | 3
      ] ?? 'unknown'
    const ok = dbState === 1
    res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded', db: dbStateText })
  })
  return router
}
