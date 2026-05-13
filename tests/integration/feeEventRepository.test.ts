import mongoose from 'mongoose'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { FeeEventModel } from '../../src/db/models/FeeEvent'
import { FeeEventRepository } from '../../src/plugins/feeCollector/repository'
import type { NormalizedFeeEvent } from '../../src/types'

let mongoServer: MongoMemoryServer
const repo = new FeeEventRepository()

function makeEvent(overrides: Partial<NormalizedFeeEvent> = {}): NormalizedFeeEvent {
  return {
    chainId: 137,
    chainKey: 'polygon',
    contractAddress: '0xbd6c7b0d2f68c2b7805d88388319cfb6ecb50ea9',
    blockNumber: 78_600_001,
    blockHash: '0x' + 'b'.repeat(64),
    blockTimestamp: 1_700_000_000,
    transactionHash: '0x' + 'a'.repeat(64),
    logIndex: 0,
    token: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    integrator: '0x000000000000000000000000000000000000dead',
    integratorFee: '1000000000000000000',
    lifiFee: '500000000000000000',
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

afterEach(async () => {
  await FeeEventModel.deleteMany({})
})

afterAll(async () => {
  await mongoose.disconnect()
  await mongoServer.stop()
})

describe('FeeEventRepository.bulkInsert', () => {
  it('inserts new events', async () => {
    const res = await repo.bulkInsert([makeEvent(), makeEvent({ logIndex: 1 })])
    expect(res.insertedCount).toBe(2)
    expect(res.duplicateCount).toBe(0)
    expect(await FeeEventModel.countDocuments()).toBe(2)
  })

  it('is idempotent on duplicate identities (re-run safety)', async () => {
    const a = makeEvent()
    await repo.bulkInsert([a])
    const res = await repo.bulkInsert([a, makeEvent({ logIndex: 1 })])
    expect(res.insertedCount).toBe(1) // only the new logIndex=1
    expect(res.duplicateCount).toBe(1)
    expect(await FeeEventModel.countDocuments()).toBe(2)
  })

  it('returns zero counts on empty input', async () => {
    const res = await repo.bulkInsert([])
    expect(res).toEqual({ insertedCount: 0, duplicateCount: 0 })
  })
})

describe('FeeEventRepository.listByIntegrator', () => {
  const INTEGRATOR = '0x000000000000000000000000000000000000dead'

  beforeEach(async () => {
    // 5 events for INTEGRATOR across two blocks, 1 event for another integrator
    const events: NormalizedFeeEvent[] = [
      makeEvent({ blockNumber: 1, logIndex: 0, transactionHash: '0xt1' }),
      makeEvent({ blockNumber: 1, logIndex: 1, transactionHash: '0xt2' }),
      makeEvent({ blockNumber: 2, logIndex: 0, transactionHash: '0xt3' }),
      makeEvent({ blockNumber: 2, logIndex: 1, transactionHash: '0xt4' }),
      makeEvent({ blockNumber: 3, logIndex: 0, transactionHash: '0xt5' }),
      makeEvent({
        blockNumber: 3,
        logIndex: 1,
        transactionHash: '0xt6',
        integrator: '0x000000000000000000000000000000000000beef',
      }),
    ]
    await repo.bulkInsert(events)
  })

  it('returns events for the integrator only, sorted newest-first', async () => {
    const out = await repo.listByIntegrator({ integrator: INTEGRATOR, limit: 10 })
    expect(out.items).toHaveLength(5)
    expect(out.items.map((e) => [e.blockNumber, e.logIndex])).toEqual([
      [3, 0],
      [2, 1],
      [2, 0],
      [1, 1],
      [1, 0],
    ])
    expect(out.hasNextPage).toBe(false)
    expect(out.nextCursor).toBeNull()
  })

  it('supports cursor pagination', async () => {
    const page1 = await repo.listByIntegrator({ integrator: INTEGRATOR, limit: 2 })
    expect(page1.items.map((e) => [e.blockNumber, e.logIndex])).toEqual([
      [3, 0],
      [2, 1],
    ])
    expect(page1.hasNextPage).toBe(true)
    expect(page1.nextCursor).toMatchObject({ blockNumber: 2, logIndex: 1 })

    const page2 = await repo.listByIntegrator({
      integrator: INTEGRATOR,
      limit: 2,
      cursor: page1.nextCursor!,
    })
    expect(page2.items.map((e) => [e.blockNumber, e.logIndex])).toEqual([
      [2, 0],
      [1, 1],
    ])
    expect(page2.hasNextPage).toBe(true)

    const page3 = await repo.listByIntegrator({
      integrator: INTEGRATOR,
      limit: 2,
      cursor: page2.nextCursor!,
    })
    expect(page3.items.map((e) => [e.blockNumber, e.logIndex])).toEqual([[1, 0]])
    expect(page3.hasNextPage).toBe(false)
    expect(page3.nextCursor).toBeNull()
  })

  it('excludes events flagged removed:true (consistent with aggregates)', async () => {
    // Flag one row removed; the API listing should drop it even though the
    // unique row is still in the collection.
    await repo['listByIntegrator'] // ensure repo loaded
    await repo.markRemoved([
      {
        chainId: 137,
        contractAddress: '0xbd6c7b0d2f68c2b7805d88388319cfb6ecb50ea9',
        blockNumber: 3,
        transactionHash: '0xt5',
        logIndex: 0,
      },
    ])
    const out = await repo.listByIntegrator({ integrator: INTEGRATOR, limit: 10 })
    expect(out.items.map((e) => [e.blockNumber, e.logIndex, e.transactionHash])).toEqual([
      [2, 1, '0xt4'],
      [2, 0, '0xt3'],
      [1, 1, '0xt2'],
      [1, 0, '0xt1'],
    ])
  })

  it('cursor breaks ties on transactionHash when (blockNumber, logIndex) collide across contracts', async () => {
    // Two rows for the SAME integrator at the same (blockNumber, logIndex) but
    // different contractAddress + transactionHash — the broader cursor tuple
    // is what prevents the second one from being silently skipped.
    const contractB = '0x' + 'c'.repeat(40)
    await repo.bulkInsert([
      makeEvent({
        blockNumber: 50,
        logIndex: 7,
        transactionHash: '0xaa',
        contractAddress: contractB,
      }),
      makeEvent({
        blockNumber: 50,
        logIndex: 7,
        transactionHash: '0xbb',
      }),
    ])
    const page1 = await repo.listByIntegrator({ integrator: INTEGRATOR, limit: 1, chainId: 137 })
    // sort is desc on tx hash too, so '0xbb' comes before '0xaa'
    expect(page1.items[0].transactionHash).toBe('0xbb')
    expect(page1.nextCursor).toMatchObject({
      blockNumber: 50,
      logIndex: 7,
      transactionHash: '0xbb',
    })
    const page2 = await repo.listByIntegrator({
      integrator: INTEGRATOR,
      limit: 1,
      chainId: 137,
      cursor: page1.nextCursor!,
    })
    // The sibling row MUST appear next — proving the cursor didn't skip it.
    expect(page2.items[0].transactionHash).toBe('0xaa')
  })

  it('respects the chainId filter', async () => {
    await repo.bulkInsert([makeEvent({ chainId: 1, blockNumber: 99, transactionHash: '0xeth' })])
    const polygon = await repo.listByIntegrator({ integrator: INTEGRATOR, limit: 10, chainId: 137 })
    const eth = await repo.listByIntegrator({ integrator: INTEGRATOR, limit: 10, chainId: 1 })
    expect(polygon.items.every((i) => i.chainId === 137)).toBe(true)
    expect(eth.items.every((i) => i.chainId === 1)).toBe(true)
    expect(eth.items).toHaveLength(1)
  })
})
