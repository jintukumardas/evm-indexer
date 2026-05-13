/**
 * Integration test for the generic reorg pass driven by a FeeCollector plugin.
 *
 * Replaces the older `ReorgReconciler`-specific test — same behavioural
 * coverage (reorg-out / replacement / restore) but exercising the generic
 * `ReorgRunner` against the new plugin interface, so the contract between
 * runner and plugin is what's actually verified.
 */
import mongoose from 'mongoose'
import { MongoMemoryServer } from 'mongodb-memory-server'
import pino from 'pino'
import { ethers } from 'ethers'
import { FeeEventModel } from '../../src/db/models/FeeEvent'
import { FeeEventRepository } from '../../src/plugins/feeCollector/repository'
import { ReorgRunner } from '../../src/indexer/reorgRunner'
import { FeeCollectorFeesCollectedPlugin } from '../../src/plugins/feeCollector/plugin'
import { AggregateRepository } from '../../src/db/repositories/aggregateRepository'
import { TokenRepository } from '../../src/db/repositories/tokenRepository'
import { AggregateService } from '../../src/services/aggregates/aggregateService'
import { TokenEnrichmentService } from '../../src/services/tokens/tokenEnrichmentService'
import { FEE_COLLECTOR_ABI } from '../../src/blockchain/contracts/feeCollector'
import type { ChainIndexConfig } from '../../src/app/config'
import type { NormalizedFeeEvent } from '../../src/types'

let mongoServer: MongoMemoryServer
const repo = new FeeEventRepository()
const logger = pino({ level: 'silent' })

const CHAIN: ChainIndexConfig = {
  key: 'polygon',
  chainId: 137,
  rpcUrls: ['http://stub'],
  feeCollectorAddress: '0xbd6c7b0d2f68c2b7805d88388319cfb6ecb50ea9',
  startBlock: 0,
  confirmations: 0,
  chunkSize: 1000,
  minChunkSize: 100,
  maxChunkRetries: 3,
  reorgWindow: 10,
}

function buildPlugin(): FeeCollectorFeesCollectedPlugin {
  const aggregateRepository = new AggregateRepository()
  const tokenRepository = new TokenRepository()
  return new FeeCollectorFeesCollectedPlugin(CHAIN, {
    feeEvents: repo,
    tokens: tokenRepository,
    aggregates: aggregateRepository,
    aggregateService: new AggregateService(aggregateRepository),
    tokenEnrichment: new TokenEnrichmentService({
      feeEvents: repo,
      tokens: tokenRepository,
      logger,
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    }),
    logger,
    retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    tokenEnrichmentEnabled: false,
    aggregatesEnabled: false,
  })
}

function makeEvent(over: Partial<NormalizedFeeEvent> = {}): NormalizedFeeEvent {
  return {
    chainId: 137,
    chainKey: 'polygon',
    contractAddress: CHAIN.feeCollectorAddress,
    blockNumber: 100,
    blockHash: '0x' + 'b'.repeat(64),
    blockTimestamp: 1_700_000_000,
    transactionHash: '0x' + 'a'.repeat(64),
    logIndex: 0,
    token: '0x' + '1'.repeat(40),
    integrator: '0x' + '2'.repeat(40),
    integratorFee: '1',
    lifiFee: '2',
    removed: false,
    eventName: 'FeesCollected',
    ...over,
  }
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create()
  await mongoose.connect(mongoServer.getUri())
  await FeeEventModel.syncIndexes()
})
afterEach(async () => {
  await FeeEventModel.deleteMany({})
})
afterAll(async () => {
  await mongoose.disconnect()
  await mongoServer.stop()
})

