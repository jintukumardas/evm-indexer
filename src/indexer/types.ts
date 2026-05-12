import type { ethers } from 'ethers'
import type { Express } from 'express'
import type { ChainIndexConfig } from '../app/config'

/**
 * Identity of a single on-chain event log. This 5-tuple is canonical for every
 * event the indexer persists; the unique index on each plugin's storage uses
 * the same tuple so re-running a chunk is idempotent.
 */
export interface EventIdentity {
  chainId: number
  contractAddress: string
  blockNumber: number
  transactionHash: string
  logIndex: number
}

/**
 * Identity-plus-tombstone row used by the reorg reconciler. A plugin returns
 * one of these per persisted row in the reorg window; the runner uses the
 * `removed` flag to decide whether a re-appeared event needs to be restored
 * (un-flagged) rather than re-inserted (which the unique index would drop).
 */
export interface IdentityRow {
  identity: EventIdentity
  removed: boolean
}

/**
 * Parse-time context the runner threads into every plugin's `parse()` call.
 * The block-timestamp map is fetched once per chunk by the generic runner,
 * so plugins never have to issue their own `getBlock` calls.
 */
export interface ParseContext {
  chainId: number
  chainKey: string
  contractAddress: string
  blockTimestamps: ReadonlyMap<number, number>
}

/**
 * Range passed to a plugin's optional post-sync hook.
 *
 * Important: `fromBlock` is the union of the reorg-window start and the
 * forward sync start. A plugin's hook (e.g. aggregate rebuild) must process
 * the full range, otherwise rows mutated by reorg reconciliation can be
 * skipped from derived rollups.
 */
export interface PluginPostSyncContext {
  fromBlock: number
  toBlock: number
  provider: ethers.providers.Provider
  signal?: AbortSignal
}

/**
 * The shape a Prometheus label set has when emitted by the runner. Always
 * carries both `chain` and `plugin` so two plugins on one chain (or one
 * plugin on multiple chains) don't collide in the same metric series.
 */
export interface MetricsLabels {
  chain: string
  plugin: string
}

/**
 * Persistence outcome from a chunk write. Same shape every plugin reports so
 * the runner can update generic counters.
 */
export interface PersistChunkResult {
  insertedCount: number
  duplicateCount: number
}

/**
 * A `ContractEventPlugin` owns everything contract- or event-specific:
 *  - the ABI / `ethers.utils.Interface`
 *  - the event filter built from that interface
 *  - the per-log parser (returns plugin-private `TNormalized`)
 *  - persistence + identity diff used by the reorg reconciler
 *  - optional post-sync work (token enrichment, aggregate rebuild, …)
 *  - optional express route registration
 *
 * The generic runners (`SyncRunner`, `ReorgRunner`) never look inside a
 * `TNormalized` — they go through `identityOf()` and the four persistence
 * methods. New plugins therefore plug in without touching the engine.
 */
export interface ContractEventPlugin<TNormalized = unknown> {
  /** Globally-unique slug, e.g. `polygon:feeCollector:FeesCollected`. */
  readonly key: string
  readonly chainKey: string
  readonly chainId: number
  readonly contractAddress: string
  readonly eventName: string
  readonly startBlock: number

  /** Label set emitted by the runner on every metric write for this plugin. */
  readonly metricsLabels: MetricsLabels

  getInterface(): ethers.utils.Interface
  buildFilter(contract: ethers.Contract): ethers.EventFilter
  parse(events: ethers.Event[], ctx: ParseContext): TNormalized[]
  identityOf(parsed: TNormalized): EventIdentity

  persistChunk(parsed: TNormalized[]): Promise<PersistChunkResult>
  /** Return identity + removed flag for every persisted row in the window. */
  findInRange(fromBlock: number, toBlock: number): Promise<IdentityRow[]>
  markRemoved(ids: EventIdentity[]): Promise<number>
  restoreRemoved(ids: EventIdentity[]): Promise<number>

  /** Optional: token enrichment, aggregate rebuilds, anything plugin-local. */
  onPostSync?(ctx: PluginPostSyncContext): Promise<void>

  /** Optional: mount plugin-owned express routes (e.g. /fee-events). */
  registerRoutes?(app: Express): void
}

/**
 * A `PluginFactory` produces zero or more plugins for one chain. A factory
 * returns a list (not a single plugin) so one contract module can grow new
 * events later without touching the worker entry.
 */
export type PluginFactory = (chain: ChainIndexConfig) => ContractEventPlugin[]
