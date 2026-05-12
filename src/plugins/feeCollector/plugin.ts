import type { ethers } from 'ethers'
import type { Logger } from 'pino'
import type { Express } from 'express'
import type { ChainIndexConfig } from '../../app/config'
import {
  FEES_COLLECTED_EVENT,
  getFeeCollectorInterface,
} from '../../blockchain/contracts/feeCollector'
import { parseFeeCollectorEvents } from '../../blockchain/parsers/feeCollectorParser'
import type { RetryPolicy } from '../../blockchain/providers/retry'
import { AggregateRepository } from '../../db/repositories/aggregateRepository'
import { TokenRepository } from '../../db/repositories/tokenRepository'
import { AggregateService } from '../../services/aggregates/aggregateService'
import { TokenEnrichmentService } from '../../services/tokens/tokenEnrichmentService'
import { FeeEventsService } from '../../services/fee-events/feeEventsService'
import type {
  ContractEventPlugin,
  EventIdentity,
  IdentityRow,
  MetricsLabels,
  ParseContext,
  PersistChunkResult,
  PluginPostSyncContext,
} from '../../indexer/types'
import type { NormalizedFeeEvent } from '../../types'
import { FeeEventRepository } from './repository'
import { mountFeeCollectorRoutes } from './routes'

export interface FeeCollectorPluginDeps {
  feeEvents: FeeEventRepository
  tokens: TokenRepository
  aggregates: AggregateRepository
  aggregateService: AggregateService
  tokenEnrichment: TokenEnrichmentService
  logger: Logger
  retry: RetryPolicy
  /** Whether `onPostSync` should rebuild aggregates / run token enrichment. */
  tokenEnrichmentEnabled: boolean
  aggregatesEnabled: boolean
}

const PLUGIN_NAME = 'feeCollector'

/**
 * The LI.FI `FeeCollector.FeesCollected` indexer expressed as a plugin.
 *
 * This is the first concrete `ContractEventPlugin`; the generic engine has
 * no other knowledge of FeeCollector. Adding a second event on the same
 * contract (or a different contract entirely) is a matter of cloning this
 * file under `src/plugins/<name>/` and registering it in
 * `src/indexer/bootstrap.ts`.
 */