function encodeLog(args: {
  token: string
  integrator: string
  integratorFee: string
  lifiFee: string
  blockNumber: number
  txHash: string
  logIndex: number
  blockHash?: string
}): ethers.Event {
  const iface = new ethers.utils.Interface(JSON.stringify(FEE_COLLECTOR_ABI))
  const topic0 = iface.getEventTopic(iface.getEvent('FeesCollected'))
  const data = ethers.utils.defaultAbiCoder.encode(
    ['uint256', 'uint256'],
    [args.integratorFee, args.lifiFee],
  )
  return {
    blockNumber: args.blockNumber,
    blockHash: args.blockHash ?? '0x' + 'b'.repeat(64),
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

/**
 * Patches `ethers.Contract.prototype.queryFilter` to return the pre-canned
 * events. The reorg runner builds a fresh contract via `new ethers.Contract(
 * address, iface, provider)`, so the prototype-level patch intercepts every
 * call within this test's scope. Cleanup in `afterEach`.
 */
function fakeProviderReturning(events: ethers.Event[]): ethers.providers.Provider {
  const provider = new ethers.providers.StaticJsonRpcProvider('http://stub', 137)
  ;(ethers.Contract.prototype as unknown as { queryFilter: jest.Mock }).queryFilter = jest
    .fn()
    .mockResolvedValue(events) as never
  ;(provider as unknown as { getBlock: jest.Mock }).getBlock = jest
    .fn()
    .mockImplementation(async (n: number) => ({ number: n, timestamp: 1_700_000_000 }))
  return provider
}

afterEach(() => {
  delete (ethers.Contract.prototype as unknown as { queryFilter?: unknown }).queryFilter
})

describe('ReorgRunner + FeeCollector plugin', () => {
  const retry = { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 }

  it('returns null when reorgWindow is 0 (disabled)', async () => {
    const runner = new ReorgRunner({ logger, retry })
    const provider = new ethers.providers.StaticJsonRpcProvider('http://stub', 137)
    const result = await runner.reconcile(
      buildPlugin(),
      { ...CHAIN, reorgWindow: 0 },
      provider,
      100,
    )
    expect(result).toBeNull()
  })

  it('marks persisted events as removed when RPC no longer returns them', async () => {
    await repo.bulkInsert([
      makeEvent({ blockNumber: 95, transactionHash: '0xt1' }),
      makeEvent({ blockNumber: 96, transactionHash: '0xt2' }),
      makeEvent({ blockNumber: 97, transactionHash: '0xt3' }),
    ])
    const provider = fakeProviderReturning([
      encodeLog({
        token: '0x' + '1'.repeat(40),
        integrator: '0x' + '2'.repeat(40),
        integratorFee: '1',
        lifiFee: '2',
        blockNumber: 95,
        txHash: '0xt1',
        logIndex: 0,
      }),
      encodeLog({
        token: '0x' + '1'.repeat(40),
        integrator: '0x' + '2'.repeat(40),
        integratorFee: '1',
        lifiFee: '2',
        blockNumber: 97,
        txHash: '0xt3',
        logIndex: 0,
      }),
    ])
    const runner = new ReorgRunner({ logger, retry })
    const result = await runner.reconcile(buildPlugin(), CHAIN, provider, 100)
    expect(result?.reorgedOut).toBe(1)
    const reorgedRow = await FeeEventModel.findOne({ transactionHash: '0xt2' }).lean()
    expect(reorgedRow?.removed).toBe(true)
    const liveRow = await FeeEventModel.findOne({ transactionHash: '0xt1' }).lean()
    expect(liveRow?.removed).toBe(false)
  })

  it('upserts events that exist in RPC but not in DB (replacement chain)', async () => {
    await repo.bulkInsert([makeEvent({ blockNumber: 95, transactionHash: '0xt1' })])
    const provider = fakeProviderReturning([
      encodeLog({
        token: '0x' + '1'.repeat(40),
        integrator: '0x' + '2'.repeat(40),
        integratorFee: '1',
        lifiFee: '2',
        blockNumber: 95,
        txHash: '0xt1',
        logIndex: 0,
      }),
      encodeLog({
        token: '0x' + '1'.repeat(40),
        integrator: '0x' + '2'.repeat(40),
        integratorFee: '1',
        lifiFee: '2',
        blockNumber: 96,
        txHash: '0xreplacement',
        logIndex: 0,
      }),
    ])
    const runner = new ReorgRunner({ logger, retry })
    const result = await runner.reconcile(buildPlugin(), CHAIN, provider, 100)
    expect(result?.newlySeen).toBe(1)
    const newRow = await FeeEventModel.findOne({ transactionHash: '0xreplacement' }).lean()
    expect(newRow).not.toBeNull()
  })

  it('restores previously-removed events that come back to the canonical chain', async () => {
    await repo.bulkInsert([makeEvent({ blockNumber: 95, transactionHash: '0xt1' })])
    await repo.markRemoved([
      {
        chainId: 137,
        contractAddress: CHAIN.feeCollectorAddress,
        blockNumber: 95,
        transactionHash: '0xt1',
        logIndex: 0,
      },
    ])
    expect((await FeeEventModel.findOne({ transactionHash: '0xt1' }).lean())?.removed).toBe(true)

    const provider = fakeProviderReturning([
      encodeLog({
        token: '0x' + '1'.repeat(40),
        integrator: '0x' + '2'.repeat(40),
        integratorFee: '1',
        lifiFee: '2',
        blockNumber: 95,
        txHash: '0xt1',
        logIndex: 0,
      }),
    ])
    const runner = new ReorgRunner({ logger, retry })
    const result = await runner.reconcile(buildPlugin(), CHAIN, provider, 100)
    expect(result?.restored).toBe(1)
    expect((await FeeEventModel.findOne({ transactionHash: '0xt1' }).lean())?.removed).toBe(false)
  })
})
