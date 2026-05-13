/**
 * Verifies the FeeCollector plugin's `onPostSync` receives the *union* of the
 * reorg window and the forward range. The runner forwards
 * `[reorgFromBlock, safeLatest]` so blocks where the reorg pass
 * marked / restored rows still flow into the aggregate rebuild.
 */
import pino from 'pino'
import type { ChainIndexConfig } from '../../src/app/config'
import { FeeCollectorFeesCollectedPlugin } from '../../src/plugins/feeCollector/plugin'
import { FeeEventRepository } from '../../src/plugins/feeCollector/repository'
import { AggregateRepository } from '../../src/db/repositories/aggregateRepository'
import { TokenRepository } from '../../src/db/repositories/tokenRepository'
import { AggregateService } from '../../src/services/aggregates/aggregateService'
import { TokenEnrichmentService } from '../../src/services/tokens/tokenEnrichmentService'

const logger = pino({ level: 'silent' })

const CHAIN: ChainIndexConfig = {
  key: 'polygon',
  chainId: 137,
  rpcUrls: ['http://stub'],
  feeCollectorAddress: '0xabc',
  startBlock: 100,
  confirmations: 0,
  chunkSize: 1000,
  minChunkSize: 100,
  maxChunkRetries: 1,
  reorgWindow: 5,
}

function buildPlugin(opts: { rebuildSpy: jest.Mock }) {
  const aggregateRepo = new AggregateRepository()
  const aggregateService = new AggregateService(aggregateRepo)
  // Replace the underlying rebuild call so we can spy on the bounds the plugin
  // forwards from the runner. The real repo would hit Mongo.
  ;(aggregateRepo as unknown as { rebuildFromFeeEvents: jest.Mock }).rebuildFromFeeEvents =
    opts.rebuildSpy

  return new FeeCollectorFeesCollectedPlugin(CHAIN, {
    feeEvents: new FeeEventRepository(),
    tokens: new TokenRepository(),
    aggregates: aggregateRepo,
    aggregateService,
    tokenEnrichment: new TokenEnrichmentService({
      feeEvents: new FeeEventRepository(),
      tokens: new TokenRepository(),
      logger,
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    }),
    logger,
    retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    aggregatesEnabled: true,
    tokenEnrichmentEnabled: false,
  })
}

describe('FeeCollector plugin onPostSync union range', () => {
  it('forwards the union (reorg-window start, forward end) to aggregate rebuild', async () => {
    const rebuildSpy = jest.fn().mockResolvedValue(undefined)
    const plugin = buildPlugin({ rebuildSpy })

    // Simulate what SyncRunner computes when reorg ran from 95 and the
    // forward range was 100..150: the runner forwards `{fromBlock: 95, toBlock: 150}`.
    await plugin.onPostSync!({
      fromBlock: 95,
      toBlock: 150,
      provider: {} as never,
    })

    expect(rebuildSpy).toHaveBeenCalledTimes(1)
    expect(rebuildSpy).toHaveBeenCalledWith(137, 95, 150)
  })

  it('no-ops gracefully when fromBlock > toBlock', async () => {
    const rebuildSpy = jest.fn().mockResolvedValue(undefined)
    const plugin = buildPlugin({ rebuildSpy })
    await plugin.onPostSync!({
      fromBlock: 200,
      toBlock: 100,
      provider: {} as never,
    })
    expect(rebuildSpy).not.toHaveBeenCalled()
  })
})
