/**
 * Application error hierarchy. All errors thrown from our code should be one
 * of these — the API and the sync job use `instanceof` checks to decide how
 * to respond (status code, retry, fail fast, etc.).
 */
export abstract class AppError extends Error {
  abstract readonly code: string
  abstract readonly statusCode: number
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message)
    this.name = this.constructor.name
  }
}

export class ConfigError extends AppError {
  readonly code = 'CONFIG_ERROR'
  readonly statusCode = 500
}

export class ValidationError extends AppError {
  readonly code = 'VALIDATION_ERROR'
  readonly statusCode = 400
}

export class NotFoundError extends AppError {
  readonly code = 'NOT_FOUND'
  readonly statusCode = 404
}

export class RpcError extends AppError {
  readonly code = 'RPC_ERROR'
  readonly statusCode = 502
}

export class RangeLimitError extends AppError {
  readonly code = 'RPC_RANGE_LIMIT'
  readonly statusCode = 502
}

export class DatabaseError extends AppError {
  readonly code = 'DATABASE_ERROR'
  readonly statusCode = 500
}

/**
 * Best-effort detection of provider errors that indicate the requested block
 * range or response payload was too large. Different providers use different
 * messages/codes; this is intentionally permissive.
 */
export function isRangeLimitError(err: unknown): boolean {
  if (!err) return false
  const anyErr = err as { message?: string; code?: string | number; body?: string }
  const haystack = [
    anyErr.message,
    anyErr.body,
    typeof anyErr.code === 'string' ? anyErr.code : undefined,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  // Be deliberately narrow: avoid matching generic "rate limit" or "limit
  // exceeded" because those need to flow into the retry layer, not the
  // chunk-shrink layer. Only match phrases that clearly indicate a
  // block-range / result-size constraint.
  //
  // We deliberately do NOT match the bare JSON-RPC code `-32005` — Infura,
  // Alchemy, and dRPC all use it for *throughput / rate-limit* responses too,
  // not just range-limit. Mis-routing a rate-limit into the chunk-shrink
  // path means we halve the range instead of backing off, which doesn't help
  // and burns the retry budget. We rely on the message phrases below; every
  // major provider includes one when the cause is actually a range/size cap.
  return (
    haystack.includes('block range') ||
    haystack.includes('range is too') ||
    (haystack.includes('ranges over') && haystack.includes('blocks')) ||
    haystack.includes('blocks are not supported') ||
    haystack.includes('response size') ||
    haystack.includes('response is too large') ||
    haystack.includes('query returned more than') ||
    haystack.includes('too many logs') ||
    haystack.includes('too many results') ||
    haystack.includes('result set too large') ||
    haystack.includes('logs are limited') ||
    haystack.includes('returned more than')
  )
}
