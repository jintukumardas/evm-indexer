/**
 * One-shot backfill helper. Wraps the same SyncRunner the worker uses so an
 * operator can run a single pass without flipping `SYNC_RUN_ONCE` in prod env.
 * Idempotent: re-running just picks up from the persisted checkpoint.
 *
 * Optional CLI arg restricts the pass to a single chain: `tsx backfill.ts polygon`.
 */
import { loadConfig } from '../app/config'
import { getLogger } from '../app/logging'
import { AppError } from '../app/errors'
import { connectMongo, disconnectMongo } from '../db/mongo'
import { syncStateRepository } from '../db/repositories/syncStateRepository'
import { aggregateRepository } from '../db/repositories/aggregateRepository'
import { tokenRepository } from '../db/repositories/tokenRepository'
import { feeEventRepository } from '../plugins/feeCollector/repository'
import { AggregateService } from '../services/aggregates/aggregateService'
import { TokenEnrichmentService } from '../services/tokens/tokenEnrichmentService'
import { buildRegistry } from '../indexer/bootstrap'
import { SyncRunner } from '../indexer/syncRunner'
import { ReorgRunner } from '../indexer/reorgRunner'

async function main() {
  const config = loadConfig()
  const log = getLogger({ level: config.logLevel })
  await connectMongo({ uri: config.mongoUri })

  // Wire SIGINT/SIGTERM → AbortSignal so a Ctrl-C during a long backfill exits
  // cleanly between chunks instead of leaving the in-flight chunk in an
  // indeterminate state (especially token enrichment + aggregate rebuild).
  const abort = new AbortController()
  const stop = (sig: string) => {
    log.warn({ sig }, 'Backfill aborting on signal — finishing current chunk')
    abort.abort()
  }
  process.once('SIGINT', () => stop('SIGINT'))
  process.once('SIGTERM', () => stop('SIGTERM'))

  try {
    const aggregateService = new AggregateService(aggregateRepository)
    const tokenEnrichment = new TokenEnrichmentService({
      feeEvents: feeEventRepository,
      tokens: tokenRepository,
      logger: log,
      retry: config.retry,
    })
    const registry = buildRegistry(config, {
      feeEvents: feeEventRepository,
      tokens: tokenRepository,
      aggregates: aggregateRepository,
      aggregateService,
      tokenEnrichment,
      logger: log,
      retry: config.retry,
      config,
    })
    const runner = new SyncRunner({
      syncState: syncStateRepository,
      logger: log,
      config,
    })
    const reorgRunner = new ReorgRunner({ logger: log, retry: config.retry })

    const chainKeyArg = process.argv[2]
    for (const plugin of registry.list()) {
      if (abort.signal.aborted) break
      if (chainKeyArg && plugin.chainKey !== chainKeyArg) continue
      const chain = config.chains.find((c) => c.key === plugin.chainKey)
      if (!chain) continue
      log.info({ plugin: plugin.key }, 'Backfill pass starting')
      const summary = await runner.run(plugin, chain, abort.signal, { reorgRunner })
      log.info({ summary }, 'Backfill pass complete')
    }
  } finally {
    await disconnectMongo()
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof AppError ? `[${err.code}] ${err.message}` : err)
  process.exit(1)
})
