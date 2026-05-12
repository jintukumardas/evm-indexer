import { ValidationError } from '../../app/errors'
import {
  FeeEventRepository,
  type FeeEventCursor,
  type ListByIntegratorResult,
} from '../../plugins/feeCollector/repository'

export interface ListFeeEventsParams {
  integrator: string
  limit?: number
  cursor?: string
  chainId?: number
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 500
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

/**
 * Application service for fee-event queries. Holds the input-validation +
 * cursor (en|de)coding rules so the HTTP route stays thin.
 */
export class FeeEventsService {
  constructor(private readonly repo: FeeEventRepository) {}

  async listByIntegrator(params: ListFeeEventsParams): Promise<{
    items: ListByIntegratorResult['items']
    nextCursor: string | null
    hasNextPage: boolean
  }> {
    if (!params.integrator || !ADDRESS_RE.test(params.integrator)) {
      throw new ValidationError('integrator must be a 0x-prefixed 20-byte hex address')
    }
    const limit = clampLimit(params.limit)
    const cursor = params.cursor ? decodeCursor(params.cursor) : undefined

    const result = await this.repo.listByIntegrator({
      integrator: params.integrator,
      limit,
      cursor,
      chainId: params.chainId,
    })
    return {
      items: result.items,
      hasNextPage: result.hasNextPage,
      nextCursor: result.nextCursor ? encodeCursor(result.nextCursor) : null,
    }
  }
}

function clampLimit(input: number | undefined): number {
  if (input == null || Number.isNaN(input)) return DEFAULT_LIMIT
  const n = Math.floor(input)
  if (n < 1) return 1
  if (n > MAX_LIMIT) return MAX_LIMIT
  return n
}

/**
 * Cursor is an opaque base64-encoded JSON tuple. Keep it opaque so we can
 * change the underlying representation later without breaking clients.
 *
 * A real cursor base64url-encodes a tuple of two ints, so it never exceeds a
 * few dozen bytes. We hard-cap the input at MAX_CURSOR_LEN to make sure a
 * caller can't force us to allocate megabytes parsing a malicious cursor.
 */
const MAX_CURSOR_LEN = 256

// Cap individual cursor fields to keep parse cost bounded — these are our own
// emitted values, so the bounds are generous. `transactionHash` is treated as
// an opaque string (not regex-checked) so cursors round-trip even when test
// fixtures use synthetic short hashes.
const MAX_TX_HASH_LEN = 80

export function encodeCursor(c: FeeEventCursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url')
}

export function decodeCursor(s: string): FeeEventCursor {
  if (typeof s !== 'string' || s.length === 0 || s.length > MAX_CURSOR_LEN) {
    throw new ValidationError('Invalid cursor')
  }
  try {
    const parsed = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'))
    if (
      typeof parsed?.blockNumber !== 'number' ||
      typeof parsed?.logIndex !== 'number' ||
      typeof parsed?.transactionHash !== 'string' ||
      typeof parsed?.chainId !== 'number' ||
      !Number.isFinite(parsed.blockNumber) ||
      !Number.isFinite(parsed.logIndex) ||
      !Number.isFinite(parsed.chainId) ||
      parsed.blockNumber < 0 ||
      parsed.logIndex < 0 ||
      parsed.chainId < 0 ||
      parsed.transactionHash.length === 0 ||
      parsed.transactionHash.length > MAX_TX_HASH_LEN
    ) {
      throw new Error('shape')
    }
    return {
      blockNumber: parsed.blockNumber,
      logIndex: parsed.logIndex,
      transactionHash: parsed.transactionHash,
      chainId: parsed.chainId,
    }
  } catch {
    throw new ValidationError('Invalid cursor')
  }
}

export { clampLimit }
