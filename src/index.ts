/**
 * API process entry point. The sync worker is a separate process — see
 * `src/jobs/syncIndexer.ts`. Splitting them lets you scale the read API
 * independently from the indexer worker.
 *
 * If API_ENABLED=false, this binary exits 0 immediately so the same image
 * can be deployed as either role.
 *
 * The API discovers its routes through the same plugin registry the worker
 * uses, so adding a new plugin (with `registerRoutes`) automatically exposes
 * its endpoints here.
 */
import { loadConfig } from './app/config'
import { getLogger } from './app/logging'
import { buildApp } from './api/app'
import { connectMongo, disconnectMongo } from './db/mongo'
import { buildRegistry } from './indexer/bootstrap'
import { aggregateRepository } from './db/repositories/aggregateRepository'
import { tokenRepository } from './db/repositories/tokenRepository'
import { feeEventRepository } from './plugins/feeCollector/repository'
import { AggregateService } from './services/aggregates/aggregateService'
import { TokenEnrichmentService } from './services/tokens/tokenEnrichmentService'

async function main(): Promise<void> {
  const config = loadConfig()
  const log = getLogger({ level: config.logLevel })

  if (!config.api.enabled) {
    log.info('API disabled (API_ENABLED=false); exiting')
    return
  }

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

  const app = buildApp({ rateLimit: config.api.rateLimit, plugins: registry.list() })
  const server = app.listen(config.api.port, () => {
    log.info(
      {
        port: config.api.port,
        rateLimit: config.api.rateLimit,
        plugins: registry.list().map((p) => p.key),
      },
      'API server listening',
    )
  })

  // Await both the HTTP close and the Mongo disconnect so in-flight requests
  // get a chance to finish before we tear the connection down. Without this,
  // a Ctrl-C during a slow query would respond 500 instead of completing.
  const shutdown = async (signal: string) => {
    log.warn({ signal }, 'Shutting down API')
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await disconnectMongo()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error('unhandledRejection', reason)
  process.exit(1)
})

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})
