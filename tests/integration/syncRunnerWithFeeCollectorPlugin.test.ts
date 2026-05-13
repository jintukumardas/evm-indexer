/**
 * Integration: SyncRunner driving the FeeCollector plugin against an in-memory
 * Mongo. Canned RPC events flow through the plugin's parser and land in the
 * `fee_events` collection in the expected normalized shape, and the
 * SyncState row advances to the safe head.
 */
import mongoose from 'mongoose'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { ethers } from 'ethers'
import pino from 'pino'
import { FeeEventModel } from '../../src/db/models/FeeEvent'
import { SyncStateModel } from '../../src/db/models/SyncState'
import { FeeEventRepository } from '../../src/plugins/feeCollector/repository'
import { FeeCollectorFeesCollectedPlugin } from '../../src/plugins/feeCollector/plugin'
import { AggregateRepository } from '../../src/db/repositories/aggregateRepository'
import { TokenRepository } from '../../src/db/repositories/tokenRepository'
import { AggregateService } from '../../src/services/aggregates/aggregateService'
import { TokenEnrichmentService } from '../../src/services/tokens/tokenEnrichmentService'
import { SyncStateRepository } from '../../src/db/repositories/syncStateRepository'
import { SyncRunner } from '../../src/indexer/syncRunner'
import { FEE_COLLECTOR_ABI } from '../../src/blockchain/contracts/feeCollector'
import type { AppConfig, ChainIndexConfig } from '../../src/app/config'

let mongoServer: MongoMemoryServer
const logger = pino({ level: 'silent' })

const CHAIN: ChainIndexConfig = {
  key: 'polygon',
  chainId: 137,
  rpcUrls: ['http://stub'],
  feeCollectorAddress: '0xbd6c7b0d2f68c2b7805d88388319cfb6ecb50ea9',
  startBlock: 100,
  confirmations: 0,
  chunkSize: 1000,
  minChunkSize: 100,
  maxChunkRetries: 1,
  reorgWindow: 0, // reorg off — covered by reorgReconciler.test.ts
}

const CONFIG: AppConfig = {
  env: 'test',
  logLevel: 'silent',
  api: { enabled: false, port: 0, rateLimit: { burst: 0, refillPerSec: 0 } },
  mongoUri: '',
  sync: { runOnce: true, intervalMs: 0 },
  retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
  tokenEnrichmentEnabled: false,
  aggregatesEnabled: false,
  chains: [CHAIN],
}

function encodeLog(args: {
  token: string
  integrator: string
  integratorFee: string
  lifiFee: string
  blockNumber: number
  txHash: string
  logIndex: number
}): ethers.Event {
  const iface = new ethers.utils.Interface(JSON.stringify(FEE_COLLECTOR_ABI))
  const topic0 = iface.getEventTopic(iface.getEvent('FeesCollected'))
  const data = ethers.utils.defaultAbiCoder.encode(
    ['uint256', 'uint256'],
    [args.integratorFee, args.lifiFee],
  )
  return {
    blockNumber: args.blockNumber,
    blockHash: '0x' + 'b'.repeat(64),
    transactionIndex: 0,
    removed: false,
    address: CHAIN.feeCollectorAddress,
    data,
    topics: [
      topic0,
      ethers.utils.hexZeroPad(args.token, 32),
      ethers.utils.hexZeroPad(args.integrator, 32),
    ],
    transactionHash: args.txHash,
    logIndex: args.logIndex,
  } as unknown as ethers.Event
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create()
  await mongoose.connect(mongoServer.getUri())
  await FeeEventModel.syncIndexes()
  await SyncStateModel.syncIndexes()
})
afterEach(async () => {
  await FeeEventModel.deleteMany({})
  await SyncStateModel.deleteMany({})
})
afterAll(async () => {
  await mongoose.disconnect()
  await mongoServer.stop()
})

afterEach(() => {
  delete (ethers.Contract.prototype as unknown as { queryFilter?: unknown }).queryFilter
})

it('SyncRunner + FeeCollector plugin indexes a canned event into fee_events and advances SyncState', async () => {
  const feeEvents = new FeeEventRepository()
  const aggregateRepository = new AggregateRepository()
  const tokenRepository = new TokenRepository()
  const aggregateService = new AggregateService(aggregateRepository)
  const tokenEnrichment = new TokenEnrichmentService({
    feeEvents,
    tokens: tokenRepository,
    logger,
    retry: CONFIG.retry,
  })

  const plugin = new FeeCollectorFeesCollectedPlugin(CHAIN, {
    feeEvents,
    tokens: tokenRepository,
    aggregates: aggregateRepository,
    aggregateService,
    tokenEnrichment,
    logger,
    retry: CONFIG.retry,
    aggregatesEnabled: false,
    tokenEnrichmentEnabled: false,
  })

  // Fake provider: returns safe-head 150 and a single canned FeesCollected log.
  const provider = new ethers.providers.StaticJsonRpcProvider('http://stub', 137)
  ;(provider as unknown as { getBlockNumber: jest.Mock }).getBlockNumber = jest
    .fn()
    .mockResolvedValue(150)
  ;(provider as unknown as { getBlock: jest.Mock }).getBlock = jest
    .fn()
    .mockImplementation(async (n: number) => ({ number: n, timestamp: 1_700_000_000 }))
  ;(ethers.Contract.prototype as unknown as { queryFilter: jest.Mock }).queryFilter = jest
    .fn()
    .mockResolvedValue([
      encodeLog({
        token: '0x' + '1'.repeat(40),
        integrator: '0x' + '2'.repeat(40),
        integratorFee: '1000000000000000000',
        lifiFee: '500000000000000000',
        blockNumber: 120,
        txHash: '0x' + 'a'.repeat(64),
        logIndex: 0,
      }),
    ]) as never

  const runner = new SyncRunner({
    syncState: new SyncStateRepository(),
    logger,
    config: CONFIG,
    providerFor: () => provider,
  })
  const summary = await runner.run(plugin, CHAIN)

  expect(summary.eventsInserted).toBe(1)
  expect(summary.fromBlock).toBe(100)
  expect(summary.toBlock).toBe(150)

  // The canned log landed in fee_events with the normalized shape.
  const stored = await FeeEventModel.findOne({}).lean()
  expect(stored).not.toBeNull()
  expect(stored!.chainId).toBe(137)
  expect(stored!.contractAddress).toBe(CHAIN.feeCollectorAddress)
  expect(stored!.token).toBe('0x' + '1'.repeat(40))
  expect(stored!.integrator).toBe('0x' + '2'.repeat(40))
  expect(stored!.integratorFee).toBe('1000000000000000000')
  expect(stored!.lifiFee).toBe('500000000000000000')
  expect(stored!.eventName).toBe('FeesCollected')

  // SyncState row advanced to the safe head and is keyed on the new tuple.
  const sync = await SyncStateModel.findOne({
    chainKey: 'polygon',
    contractAddress: CHAIN.feeCollectorAddress,
    eventName: 'FeesCollected',
  }).lean()
  expect(sync).not.toBeNull()
  expect(sync!.lastSyncedBlock).toBe(150)
  expect(sync!.status).toBe('idle')
})