export class FeeCollectorFeesCollectedPlugin
  implements ContractEventPlugin<NormalizedFeeEvent>
{
  readonly key: string
  readonly chainKey: string
  readonly chainId: number
  readonly contractAddress: string
  readonly eventName = FEES_COLLECTED_EVENT
  readonly startBlock: number
  readonly metricsLabels: MetricsLabels

  constructor(
    private readonly chain: ChainIndexConfig,
    private readonly deps: FeeCollectorPluginDeps,
  ) {
    this.chainKey = chain.key
    this.chainId = chain.chainId
    this.contractAddress = chain.feeCollectorAddress
    this.startBlock = chain.startBlock
    this.key = `${chain.key}:${PLUGIN_NAME}:${this.eventName}`
    this.metricsLabels = { chain: chain.key, plugin: PLUGIN_NAME }
  }

  getInterface(): ethers.utils.Interface {
    return getFeeCollectorInterface()
  }

  buildFilter(contract: ethers.Contract): ethers.EventFilter {
    return contract.filters.FeesCollected()
  }

  parse(events: ethers.Event[], ctx: ParseContext): NormalizedFeeEvent[] {
    return parseFeeCollectorEvents(events, ctx)
  }

  identityOf(parsed: NormalizedFeeEvent): EventIdentity {
    return {
      chainId: parsed.chainId,
      contractAddress: parsed.contractAddress,
      blockNumber: parsed.blockNumber,
      transactionHash: parsed.transactionHash,
      logIndex: parsed.logIndex,
    }
  }

  persistChunk(parsed: NormalizedFeeEvent[]): Promise<PersistChunkResult> {
    return this.deps.feeEvents.bulkInsert(parsed)
  }

  findInRange(fromBlock: number, toBlock: number): Promise<IdentityRow[]> {
    return this.deps.feeEvents.findIdentityRowsInRange(
      this.chainId,
      this.contractAddress,
      fromBlock,
      toBlock,
    )
  }

  markRemoved(ids: EventIdentity[]): Promise<number> {
    return this.deps.feeEvents.markRemoved(ids)
  }

  restoreRemoved(ids: EventIdentity[]): Promise<number> {
    return this.deps.feeEvents.restoreRemoved(ids)
  }

  /**
   * Post-sync derived state for FeesCollected:
   *   1. Rebuild daily aggregates over the union range. The runner passes the
   *      union of the reorg window and the forward range so any blocks
   *      mutated by reorg reconciliation are rolled into the aggregate sums.
   *   2. Resolve ERC20 metadata for any newly-seen tokens. Non-fatal — token
   *      enrichment errors are logged and persisted, never block the indexer.
   *
   * Both steps no-op when the corresponding feature flag is off in config.
   */
  async onPostSync(ctx: PluginPostSyncContext): Promise<void> {
    if (this.deps.aggregatesEnabled && ctx.fromBlock <= ctx.toBlock) {
      try {
        await this.deps.aggregateService.rebuild(this.chainId, ctx.fromBlock, ctx.toBlock)
      } catch (err) {
        this.deps.logger.error(
          { chain: this.chainKey, plugin: this.key, err: (err as Error).message },
          'Aggregate rebuild failed (non-fatal)',
        )
      }
    }
    if (this.deps.tokenEnrichmentEnabled && !ctx.signal?.aborted) {
      try {
        await this.deps.tokenEnrichment.enrich(this.chain, ctx.provider)
      } catch (err) {
        this.deps.logger.error(
          { chain: this.chainKey, plugin: this.key, err: (err as Error).message },
          'Token enrichment failed (non-fatal)',
        )
      }
    }
  }

  /**
   * Mount `/fee-events` and `/fee-events/aggregates`. The routes are mounted
   * once per process regardless of chain count — they query across all
   * chains in MongoDB and gate on `?chainId=`. We use a module-level guard
   * to avoid double-registration when multiple plugin instances run.
   */
  registerRoutes(app: Express): void {
    if (sharedRoutesMounted.has(app)) return
    sharedRoutesMounted.add(app)
    mountFeeCollectorRoutes(app, {
      feeEventsService: new FeeEventsService(this.deps.feeEvents),
      aggregateService: this.deps.aggregateService,
    })
  }
}

// Module-scoped guard — multiple FeeCollector plugins (one per chain) share
// the same HTTP surface, so the first one wins and the others no-op. The
// WeakSet keys on the app instance so tests that build new apps stay isolated.
const sharedRoutesMounted = new WeakSet<Express>()

/**
 * Inputs the factory accepts from `buildRegistry`. Wider than the plugin's
 * own `FeeCollectorPluginDeps` because the registry doesn't itself decide
 * whether token enrichment / aggregates are on — those flags live on
 * `AppConfig` and the factory threads them through.
 */
export interface FeeCollectorFactoryDeps {
  feeEvents: FeeEventRepository
  tokens: TokenRepository
  aggregates: AggregateRepository
  aggregateService: AggregateService
  tokenEnrichment: TokenEnrichmentService
  logger: Logger
  retry: RetryPolicy
  /**
   * Feature flags. The runner is generic, so per-plugin defaults are pulled
   * from `AppConfig` and forwarded here.
   */
  config: { tokenEnrichmentEnabled: boolean; aggregatesEnabled: boolean }
}

/**
 * Factory: returns one plugin per chain. Returns a list (not a single plugin)
 * so this module can register a new event later without churning the worker
 * entry — e.g. adding a `FeeCollector.FeesWithdrawn` indexer would just push
 * a second instance into this array.
 */
export function createFeeCollectorPlugins(
  chain: ChainIndexConfig,
  deps: FeeCollectorFactoryDeps,
): ContractEventPlugin[] {
  return [
    new FeeCollectorFeesCollectedPlugin(chain, {
      feeEvents: deps.feeEvents,
      tokens: deps.tokens,
      aggregates: deps.aggregates,
      aggregateService: deps.aggregateService,
      tokenEnrichment: deps.tokenEnrichment,
      logger: deps.logger,
      retry: deps.retry,
      tokenEnrichmentEnabled: deps.config.tokenEnrichmentEnabled,
      aggregatesEnabled: deps.config.aggregatesEnabled,
    }),
  ]
}
