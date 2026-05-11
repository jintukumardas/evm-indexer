import type { Logger } from 'pino'
import { isRangeLimitError, RpcError } from '../../app/errors'

export interface RetryPolicy {
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
}

export interface WithRetryOptions {
  policy: RetryPolicy
  logger?: Logger
  /** Logging tag — included in retry warnings so we know which call is flaking. */
  label?: string
  /** Abort the retry loop early. */
  signal?: AbortSignal
  /**
   * Predicate to classify an error as retryable. Defaults to
   * `defaultIsTransient`, which excludes range-limit errors (the scanner has
   * its own adaptive policy for those) and aborts.
   */
  isRetryable?: (err: unknown) => boolean
  /** Test hook — defaults to global setTimeout. */
  sleeper?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/**
 * Common transient-error detection. We retry on:
 *   - network resets / hang-ups
 *   - HTTP 5xx
 *   - explicit rate-limit signals
 *   - timeouts
 *
 * We deliberately DO NOT retry range-limit errors here — those are handled by
 * the adaptive scanner, which shrinks the chunk instead of waiting.
 */
export function defaultIsTransient(err: unknown): boolean {
  if (!err) return false
  if (isAbortError(err)) return false
  if (isRangeLimitError(err)) return false
  const e = err as { message?: string; code?: string | number; status?: number; statusCode?: number }
  const status = e.status ?? e.statusCode
  if (typeof status === 'number' && status >= 500 && status < 600) return true
  if (typeof status === 'number' && status === 429) return true

  const hay = `${e.message ?? ''} ${e.code ?? ''}`.toLowerCase()
  return (
    hay.includes('timeout') ||
    hay.includes('etimedout') ||
    hay.includes('econnreset') ||
    hay.includes('econnrefused') ||
    hay.includes('socket hang up') ||
    hay.includes('network error') ||
    hay.includes('bad gateway') ||
    hay.includes('service unavailable') ||
    hay.includes('gateway timeout') ||
    hay.includes('rate limit') ||
    hay.includes('too many requests') ||
    hay.includes('server_error') ||
    e.code === 'ETIMEDOUT' ||
    e.code === 'ECONNRESET' ||
    e.code === 'ECONNREFUSED'
  )
}

function isAbortError(err: unknown): boolean {
  if (!err) return false
  const e = err as { name?: string; code?: string }
  return e.name === 'AbortError' || e.code === 'ABORT_ERR'
}

/**
 * Wraps an async operation with exponential backoff + jitter. The first call
 * is immediate; subsequent attempts wait `min(maxDelay, base * 2^(n-1))` ms
 * with full jitter (0..delay) so concurrent workers don't synchronize their
 * retries.
 *
 * Throws `RpcError` after `maxAttempts` failures (or the last raw error if
 * non-retryable).
 */
export async function withRetry<T>(op: () => Promise<T>, opts: WithRetryOptions): Promise<T> {
  const policy = opts.policy
  const isRetryable = opts.isRetryable ?? defaultIsTransient
  const sleeper = opts.sleeper ?? sleep
  let attempt = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (opts.signal?.aborted) {
      // Honour shutdown signals before issuing the next RPC call. Without this
      // the caller would burn one more network round-trip after SIGINT.
      const err = new Error('Aborted') as Error & { name: string; code: string }
      err.name = 'AbortError'
      err.code = 'ABORT_ERR'
      throw err
    }
    attempt += 1
    try {
      return await op()
    } catch (err) {
      if (opts.signal?.aborted) {
        throw err
      }
      if (!isRetryable(err) || attempt >= policy.maxAttempts) {
        if (attempt >= policy.maxAttempts && isRetryable(err)) {
          throw new RpcError(
            `RPC call ${opts.label ?? ''} failed after ${attempt} attempts: ${(err as Error).message}`.trim(),
            err,
          )
        }
        throw err
      }
      const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1))
      const delay = Math.floor(Math.random() * exp)
      opts.logger?.warn(
        { label: opts.label, attempt, nextDelayMs: delay, err: (err as Error).message },
        'Retryable RPC error — backing off',
      )
      await sleeper(delay, opts.signal)
    }
  }
}

/**
 * Sleep that honours an AbortSignal. Resolves early (without throwing) when
 * the signal fires — the caller's loop will see `signal.aborted` and exit.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
