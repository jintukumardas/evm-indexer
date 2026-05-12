import { ethers } from 'ethers'
import type { Logger } from 'pino'
import type { AppConfig, ChainIndexConfig } from '../app/config'
import { getMetrics } from '../app/metrics'
import { providerFactory } from '../blockchain/providers'
import { withRetry } from '../blockchain/providers/retry'
import { adaptiveFetchLogs } from '../blockchain/scanners/eventScanner'
import { fetchBlockTimestamps } from '../blockchain/scanners/blockTimestamps'
import {
  SyncStateRepository,
  computeNextFromBlock,
} from '../db/repositories/syncStateRepository'
import type { ReorgReconcileResult, ReorgRunner } from './reorgRunner'
import type { ContractEventPlugin } from './types'

export interface SyncRunnerDeps {
  syncState: SyncStateRepository
  logger: Logger
  config: AppConfig
  /** Optional override so tests can supply a fake provider per plugin. */
  providerFor?: (plugin: ContractEventPlugin, chain: ChainIndexConfig) => ethers.providers.Provider
}

export interface SyncRunOptions {
  /** Optional reorg pass — runs before forward progress. */
  reorgRunner?: ReorgRunner
}

export interface SyncRunSummary {
  pluginKey: string
  chainKey: string
  fromBlock: number
  toBlock: number
  /** Union of the reorg window and forward range — fed to `onPostSync`. */
  postSyncFromBlock: number
  postSyncToBlock: number
  rangesProcessed: number
  eventsFound: number
  eventsInserted: number
  duplicates: number
  reorgedOut: number
  aborted: boolean
}

/**
 * Generic per-(chain, plugin) sync pass. Replaces the old FeeCollector-specific
 * `SyncService`. The pipeline is unchanged from the original:
 *
 *   1. resolve safe latest block (`latest - chain.confirmations`)
 *   2. reorg reconciliation over the recent window (if a ReorgRunner is given)
 *   3. load checkpoint, compute next fromBlock
 *   4. iterate chunks with adaptive sizing
 *   5. parse + persist + advance checkpoint per chunk
 *   6. invoke `plugin.onPostSync` over the *union* of the reorg + forward
 *      ranges so any blocks whose rows were mutated by the reorg pass are
 *      still rolled into the plugin's derived state
 *
 * Each step is wrapped with retry + metrics; an AbortSignal lets the worker
 * stop cleanly at the next chunk boundary on SIGINT/SIGTERM.
 */
export class SyncRunner {
  constructor(private readonly deps: SyncRunnerDeps) {}

