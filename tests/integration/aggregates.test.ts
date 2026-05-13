import mongoose from 'mongoose'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { FeeEventModel } from '../../src/db/models/FeeEvent'
import { DailyAggregateModel } from '../../src/db/models/DailyAggregate'
import { FeeEventRepository } from '../../src/plugins/feeCollector/repository'
import { AggregateRepository } from '../../src/db/repositories/aggregateRepository'
import type { NormalizedFeeEvent } from '../../src/types'

let mongoServer: MongoMemoryServer
const feeRepo = new FeeEventRepository()
const aggRepo = new AggregateRepository()

// 2024-04-01T00:00:00Z and 2024-04-02T00:00:00Z as unix seconds.
const DAY_2024_04_01_UTC = 1_711_929_600
const DAY_2024_04_02_UTC = 1_712_016_000

function ev(over: Partial<NormalizedFeeEvent>): NormalizedFeeEvent {
  return {
    chainId: 137,
    chainKey: 'polygon',
    contractAddress: '0xbd6c7b0d2f68c2b7805d88388319cfb6ecb50ea9',
    blockNumber: 1,
    blockHash: '0x' + 'b'.repeat(64),
    blockTimestamp: DAY_2024_04_01_UTC,
    transactionHash: '0xt',
    logIndex: 0,
    token: '0x' + '1'.repeat(40),
    integrator: '0x' + '2'.repeat(40),
    integratorFee: '1000000000000000000',
    lifiFee: '500000000000000000',
    removed: false,
    eventName: 'FeesCollected',
    ...over,
  }
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create()
  await mongoose.connect(mongoServer.getUri())
  await FeeEventModel.syncIndexes()
  await DailyAggregateModel.syncIndexes()
})

afterEach(async () => {
  await FeeEventModel.deleteMany({})
  await DailyAggregateModel.deleteMany({})
})

afterAll(async () => {
  await mongoose.disconnect()
  await mongoServer.stop()
})

