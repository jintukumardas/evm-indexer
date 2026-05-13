import mongoose from 'mongoose'
import request from 'supertest'
import { MongoMemoryServer } from 'mongodb-memory-server'
import pino from 'pino'
import { buildApp } from '../../src/api/app'
import { FeeEventModel } from '../../src/db/models/FeeEvent'
import { FeeEventRepository } from '../../src/plugins/feeCollector/repository'
import { FeeCollectorFeesCollectedPlugin } from '../../src/plugins/feeCollector/plugin'
import { AggregateRepository } from '../../src/db/repositories/aggregateRepository'
import { TokenRepository } from '../../src/db/repositories/tokenRepository'
import { AggregateService } from '../../src/services/aggregates/aggregateService'
import { TokenEnrichmentService } from '../../src/services/tokens/tokenEnrichmentService'
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
  reorgWindow: 0,
}

const aggregateRepository = new AggregateRepository()
const tokenRepository = new TokenRepository()
const plugin = new FeeCollectorFeesCollectedPlugin(CHAIN, {
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

const app = buildApp({ plugins: [plugin] })

const INTEGRATOR = '0x000000000000000000000000000000000000dead'

function makeEvent(overrides: Partial<NormalizedFeeEvent> = {}): NormalizedFeeEvent {
  return {
    chainId: 137,
    chainKey: 'polygon',
    contractAddress: CHAIN.feeCollectorAddress,
    blockNumber: 1,
    blockHash: '0x' + 'b'.repeat(64),
    blockTimestamp: 1_700_000_000,
    transactionHash: '0x' + 'a'.repeat(64),
    logIndex: 0,
    token: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    integrator: INTEGRATOR,
    integratorFee: '1',
    lifiFee: '2',
    removed: false,
    eventName: 'FeesCollected',
    ...overrides,
  }
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create()
  await mongoose.connect(mongoServer.getUri())
  await FeeEventModel.syncIndexes()
})

afterAll(async () => {
  await mongoose.disconnect()
  await mongoServer.stop()
})

afterEach(async () => {
  await FeeEventModel.deleteMany({})
})

describe('GET /health', () => {
  it('returns 200 ok when mongo is connected', async () => {
    const res = await request(app).get('/health')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ status: 'ok' })
  })
})

describe('GET /fee-events (mounted via FeeCollector plugin)', () => {
  it('400 when integrator is missing', async () => {
    const res = await request(app).get('/fee-events')
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('400 when integrator is malformed', async () => {
    const res = await request(app).get('/fee-events').query({ integrator: 'notanaddress' })
    expect(res.status).toBe(400)
  })

  it('returns events with pageInfo', async () => {
    await repo.bulkInsert([
      makeEvent({ blockNumber: 1, logIndex: 0, transactionHash: '0xt1' }),
      makeEvent({ blockNumber: 2, logIndex: 0, transactionHash: '0xt2' }),
      makeEvent({ blockNumber: 3, logIndex: 0, transactionHash: '0xt3' }),
    ])
    const res = await request(app).get('/fee-events').query({ integrator: INTEGRATOR, limit: 2 })
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(2)
    expect(res.body.data[0].blockNumber).toBe(3)
    expect(res.body.pageInfo.hasNextPage).toBe(true)
    expect(typeof res.body.pageInfo.nextCursor).toBe('string')
  })

  it('paginates with the returned cursor', async () => {
    await repo.bulkInsert([
      makeEvent({ blockNumber: 1, logIndex: 0, transactionHash: '0xt1' }),
      makeEvent({ blockNumber: 2, logIndex: 0, transactionHash: '0xt2' }),
      makeEvent({ blockNumber: 3, logIndex: 0, transactionHash: '0xt3' }),
    ])
    const r1 = await request(app).get('/fee-events').query({ integrator: INTEGRATOR, limit: 1 })
    expect(r1.body.data).toHaveLength(1)
    const cursor = r1.body.pageInfo.nextCursor
    const r2 = await request(app)
      .get('/fee-events')
      .query({ integrator: INTEGRATOR, limit: 1, cursor })
    expect(r2.body.data[0].blockNumber).toBe(2)
  })

  it('400 on a malformed cursor', async () => {
    const res = await request(app)
      .get('/fee-events')
      .query({ integrator: INTEGRATOR, cursor: 'garbage' })
    expect(res.status).toBe(400)
  })

  it('returns empty data for an integrator with no events', async () => {
    const res = await request(app)
      .get('/fee-events')
      .query({ integrator: '0x000000000000000000000000000000000000beef' })
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
    expect(res.body.pageInfo).toEqual({ hasNextPage: false, nextCursor: null })
  })

  it('404 on an unknown route', async () => {
    const res = await request(app).get('/does-not-exist')
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('NOT_FOUND')
  })
})
