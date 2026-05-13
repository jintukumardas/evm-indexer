import express from 'express'
import request from 'supertest'
import { rateLimit } from '../../src/api/middleware/rateLimit'

/**
 * Build a tiny Express app that exposes a `/probe` endpoint guarded by the
 * limiter. We control `now` from outside the middleware so we don't need to
 * actually wait for real-time refills.
 */
function appWith(opts: Parameters<typeof rateLimit>[0]) {
  const app = express()
  app.use(rateLimit(opts))
  app.get('/probe', (_req, res) => res.json({ ok: true }))
  app.get('/health', (_req, res) => res.json({ ok: true }))
  return app
}

describe('rateLimit middleware', () => {
  it('allows requests up to the burst and rejects the next one', async () => {
    let now = 1_000_000
    const app = appWith({ burst: 3, refillPerSec: 0, now: () => now })
    for (let i = 0; i < 3; i++) {
      const res = await request(app).get('/probe')
      expect(res.status).toBe(200)
    }
    const blocked = await request(app).get('/probe')
    expect(blocked.status).toBe(429)
    expect(blocked.body.error.code).toBe('RATE_LIMITED')
    expect(blocked.headers['retry-after']).toBeDefined()
    // Advance clock; without refill we should stay blocked.
    now += 60_000
    const stillBlocked = await request(app).get('/probe')
    expect(stillBlocked.status).toBe(429)
  })

  it('refills tokens over time at the configured rate', async () => {
    let now = 1_000_000
    const app = appWith({ burst: 2, refillPerSec: 1, now: () => now })
    expect((await request(app).get('/probe')).status).toBe(200)
    expect((await request(app).get('/probe')).status).toBe(200)
    expect((await request(app).get('/probe')).status).toBe(429)
    // After 2s of refill at 1 t/s, we have 2 tokens again.
    now += 2000
    expect((await request(app).get('/probe')).status).toBe(200)
    expect((await request(app).get('/probe')).status).toBe(200)
    expect((await request(app).get('/probe')).status).toBe(429)
  })

  it('skips paths listed in skipPaths', async () => {
    const now = 1_000_000
    const app = appWith({ burst: 1, refillPerSec: 0, now: () => now, skipPaths: ['/health'] })
    // Burn the single token on /probe
    expect((await request(app).get('/probe')).status).toBe(200)
    expect((await request(app).get('/probe')).status).toBe(429)
    // /health stays open regardless.
    for (let i = 0; i < 5; i++) {
      expect((await request(app).get('/health')).status).toBe(200)
    }
  })

  it('isolates buckets per client key', async () => {
    const now = 1_000_000
    let key = 'A'
    const app = appWith({
      burst: 1,
      refillPerSec: 0,
      now: () => now,
      keyer: () => key,
    })
    // Exhaust A
    expect((await request(app).get('/probe')).status).toBe(200)
    expect((await request(app).get('/probe')).status).toBe(429)
    // Switch keyer → "B" has a fresh bucket.
    key = 'B'
    expect((await request(app).get('/probe')).status).toBe(200)
  })

  it('evicts the oldest bucket when over the maxBuckets cap', async () => {
    const now = 1_000_000
    let nextKey = 0
    const app = appWith({
      burst: 1,
      refillPerSec: 0,
      now: () => now,
      keyer: () => `k${nextKey}`,
      maxBuckets: 2,
    })
    // Three distinct keys force one eviction. The middleware should still
    // serve all three with 200 (each gets a fresh bucket as they're seen).
    for (let i = 0; i < 3; i++) {
      nextKey = i
      expect((await request(app).get('/probe')).status).toBe(200)
    }
  })
})