describe('AggregateRepository.rebuildFromFeeEvents', () => {
  it('sums fees per (integrator, token, day) and writes daily aggregates', async () => {
    // Two events same integrator/token/day → should sum
    await feeRepo.bulkInsert([
      ev({
        blockNumber: 1,
        transactionHash: '0xa',
        integratorFee: '1000000000000000000',
        lifiFee: '500000000000000000',
        blockTimestamp: DAY_2024_04_01_UTC + 12 * 3600,
      }),
      ev({
        blockNumber: 2,
        transactionHash: '0xb',
        integratorFee: '2000000000000000000',
        lifiFee: '1000000000000000000',
        blockTimestamp: DAY_2024_04_01_UTC + 13 * 3600,
      }),
    ])

    await aggRepo.rebuildFromFeeEvents(137, 0, 10)
    const rows = await DailyAggregateModel.find().lean()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      chainId: 137,
      integrator: '0x' + '2'.repeat(40),
      token: '0x' + '1'.repeat(40),
      day: '2024-04-01',
      integratorFeeSum: '3000000000000000000',
      lifiFeeSum: '1500000000000000000',
      eventCount: 2,
    })
  })

  it('produces separate rows per day and per token', async () => {
    await feeRepo.bulkInsert([
      ev({ blockNumber: 1, transactionHash: '0xa', blockTimestamp: DAY_2024_04_01_UTC }),
      ev({
        blockNumber: 2,
        transactionHash: '0xb',
        token: '0x' + '3'.repeat(40),
        blockTimestamp: DAY_2024_04_01_UTC,
      }),
      ev({ blockNumber: 3, transactionHash: '0xc', blockTimestamp: DAY_2024_04_02_UTC }),
    ])
    await aggRepo.rebuildFromFeeEvents(137, 0, 10)
    const rows = await DailyAggregateModel.find().sort({ day: 1, token: 1 }).lean()
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => `${r.day}|${r.token}|${r.eventCount}`)).toEqual([
      `2024-04-01|0x${'1'.repeat(40)}|1`,
      `2024-04-01|0x${'3'.repeat(40)}|1`,
      `2024-04-02|0x${'1'.repeat(40)}|1`,
    ])
  })

  it('excludes events flagged as removed (reorged out)', async () => {
    await feeRepo.bulkInsert([
      ev({ blockNumber: 1, transactionHash: '0xa', blockTimestamp: DAY_2024_04_01_UTC }),
      ev({
        blockNumber: 2,
        transactionHash: '0xb',
        removed: true,
        blockTimestamp: DAY_2024_04_01_UTC,
      }),
    ])
    await aggRepo.rebuildFromFeeEvents(137, 0, 10)
    const rows = await DailyAggregateModel.find().lean()
    expect(rows).toHaveLength(1)
    expect(rows[0].eventCount).toBe(1)
  })

  it('rebuild is idempotent (re-running produces identical rows)', async () => {
    await feeRepo.bulkInsert([
      ev({ blockNumber: 1, transactionHash: '0xa', blockTimestamp: DAY_2024_04_01_UTC }),
    ])
    await aggRepo.rebuildFromFeeEvents(137, 0, 10)
    await aggRepo.rebuildFromFeeEvents(137, 0, 10)
    const rows = await DailyAggregateModel.find().lean()
    expect(rows).toHaveLength(1)
    expect(rows[0].eventCount).toBe(1)
  })

  it('two incremental passes touching the same day accumulate (regression)', async () => {
    // This is the scenario that the old `$merge: replace` logic corrupted:
    //   pass 1 indexes block 1 → writes day-X aggregate {fee=1, count=1}
    //   pass 2 indexes block 1000 (same UTC day) → if the rebuild only
    //   re-aggregated pass 2's range, the new row would overwrite pass 1's
    //   contribution. The fix recomputes the *whole day* whenever the new
    //   range touches it, so both events stay in the sum.
    const dayTs = DAY_2024_04_01_UTC + 12 * 3600

    // --- Pass 1 ---
    await feeRepo.bulkInsert([
      ev({
        blockNumber: 1,
        transactionHash: '0xa',
        integratorFee: '1000',
        lifiFee: '500',
        blockTimestamp: dayTs,
      }),
    ])
    await aggRepo.rebuildFromFeeEvents(137, 0, 10)

    let rows = await DailyAggregateModel.find().lean()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      day: '2024-04-01',
      integratorFeeSum: '1000',
      lifiFeeSum: '500',
      eventCount: 1,
    })

    // --- Pass 2: a later block with the SAME integrator+token+day ---
    await feeRepo.bulkInsert([
      ev({
        blockNumber: 1000,
        transactionHash: '0xb',
        integratorFee: '4000',
        lifiFee: '2500',
        blockTimestamp: dayTs,
      }),
    ])
    // The crucial bit — pass 2's rebuild range is [500, 2000], i.e. ONLY the
    // new block. The old code would emit {fee=4000, count=1} and `$merge
    // replace` would clobber pass 1's contribution.
    await aggRepo.rebuildFromFeeEvents(137, 500, 2000)

    rows = await DailyAggregateModel.find().lean()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      day: '2024-04-01',
      integratorFeeSum: '5000', // 1000 + 4000
      lifiFeeSum: '3000', // 500 + 2500
      eventCount: 2,
    })
  })

  it('deletes the stale aggregate when all events for a (integrator,token,day) are reorged out (regression)', async () => {
    // The bug: Step 1 used to filter `removed:$ne:true`, so a tuple whose only
    // events all got flagged removed disappeared from `affectedDays` and its
    // aggregate row was never touched again. The API then over-reported fees
    // forever for that day.
    const integrator = '0x' + '2'.repeat(40)
    const token = '0x' + '1'.repeat(40)

    // Pass 1: one event lands.
    await feeRepo.bulkInsert([
      ev({
        blockNumber: 100,
        transactionHash: '0xa',
        integratorFee: '5000',
        lifiFee: '1000',
        blockTimestamp: DAY_2024_04_01_UTC,
      }),
    ])
    await aggRepo.rebuildFromFeeEvents(137, 0, 200)

    let rows = await DailyAggregateModel.find().lean()
    expect(rows).toHaveLength(1)
    expect(rows[0].eventCount).toBe(1)

    // Pass 2: that event gets reorged out — we mark it removed and rebuild
    // over the same range. The aggregate row for (integrator, token, day)
    // must be GONE, not stale.
    await feeRepo.markRemoved([
      {
        chainId: 137,
        contractAddress: '0xbd6c7b0d2f68c2b7805d88388319cfb6ecb50ea9',
        blockNumber: 100,
        transactionHash: '0xa',
        logIndex: 0,
      },
    ])
    await aggRepo.rebuildFromFeeEvents(137, 0, 200)

    rows = await DailyAggregateModel.find().lean()
    expect(rows).toHaveLength(0)
    // Direct check on the specific tuple in case other test pollution exists.
    const stale = await DailyAggregateModel.findOne({
      chainId: 137,
      integrator,
      token,
      day: '2024-04-01',
    }).lean()
    expect(stale).toBeNull()
  })

  it('removes a per-tuple aggregate row when other tuples on the same day survive (regression)', async () => {
    // Same root bug, finer slice: the day is still affected by other events,
    // but the specific (integrator, token) that got fully reorged out emits
    // no group key. `$merge` then leaves its old row untouched — we delete
    // the slice first so it disappears.
    const integratorA = '0x' + '2'.repeat(40)
    const integratorB = '0x' + '3'.repeat(40)
    const token = '0x' + '1'.repeat(40)

    await feeRepo.bulkInsert([
      ev({
        blockNumber: 100,
        transactionHash: '0xa',
        integrator: integratorA,
        integratorFee: '5000',
        lifiFee: '1000',
        blockTimestamp: DAY_2024_04_01_UTC,
      }),
      ev({
        blockNumber: 101,
        transactionHash: '0xb',
        integrator: integratorB,
        integratorFee: '7000',
        lifiFee: '2000',
        blockTimestamp: DAY_2024_04_01_UTC,
      }),
    ])
    await aggRepo.rebuildFromFeeEvents(137, 0, 200)
    expect(await DailyAggregateModel.countDocuments()).toBe(2)

    // Reorg out only integratorA's event.
    await feeRepo.markRemoved([
      {
        chainId: 137,
        contractAddress: '0xbd6c7b0d2f68c2b7805d88388319cfb6ecb50ea9',
        blockNumber: 100,
        transactionHash: '0xa',
        logIndex: 0,
      },
    ])
    await aggRepo.rebuildFromFeeEvents(137, 0, 200)

    const surviving = await DailyAggregateModel.find().lean()
    expect(surviving).toHaveLength(1)
    expect(surviving[0]).toMatchObject({
      integrator: integratorB,
      token,
      day: '2024-04-01',
      eventCount: 1,
    })
    const stale = await DailyAggregateModel.findOne({ integrator: integratorA }).lean()
    expect(stale).toBeNull()
  })

  it('does not touch rows for unaffected days', async () => {
    // Pre-seed an aggregate for a day no FeeEvent in the new range touches.
    await DailyAggregateModel.create({
      chainId: 137,
      integrator: '0x' + '2'.repeat(40),
      token: '0x' + '1'.repeat(40),
      day: '2023-01-01',
      integratorFeeSum: '99999',
      lifiFeeSum: '11111',
      eventCount: 7,
    })

    // Insert a new event on a different day and rebuild only its block range.
    // 2024-06-01T00:00:00Z = 1_717_200_000 unix seconds
    await feeRepo.bulkInsert([
      ev({ blockNumber: 50, transactionHash: '0xnew', blockTimestamp: 1_717_200_000 }),
    ])
    await aggRepo.rebuildFromFeeEvents(137, 40, 60)

    // The 2023-01-01 row must still be there untouched — the rebuild's day
    // selector only included 2024-06-01.
    const preserved = await DailyAggregateModel.findOne({ day: '2023-01-01' }).lean()
    expect(preserved).not.toBeNull()
    expect(preserved!.integratorFeeSum).toBe('99999')
    expect(preserved!.eventCount).toBe(7)
  })

  it('listByIntegrator filters by integrator and optional day/chain filters', async () => {
    const integratorA = '0x' + 'a'.repeat(40)
    const integratorB = '0x' + 'b'.repeat(40)
    await DailyAggregateModel.insertMany([
      {
        chainId: 137,
        integrator: integratorA,
        token: '0x' + '1'.repeat(40),
        day: '2024-04-01',
        integratorFeeSum: '1',
        lifiFeeSum: '2',
        eventCount: 1,
      },
      {
        chainId: 137,
        integrator: integratorA,
        token: '0x' + '1'.repeat(40),
        day: '2024-04-02',
        integratorFeeSum: '1',
        lifiFeeSum: '2',
        eventCount: 1,
      },
      {
        chainId: 1,
        integrator: integratorA,
        token: '0x' + '1'.repeat(40),
        day: '2024-04-01',
        integratorFeeSum: '1',
        lifiFeeSum: '2',
        eventCount: 1,
      },
      {
        chainId: 137,
        integrator: integratorB,
        token: '0x' + '1'.repeat(40),
        day: '2024-04-01',
        integratorFeeSum: '99',
        lifiFeeSum: '99',
        eventCount: 1,
      },
    ])
    const polygonOnly = await aggRepo.listByIntegrator({
      integrator: integratorA,
      chainId: 137,
      limit: 100,
    })
    expect(polygonOnly).toHaveLength(2)
    expect(polygonOnly.every((r) => r.chainId === 137 && r.integrator === integratorA)).toBe(true)

    const daterange = await aggRepo.listByIntegrator({
      integrator: integratorA,
      fromDay: '2024-04-02',
      limit: 100,
    })
    expect(daterange).toHaveLength(1)
    expect(daterange[0].day).toBe('2024-04-02')
  })
})
