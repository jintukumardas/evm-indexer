import type { NextFunction, Request, Response } from 'express'

/**
 * Tiny per-IP token-bucket rate limiter. Pure in-process — fine for a single
 * API instance, and the right default until you have a reason to reach for
 * Redis or a frontend proxy. Behaviour:
 *
 *   - Each client (keyed by IP, or a custom keyer) gets `burst` tokens.
 *   - Tokens refill at `refillPerSec` until full.
 *   - Each request consumes one token; if the bucket is empty we respond
 *     `429 Too Many Requests` with a `Retry-After` header and exit.
 *
 * Why a custom impl rather than `express-rate-limit`: keeps the dep tree small
 * and the behaviour easy to reason about for a tiny API. If/when this needs
 * cluster-wide accounting, swap to a backed limiter — the surface here stays
 * the same.
 */
export interface RateLimitOptions {
  /** Max tokens in the bucket. Default 60. */
  burst?: number
  /** Tokens added per second. Default 30 (≈ 1800 req/min sustained). */
  refillPerSec?: number
  /** Override the keying function (default: `req.ip`). */
  keyer?: (req: Request) => string
  /** Skip the limiter for specific paths (e.g. `/health`, `/metrics`). */
  skipPaths?: string[]
  /** Test hook — defaults to `Date.now`. */
  now?: () => number
  /**
   * Hard cap on the in-memory bucket map. We evict the oldest seen bucket
   * when we exceed this — protects the process from unbounded growth under
   * a wide-source flood.
   */
  maxBuckets?: number
}

interface Bucket {
  tokens: number
  updatedAt: number
}

export function rateLimit(opts: RateLimitOptions = {}) {
  const burst = opts.burst ?? 60
  const refill = opts.refillPerSec ?? 30
  const now = opts.now ?? Date.now
  const skipPaths = new Set(opts.skipPaths ?? [])
  const maxBuckets = opts.maxBuckets ?? 10_000
  const keyer = opts.keyer ?? defaultKey
  const buckets = new Map<string, Bucket>()

  return function (req: Request, res: Response, next: NextFunction): void {
    if (skipPaths.has(req.path)) return next()
    const key = keyer(req)
    const t = now()
    let bucket = buckets.get(key)
    if (!bucket) {
      // Evict the LRU bucket when we'd exceed the cap. `Map` preserves
      // insertion order, so after the re-insert below the first key is the
      // least-recently-used.
      if (buckets.size >= maxBuckets) {
        const first = buckets.keys().next().value
        if (first !== undefined) buckets.delete(first)
      }
      bucket = { tokens: burst, updatedAt: t }
      buckets.set(key, bucket)
    } else {
      // Refill before charging, then re-insert so the Map's insertion order
      // tracks recency of access — otherwise eviction would be strict FIFO on
      // first-seen and could throw out a hot client before an idle one.
      const elapsedSec = (t - bucket.updatedAt) / 1000
      bucket.tokens = Math.min(burst, bucket.tokens + elapsedSec * refill)
      bucket.updatedAt = t
      buckets.delete(key)
      buckets.set(key, bucket)
    }

    if (bucket.tokens < 1) {
      const retryAfterSec = Math.max(1, Math.ceil((1 - bucket.tokens) / refill))
      res.setHeader('Retry-After', String(retryAfterSec))
      res.status(429).json({
        error: {
          code: 'RATE_LIMITED',
          message: `Too many requests. Retry after ${retryAfterSec}s.`,
        },
      })
      return
    }
    bucket.tokens -= 1
    next()
  }
}

/**
 * Default keyer: prefer Express's `req.ip` (honours `trust proxy` when set),
 * fall back to the raw socket address, and a static bucket as a last resort
 * so the limiter never crashes on a malformed request object.
 */
function defaultKey(req: Request): string {
  return req.ip || req.socket?.remoteAddress || 'unknown'
}
