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

/**
 * Worker entry point. Boots dependencies, populates the plugin registry, and
 * runs sync passes across every registered plugin, looping when
 * `SYNC_RUN_ONCE=false`.
 *
 * Graceful shutdown: SIGINT/SIGTERM flip an AbortController; the scanner
 * exits at the next chunk boundary, leaving the checkpoint at the last
 * persisted block. Idempotent restart picks up there.
 */
async function main(): Promise<void> {
  const config = loadConfig()
  const log = getLogger({ level: config.logLevel })
  log.info(
    {
      env: config.env,
      chains: config.chains.map((c) => ({
        key: c.key,
        chainId: c.chainId,
        startBlock: c.startBlock,
        confirmations: c.confirmations,
        chunkSize: c.chunkSize,
        reorgWindow: c.reorgWindow,
        rpcUrls: c.rpcUrls.length,
      })),
      runOnce: config.sync.runOnce,
      tokenEnrichmentEnabled: config.tokenEnrichmentEnabled,
      aggregatesEnabled: config.aggregatesEnabled,
    },
    'Starting indexer worker',
  )

  await connectMongo({ uri: config.mongoUri })

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

  log.info(
    { plugins: registry.list().map((p) => p.key) },
    'Plugin registry populated',
  )

  const runner = new SyncRunner({
    syncState: syncStateRepository,
    logger: log,
    config,
  })
  const reorgRunner = new ReorgRunner({ logger: log, retry: config.retry })

  const abort = new AbortController()
  const stop = (signal: string) => {
    log.warn({ signal }, 'Received shutdown signal — aborting at next safe boundary')
    abort.abort()
  }
  process.on('SIGINT', () => stop('SIGINT'))
  process.on('SIGTERM', () => stop('SIGTERM'))

  try {
    do {
      for (const plugin of registry.list()) {
        if (abort.signal.aborted) break
        const chain = config.chains.find((c) => c.key === plugin.chainKey)
        if (!chain) {
          log.error(
            { plugin: plugin.key, chainKey: plugin.chainKey },
            'No chain config matches plugin — skipping',
          )
          continue
        }
        try {
          await runner.run(plugin, chain, abort.signal, { reorgRunner })
        } catch (err) {
          log.error(
            { err: (err as Error).message, plugin: plugin.key, chain: plugin.chainKey },
            'Plugin sync pass failed',
          )
        }
      }
      if (!config.sync.runOnce && !abort.signal.aborted) {
        log.debug({ intervalMs: config.sync.intervalMs }, 'Sleeping before next pass')
        await sleep(config.sync.intervalMs, abort.signal)
      }
    } while (!config.sync.runOnce && !abort.signal.aborted)
  } finally {
    await disconnectMongo()
    log.info('Indexer worker exited cleanly')
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error('unhandledRejection', reason)
  process.exit(1)
})

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof AppError ? `[${err.code}] ${err.message}` : err)
  process.exit(1)
})

export {}
