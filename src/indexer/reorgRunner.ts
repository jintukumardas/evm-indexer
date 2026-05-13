import { ethers } from 'ethers'
import type { Logger } from 'pino'
import type { ChainIndexConfig } from '../app/config'
import { getMetrics } from '../app/metrics'
import { withRetry, type RetryPolicy } from '../blockchain/providers/retry'
import { adaptiveFetchLogs } from '../blockchain/scanners/eventScanner'
import { fetchBlockTimestamps } from '../blockchain/scanners/blockTimestamps'
import { diffPersistedVsFetched, identityKey } from './identity'
import type { ContractEventPlugin, EventIdentity } from './types'

export interface ReorgRunnerDeps {
  logger: Logger
  retry: RetryPolicy
}

export interface ReorgReconcileResult {
  reconciledFrom: number
  reconciledTo: number
  reorgedOut: number
  restored: number
  newlySeen: number
  unchanged: number
}

/**
 * Generic reorg reconciliation pass. Same algorithm the FeeCollector-specific
 * `ReorgReconciler` used to implement, now driven by an abstract plugin:
 *
 *   1. Compute window = [max(checkpoint - reorgWindow + 1, startBlock), checkpoint]
 *   2. Re-fetch all logs in that window via `plugin.buildFilter()` + adaptive scanner
 *   3. Diff persisted (via `plugin.findInRange`) vs re-fetched:
 *        - in DB, not in RPC → reorged out → `plugin.markRemoved`
 *        - in DB+removed=true, also in RPC → reorg-of-reorg → `plugin.restoreRemoved`
 *        - in RPC, not in DB → upsert via `plugin.persistChunk` (unique index dedups)
 *
 * Disabled when `chain.reorgWindow === 0` — in that mode `confirmations` is
 * the only reorg defence and we skip this pass entirely.
 */
export class ReorgRunner {
  constructor(private readonly deps: ReorgRunnerDeps) {}

  async reconcile<T>(
    plugin: ContractEventPlugin<T>,
    chain: ChainIndexConfig,
    provider: ethers.providers.Provider,
    checkpoint: number,
    signal?: AbortSignal,
  ): Promise<ReorgReconcileResult | null> {
    if (chain.reorgWindow <= 0) return null
    const logger = this.deps.logger
    const fromBlock = Math.max(plugin.startBlock, checkpoint - chain.reorgWindow + 1)
    const toBlock = checkpoint
    if (fromBlock > toBlock) return null

    logger.info(
      { chain: chain.key, plugin: plugin.key, fromBlock, toBlock, window: chain.reorgWindow },
      'Reorg reconciliation starting',
    )

    const contract = new ethers.Contract(plugin.contractAddress, plugin.getInterface(), provider)
    const filter = plugin.buildFilter(contract)

    const fetcher = (from: number, to: number): Promise<ethers.Event[]> =>
      withRetry(() => contract.queryFilter(filter, from, to), {
        policy: this.deps.retry,
        logger,
        label: `${plugin.key}-reorg-queryFilter(${from}-${to})`,
        signal,
      })

    const fetchedIdentities: EventIdentity[] = []
    const allParsed: T[] = []
    for await (const { events } of adaptiveFetchLogs(fromBlock, toBlock, fetcher, {
      initialChunkSize: chain.chunkSize,
      minChunkSize: chain.minChunkSize,
      maxRetries: chain.maxChunkRetries,
      logger,
      signal,
    })) {
      const blockTimestamps = await fetchBlockTimestamps(
        events.map((e) => e.blockNumber),
        provider,
        {
          policy: this.deps.retry,
          logger,
          label: `${plugin.key}-reorg-blockTs`,
          signal,
        },
      )
      const parsed = plugin.parse(events, {
        chainId: plugin.chainId,
        chainKey: plugin.chainKey,
        contractAddress: plugin.contractAddress,
        blockTimestamps,
      })
      allParsed.push(...parsed)
      for (const p of parsed) fetchedIdentities.push(plugin.identityOf(p))
    }

    // If the operator aborted mid-fetch, `fetchedIdentities` is a partial
    // snapshot of the canonical chain. Diffing a partial fetched-set against
    // the full persisted-set would flag every row in the un-scanned portion
    // of the window as `removed: true` — silent mass data loss. Bail out
    // before touching the DB; the next pass will reconcile cleanly.
    if (signal?.aborted) {
      logger.info(
        { chain: chain.key, plugin: plugin.key, fromBlock, toBlock },
        'Reorg reconciliation aborted before diff — leaving persisted state untouched',
      )
      return null
    }

    const persistedRows = await plugin.findInRange(fromBlock, toBlock)
    const persistedIdentities = persistedRows.map((r) => r.identity)

    // Rows in DB whose identity is gone from the canonical chain → mark removed.
    const reorgedOut = diffPersistedVsFetched(persistedIdentities, fetchedIdentities)
    const reorgedActuallyMarked = await plugin.markRemoved(reorgedOut)

    // Rows currently removed=true but back in the canonical chain → restore.
    // Without this, `persistChunk` below would be a no-op (unique index dedups)
    // and the row would stay flagged `removed:true` forever (data loss).
    const fetchedKeys = new Set(fetchedIdentities.map(identityKey))
    const restoredIds: EventIdentity[] = persistedRows
      .filter((r) => r.removed && fetchedKeys.has(identityKey(r.identity)))
      .map((r) => r.identity)
    const restored = await plugin.restoreRemoved(restoredIds)

    // Anything in RPC but not yet in DB lands here. Already-known rows are
    // silently skipped by the unique index inside persistChunk.
    const upsertResult = await plugin.persistChunk(allParsed)

    const result: ReorgReconcileResult = {
      reconciledFrom: fromBlock,
      reconciledTo: toBlock,
      reorgedOut: reorgedActuallyMarked,
      restored,
      newlySeen: upsertResult.insertedCount,
      unchanged: upsertResult.duplicateCount,
    }

    if (reorgedActuallyMarked > 0 || restored > 0) {
      getMetrics().reorgsDetected.inc(plugin.metricsLabels, reorgedActuallyMarked)
      logger.warn(
        { chain: chain.key, plugin: plugin.key, result },
        'Reorg detected — rows marked removed and/or restored',
      )
    } else {
      logger.info(
        { chain: chain.key, plugin: plugin.key, result },
        'Reorg reconciliation: no divergence',
      )
    }
    return result
  }
}
