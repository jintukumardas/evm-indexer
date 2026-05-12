import { FilterQuery } from 'mongoose'
import { DailyAggregate, DailyAggregateModel } from '../models/DailyAggregate'
import { FeeEventModel } from '../models/FeeEvent'
import { DatabaseError } from '../../app/errors'

export interface ListAggregatesOpts {
  integrator: string
  chainId?: number
  token?: string
  fromDay?: string
  toDay?: string
  limit: number
}

/**
 * Repository for `DailyAggregate`. Includes the rebuild routine that walks
 * FeeEvent and writes the rolled-up sums.
 */
export class AggregateRepository {
  /**
   * Rebuilds aggregates for the given chain over the provided block range.
   *
   * Why this is a two-step pipeline (and not a single $merge over the block
   * window): with `whenMatched: 'replace'` a naive single-pass rebuild would
   * lose prior sums whenever a `(integrator, token, day)` row was first
   * written by an earlier pass and is now only partially re-touched by this
   * pass. Example:
   *   pass A indexes block 1000 → row {day=X, fee=5, count=1}
   *   pass B indexes block 2000 (same day X) → row computed from B's slice
   *     alone = {fee=3, count=1} → 'replace' overwrites A's contribution.
   *
   * Fix: determine the set of `day`s touched by the new block range, then
   * re-aggregate ALL non-removed events for those days from the canonical
   * FeeEvent collection. `whenMatched: replace` is then correct because we
   * always recompute each affected day's full sum.
   *
   * Cost is O(events for affected days), bounded by the indexer's daily
   * volume — not O(history).
   */
  async rebuildFromFeeEvents(chainId: number, fromBlock: number, toBlock: number): Promise<void> {
    if (fromBlock > toBlock) return
    try {
      // Step 1: discover affected days from the new block window. We include
      // removed rows in the discovery scan so a day whose only events have
      // just been reorged out is still detected — otherwise its stale
      // aggregate row would never get cleaned up (`$merge` has no delete
      // branch).
      const affectedDays = await FeeEventModel.aggregate<{ _id: string }>([
        {
          $match: {
            chainId,
            blockNumber: { $gte: fromBlock, $lte: toBlock },
          },
        },
        {
          $project: {
            day: {
              $dateToString: {
                format: '%Y-%m-%d',
                date: { $toDate: { $multiply: ['$blockTimestamp', 1000] } },
                timezone: 'UTC',
              },
            },
          },
        },
        { $group: { _id: '$day' } },
      ]).exec()

      const days = affectedDays.map((d) => d._id).filter((d): d is string => !!d)
      if (days.length === 0) return

      // Step 2: blow away every aggregate row for the affected (chainId, day)
      // slice, then re-insert from non-removed events only. This is the only
      // way to delete a `(integrator, token, day)` tuple whose events have all
      // been reorged out — `$merge whenMatched:replace` would leave it stale
      // because no group key is emitted for it. Safe under per-chain
      // serialization in `AggregateService.rebuildChain`.
      await DailyAggregateModel.deleteMany({ chainId, day: { $in: days } }).exec()

      // Step 3: re-aggregate the FULL set of non-removed events for each
      // affected day and insert. Every emitted row is the authoritative total
      // for that (chain, integrator, token, day); tuples with zero non-removed
      // events emit nothing and stay deleted.
      await FeeEventModel.aggregate([
        {
          $addFields: {
            day: {
              $dateToString: {
                format: '%Y-%m-%d',
                date: { $toDate: { $multiply: ['$blockTimestamp', 1000] } },
                timezone: 'UTC',
              },
            },
          },
        },
        {
          $match: {
            chainId,
            removed: { $ne: true },
            day: { $in: days },
          },
        },
        {
          $addFields: {
            integratorFeeDec: { $convert: { input: '$integratorFee', to: 'decimal' } },
            lifiFeeDec: { $convert: { input: '$lifiFee', to: 'decimal' } },
          },
        },
        {
          $group: {
            _id: { chainId: '$chainId', integrator: '$integrator', token: '$token', day: '$day' },
            integratorFeeSumDec: { $sum: '$integratorFeeDec' },
            lifiFeeSumDec: { $sum: '$lifiFeeDec' },
            eventCount: { $sum: 1 },
          },
        },
        {
          $project: {
            _id: 0,
            chainId: '$_id.chainId',
            integrator: '$_id.integrator',
            token: '$_id.token',
            day: '$_id.day',
            integratorFeeSum: { $toString: '$integratorFeeSumDec' },
            lifiFeeSum: { $toString: '$lifiFeeSumDec' },
            eventCount: 1,
          },
        },
        {
          // We already deleted the slice in Step 2, so every output row is
          // strictly an insert. `whenMatched: fail` would be slightly more
          // defensive, but `replace` keeps the pipeline tolerant of a racing
          // pass that re-creates the same key — the per-chain serializer
          // makes that impossible in practice, but the looser merge is safer
          // if that invariant is ever violated.
          $merge: {
            into: 'daily_aggregates',
            on: ['chainId', 'integrator', 'token', 'day'],
            whenMatched: 'replace',
            whenNotMatched: 'insert',
          },
        },
      ]).exec()
    } catch (err) {
      throw new DatabaseError(`Aggregate rebuild failed: ${(err as Error).message}`, err)
    }
  }

  async listByIntegrator(opts: ListAggregatesOpts): Promise<DailyAggregate[]> {
    const filter: FilterQuery<DailyAggregate> = { integrator: opts.integrator.toLowerCase() }
    if (opts.chainId != null) filter.chainId = opts.chainId
    if (opts.token) filter.token = opts.token.toLowerCase()
    if (opts.fromDay || opts.toDay) {
      filter.day = {}
      if (opts.fromDay) (filter.day as Record<string, string>).$gte = opts.fromDay
      if (opts.toDay) (filter.day as Record<string, string>).$lte = opts.toDay
    }
    return DailyAggregateModel.find(filter)
      .sort({ day: -1, token: 1 })
      .limit(opts.limit)
      .lean<DailyAggregate[]>()
      .exec()
  }
}

export const aggregateRepository = new AggregateRepository()