  async run<T>(
    plugin: ContractEventPlugin<T>,
    chain: ChainIndexConfig,
    signal?: AbortSignal,
    opts: SyncRunOptions = {},
  ): Promise<SyncRunSummary> {
    const { logger, syncState, config } = this.deps
    const metrics = getMetrics()
    const provider = (this.deps.providerFor ?? defaultProviderFor)(plugin, chain)
    const labels = plugin.metricsLabels
    const key = {
      chainId: plugin.chainId,
      chainKey: plugin.chainKey,
      contractAddress: plugin.contractAddress,
      eventName: plugin.eventName,
    }

    const state = await syncState.getOrInit(key, plugin.startBlock)
    await syncState.markRunning(key)

    let summary: SyncRunSummary = {
      pluginKey: plugin.key,
      chainKey: plugin.chainKey,
      fromBlock: 0,
      toBlock: 0,
      postSyncFromBlock: 0,
      postSyncToBlock: 0,
      rangesProcessed: 0,
      eventsFound: 0,
      eventsInserted: 0,
      duplicates: 0,
      reorgedOut: 0,
      aborted: false,
    }

    try {
      const latest = await withRetry(() => provider.getBlockNumber(), {
        policy: config.retry,
        logger,
        label: `${plugin.key}-getBlockNumber`,
        signal,
      })
      const safeLatest = Math.max(0, latest - chain.confirmations)

      // (2) Reorg reconciliation runs *before* forward progress so newly-removed
      // rows can't be re-counted as fresh in this pass. Capture the window
      // start so the post-sync hook sees the *union* range.
      let reorgFromBlock = state.lastSyncedBlock + 1
      let reorgResult: ReorgReconcileResult | null = null
      if (opts.reorgRunner && chain.reorgWindow > 0) {
        reorgResult = await opts.reorgRunner.reconcile(
          plugin,
          chain,
          provider,
          state.lastSyncedBlock,
          signal,
        )
        if (reorgResult) {
          summary.reorgedOut = reorgResult.reorgedOut
          reorgFromBlock = reorgResult.reconciledFrom
        }
      }

      const fromBlock = computeNextFromBlock(state.lastSyncedBlock, plugin.startBlock)
      if (fromBlock > safeLatest) {
        logger.info(
          { chain: chain.key, plugin: plugin.key, fromBlock, safeLatest, latest },
          'No forward progress — already caught up to safe head',
        )
        // If reorg ran and mutated rows in the reconciled window, derived state
        // (aggregates, etc.) must still be rebuilt over that window — otherwise
        // a caught-up pass that flagged a row `removed` would leave the
        // aggregate sums stale until the next chunk happens to land.
        if (plugin.onPostSync && reorgResult && !signal?.aborted) {
          try {
            await plugin.onPostSync({
              fromBlock: reorgResult.reconciledFrom,
              toBlock: reorgResult.reconciledTo,
              provider,
              signal,
            })
          } catch (err) {
            logger.error(
              { chain: chain.key, plugin: plugin.key, err: (err as Error).message },
              'Plugin onPostSync failed (non-fatal)',
            )
          }
        }
        await syncState.markIdle(key)
        metrics.syncPasses.inc({ ...labels, outcome: 'noop' })
        metrics.lastSyncedBlock.set(labels, state.lastSyncedBlock)
        return {
          ...summary,
          fromBlock,
          toBlock: safeLatest,
          postSyncFromBlock: reorgResult?.reconciledFrom ?? reorgFromBlock,
          postSyncToBlock: reorgResult?.reconciledTo ?? state.lastSyncedBlock,
        }
      }

      summary = {
        ...summary,
        fromBlock,
        toBlock: safeLatest,
        postSyncFromBlock: Math.min(reorgFromBlock, fromBlock),
        postSyncToBlock: safeLatest,
      }
      logger.info(
        {
          chain: chain.key,
          plugin: plugin.key,
          fromBlock,
          toBlock: safeLatest,
          chunkSize: chain.chunkSize,
        },
        'Sync pass starting',
      )

      const contract = new ethers.Contract(plugin.contractAddress, plugin.getInterface(), provider)
      const filter = plugin.buildFilter(contract)
      // queryFilter is wrapped with retry so a transient RPC blip doesn't fail
      // a whole chunk — adaptive shrinking still handles range-limit errors.
      const fetcher = (from: number, to: number): Promise<ethers.Event[]> =>
        withRetry(() => contract.queryFilter(filter, from, to), {
          policy: config.retry,
          logger,
          label: `${plugin.key}-queryFilter(${from}-${to})`,
          signal,
        })

      for await (const { range, events } of adaptiveFetchLogs(fromBlock, safeLatest, fetcher, {
        initialChunkSize: chain.chunkSize,
        minChunkSize: chain.minChunkSize,
        maxRetries: chain.maxChunkRetries,
        logger,
        signal,
      })) {
        const end = metrics.chunkDuration.startTimer({ ...labels, outcome: 'ok' })
        try {
          // Block timestamps drive any time-bucketed downstream rollup. Fetch
          // them per unique block in the chunk — one RPC call per block,
          // bounded concurrency, retried on transient errors.
          const blockTimestamps = await fetchBlockTimestamps(
            events.map((e) => e.blockNumber),
            provider,
            {
              policy: config.retry,
              logger,
              label: `${plugin.key}-blockTs`,
              signal,
            },
          )
          const parsed = plugin.parse(events, {
            chainId: plugin.chainId,
            chainKey: plugin.chainKey,
            contractAddress: plugin.contractAddress,
            blockTimestamps,
          })
          if (events.length !== parsed.length) {
            logger.warn(
              { fetched: events.length, parsed: parsed.length, range, plugin: plugin.key },
              'Some logs did not match the plugin ABI and were skipped',
            )
          }
          const { insertedCount, duplicateCount } = await plugin.persistChunk(parsed)
          // advanceCheckpoint MUST follow persistChunk: a crash between the two
          // replays the chunk on next boot, which is safe (idempotent insert).
          // The reverse order would lose events.
          await syncState.advanceCheckpoint(key, range.toBlock)
          summary.rangesProcessed += 1
          summary.eventsFound += parsed.length
          summary.eventsInserted += insertedCount
          summary.duplicates += duplicateCount
          metrics.chunkEvents.observe(labels, parsed.length)
          metrics.eventsInserted.inc(labels, insertedCount)
          metrics.eventsDuplicates.inc(labels, duplicateCount)
          metrics.lastSyncedBlock.set(labels, range.toBlock)
          end({ outcome: 'ok' })
          logger.info(
            {
              chain: chain.key,
              plugin: plugin.key,
              range,
              events: parsed.length,
              inserted: insertedCount,
              duplicates: duplicateCount,
            },
            'Chunk persisted, checkpoint advanced',
          )
        } catch (err) {
          end({ outcome: 'error' })
          throw err
        }
      }

      if (signal?.aborted) {
        summary.aborted = true
        logger.warn({ chain: chain.key, plugin: plugin.key }, 'Sync pass aborted between chunks')
      }

      // (6) Post-sync hook over the *union* of (reorg window, forward range).
      // Plugins use this for derived state (token enrichment, aggregate
      // rebuild). Skipped on abort so a half-finished pass doesn't half-update
      // rollups. The union range matters: if reorg reconciliation restored or
      // removed rows in [reorgFromBlock, fromBlock-1], a forward-only window
      // would silently skip those blocks.
      if (plugin.onPostSync && !signal?.aborted) {
        try {
          await plugin.onPostSync({
            fromBlock: summary.postSyncFromBlock,
            toBlock: summary.postSyncToBlock,
            provider,
            signal,
          })
        } catch (err) {
          logger.error(
            { chain: chain.key, plugin: plugin.key, err: (err as Error).message },
            'Plugin onPostSync failed (non-fatal)',
          )
        }
      }

      await syncState.markIdle(key)
      metrics.syncPasses.inc({ ...labels, outcome: summary.aborted ? 'aborted' : 'ok' })
      logger.info({ chain: chain.key, plugin: plugin.key, summary }, 'Sync pass complete')
      return summary
    } catch (err) {
      const msg = (err as Error).message
      logger.error({ chain: chain.key, plugin: plugin.key, err: msg }, 'Sync pass failed')
      metrics.syncPasses.inc({ ...labels, outcome: 'error' })
      metrics.rpcErrors.inc({ ...labels, kind: classifyError(err) })
      await syncState.markError(key, msg).catch(() => undefined)
      throw err
    }
  }
}

function defaultProviderFor(
  _plugin: ContractEventPlugin,
  chain: ChainIndexConfig,
): ethers.providers.Provider {
  return providerFactory.create(chain.rpcUrls, chain.chainId)
}

function classifyError(err: unknown): string {
  const message = (err as Error).message?.toLowerCase() ?? ''
  if (message.includes('range')) return 'range'
  if (message.includes('timeout')) return 'timeout'
  if (message.includes('rate')) return 'rate_limit'
  if (message.includes('econn')) return 'network'
  return 'other'
}
