import type { ethers } from 'ethers'
import type { Logger } from 'pino'
import { isRangeLimitError, RpcError } from '../../app/errors'
import type { BlockRange } from '../../types'

/**
 * Compute chunked block ranges for a backfill. Pure function — covered by unit tests.
 * Inclusive bounds. If `from > to`, returns an empty array.
 */
export function computeChunkRanges(from: number, to: number, chunkSize: number): BlockRange[] {
  if (chunkSize <= 0) throw new Error('chunkSize must be > 0')
  if (from > to) return []
  const ranges: BlockRange[] = []
  let cursor = from
  while (cursor <= to) {
    const end = Math.min(cursor + chunkSize - 1, to)
    ranges.push({ fromBlock: cursor, toBlock: end })
    cursor = end + 1
  }
  return ranges
}

export interface FetchLogsFn {
  (fromBlock: number, toBlock: number): Promise<ethers.Event[]>
}

export interface AdaptiveFetchOptions {
  initialChunkSize: number
  minChunkSize: number
  maxRetries: number
  logger?: Logger
  /**
   * Optional cancellation signal. Checked at chunk boundaries; when aborted,
   * the generator returns cleanly so the caller's checkpoint is preserved.
   */
  signal?: AbortSignal
}

/**
 * Fetches logs for inclusive [fromBlock, toBlock] with adaptive chunk sizing.
 *
 * Behaviour:
 *  - On a "range too large" / "too many results" provider error we halve the
 *    chunk size and retry the same starting block. We never skip blocks.
 *  - On any other RPC error we surface as `RpcError`.
 *  - Aborts cleanly (no throw) when `opts.signal` fires at a chunk boundary.
 *  - This is an async generator so the caller can persist each chunk and
 *    advance the sync checkpoint incrementally.
 */
export async function* adaptiveFetchLogs(
  fromBlock: number,
  toBlock: number,
  fetcher: FetchLogsFn,
  opts: AdaptiveFetchOptions,
): AsyncGenerator<{ range: BlockRange; events: ethers.Event[] }> {
  if (fromBlock > toBlock) return
  const { minChunkSize, maxRetries, logger, signal } = opts
  let chunkSize = Math.max(1, opts.initialChunkSize)
  let cursor = fromBlock
  let attempts = 0

  while (cursor <= toBlock) {
    if (signal?.aborted) {
      logger?.warn({ cursor, toBlock }, 'Scanner aborted at chunk boundary')
      return
    }
    const end = Math.min(cursor + chunkSize - 1, toBlock)
    try {
      logger?.debug({ fromBlock: cursor, toBlock: end, chunkSize }, 'Fetching chunk')
      const events = await fetcher(cursor, end)
      logger?.debug({ fromBlock: cursor, toBlock: end, count: events.length }, 'Chunk fetched')
      yield { range: { fromBlock: cursor, toBlock: end }, events }
      cursor = end + 1
      attempts = 0
    } catch (err) {
      if (!isRangeLimitError(err)) {
        throw new RpcError(
          `RPC fetch failed for range ${cursor}-${end}: ${(err as Error).message}`,
          err,
        )
      }
      attempts += 1
      if (attempts > maxRetries || chunkSize <= minChunkSize) {
        throw new RpcError(
          `Provider range limit hit for ${cursor}-${end}; cannot shrink further ` +
            `(attempt=${attempts}, chunkSize=${chunkSize}, minChunkSize=${minChunkSize})`,
          err,
        )
      }
      const newChunkSize = Math.max(minChunkSize, Math.floor(chunkSize / 2))
      logger?.warn(
        { fromBlock: cursor, toBlock: end, chunkSize, newChunkSize, attempt: attempts },
        'Provider range/limit error — halving chunk size and retrying',
      )
      chunkSize = newChunkSize
    }
  }
}
