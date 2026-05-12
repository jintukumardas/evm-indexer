import type { Logger } from 'pino'
import type { AppConfig } from '../app/config'
import type { RetryPolicy } from '../blockchain/providers/retry'
import { AggregateRepository } from '../db/repositories/aggregateRepository'
import { TokenRepository } from '../db/repositories/tokenRepository'
import { AggregateService } from '../services/aggregates/aggregateService'
import { TokenEnrichmentService } from '../services/tokens/tokenEnrichmentService'
import { createFeeCollectorPlugins } from '../plugins/feeCollector'
import { FeeEventRepository } from '../plugins/feeCollector/repository'
import { IndexerRegistry } from './registry'

/**
 * Shared dependencies that plugin factories may consume. Plugins decide
 * which ones they need — the FeeCollector plugin uses all of them, future
 * plugins will use whichever subset applies.
 */
export interface PluginDeps {
  feeEvents: FeeEventRepository
  tokens: TokenRepository
  aggregates: AggregateRepository
  aggregateService: AggregateService
  tokenEnrichment: TokenEnrichmentService
  logger: Logger
  retry: RetryPolicy
  config: AppConfig
}

/**
 * Build the indexer registry from configuration. This is the only place that
 * decides which plugins exist for a given deployment; the generic engine
 * (SyncRunner, ReorgRunner) does not know about any concrete plugin.
 *
 * **To add a new plugin**: write its factory in `src/plugins/<name>/` and call
 * its `createXyzPlugins(chain, deps)` inside the loop below.
 */
export function buildRegistry(config: AppConfig, deps: PluginDeps): IndexerRegistry {
  const registry = new IndexerRegistry()
  for (const chain of config.chains) {
    for (const plugin of createFeeCollectorPlugins(chain, deps)) {
      registry.register(plugin)
    }
    // NEXT STEP: register additional plugin factories here as they land, e.g.
    //   for (const p of createUniswapV3Plugins(chain, deps)) registry.register(p)
  }
  return registry
}
