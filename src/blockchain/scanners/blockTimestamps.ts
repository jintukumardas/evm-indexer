import type { ethers } from 'ethers'
import type { Logger } from 'pino'
import { withRetry, type RetryPolicy } from '../providers/retry'

export interface FetchBlockTimestampsOpts {
  policy: RetryPolicy
  logger?: Logger
  label: string
  signal?: AbortSignal
  /** Cap parallel `getBlock` calls to avoid hammering the RPC. */
  concurrency?: number
}

/**
 * Resolves a `blockNumber → unix seconds` map for the unique blocks in
 * `blockNumbers`. Each block is fetched once with retry; concurrency is
 * bounded so a wide chunk doesn't open hundreds of simultaneous RPC sockets.
 */
export async function fetchBlockTimestamps(
  blockNumbers: readonly number[],
  provider: ethers.providers.Provider,
  opts: FetchBlockTimestampsOpts,
): Promise<Map<number, number>> {
  const unique = Array.from(new Set(blockNumbers))
  const out = new Map<number, number>()
  if (unique.length === 0) return out
  const concurrency = Math.max(1, opts.concurrency ?? 8)
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < unique.length) {
      if (opts.signal?.aborted) return
      const n = unique[cursor++]
      const block = await withRetry(() => provider.getBlock(n), {
        policy: opts.policy,
        logger: opts.logger,
        label: `${opts.label}-getBlock(${n})`,
        signal: opts.signal,
      })
      out.set(n, block.timestamp)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, unique.length) }, () => worker()),
  )
  return out
}
