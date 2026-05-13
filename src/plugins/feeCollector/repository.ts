import { FilterQuery } from 'mongoose'
import { FeeEvent, FeeEventModel } from '../../db/models/FeeEvent'
import type { NormalizedFeeEvent } from '../../types'
import { DatabaseError } from '../../app/errors'
import type { EventIdentity, IdentityRow } from '../../indexer/types'

export interface BulkInsertResult {
  insertedCount: number
  duplicateCount: number
}

export interface FeeEventCursor {
  blockNumber: number
  logIndex: number
  transactionHash: string
  chainId: number
}

export interface ListByIntegratorOpts {
  integrator: string
  limit: number
  cursor?: FeeEventCursor
  chainId?: number
}

export interface ListByIntegratorResult {
  items: FeeEvent[]
  nextCursor: FeeEventCursor | null
  hasNextPage: boolean
}

/**
 * Repository for `FeeEvent`. Co-located with the FeeCollector plugin so the
 * Mongo specifics for `FeesCollected` live next to the parser and the
 * routes that read them.
 *
 * Implements the persistence half of the `ContractEventPlugin` interface via
 * `bulkInsert`, `findIdentityRowsInRange`, `markRemoved`, `restoreRemoved`.
 * `listByIntegrator` + `distinctTokens` are FeeCollector-specific and sit
 * behind the plugin's HTTP routes and token-enrichment hook.
 */
export class FeeEventRepository {
  /**
   * Idempotent bulk insert. Duplicates (by the unique compound index) are
   * silently dropped via `ordered: false` — keeps re-runs safe.
   */
  async bulkInsert(events: NormalizedFeeEvent[]): Promise<BulkInsertResult> {
    if (events.length === 0) return { insertedCount: 0, duplicateCount: 0 }
    try {
      // Without rawResult, `insertMany` returns the array of inserted docs —
      // its length is the authoritative inserted count and survives version
      // differences across the mongoose driver. `ordered:false` lets the
      // duplicates land in the catch path below.
      const inserted = (await FeeEventModel.insertMany(events, {
        ordered: false,
      })) as unknown[]
      return {
        insertedCount: inserted.length,
        duplicateCount: events.length - inserted.length,
      }
    } catch (err) {
      const e = err as {
        code?: number
        // mongoose wraps each WriteError as `{ err: { code, errmsg, ... }, index }`;
        // the per-entry code lives at `.err.code`, NOT `.code` directly.
        writeErrors?: Array<{ code?: number; err?: { code?: number } }>
        insertedDocs?: unknown[]
      }
      const writeErrors = e.writeErrors ?? []
      const entryCode = (w: { code?: number; err?: { code?: number } }): number | undefined =>
        w.err?.code ?? w.code
      // The top-level `e.code` is propagated from one of the writeErrors
      // (often the first), so a mixed batch of duplicates plus a real
      // failure can still report `code === 11000`. Trust the per-entry
      // codes when they are present; fall back to the top-level code only
      // when `writeErrors` is missing entirely.
      const everyEntryIsDup =
        writeErrors.length > 0
          ? writeErrors.every((w) => entryCode(w) === 11000)
          : e.code === 11000
      if (everyEntryIsDup) {
        const inserted =
          e.insertedDocs?.length ?? Math.max(0, events.length - writeErrors.length)
        return { insertedCount: inserted, duplicateCount: events.length - inserted }
      }
      throw new DatabaseError(`Bulk insert failed: ${(err as Error).message}`, err)
    }
  }

  /**
   * Cursor-paginated lookup by integrator, newest-first.
   *
   * Excludes `removed: true` (reorged-out) rows so this endpoint stays
   * consistent with the aggregate views, which also exclude them.
   *
   * Sort & cursor tuple is `(blockNumber, logIndex, transactionHash, chainId)`
   * descending. The first two alone are NOT unique across rows for the same
   * integrator: two contracts emitting in the same block at the same logIndex
   * (or the same integrator on two chains) can collide. Including
   * `transactionHash` + `chainId` makes the cursor a strict total order on the
   * uniqueness key and prevents the page boundary from skipping siblings.
   */
  async listByIntegrator(opts: ListByIntegratorOpts): Promise<ListByIntegratorResult> {
    const filter: FilterQuery<FeeEvent> = {
      integrator: opts.integrator.toLowerCase(),
      removed: { $ne: true },
    }
    if (opts.chainId != null) filter.chainId = opts.chainId
    if (opts.cursor) {
      const c = opts.cursor
      filter.$or = [
        { blockNumber: { $lt: c.blockNumber } },
        { blockNumber: c.blockNumber, logIndex: { $lt: c.logIndex } },
        {
          blockNumber: c.blockNumber,
          logIndex: c.logIndex,
          transactionHash: { $lt: c.transactionHash },
        },
        {
          blockNumber: c.blockNumber,
          logIndex: c.logIndex,
          transactionHash: c.transactionHash,
          chainId: { $lt: c.chainId },
        },
      ]
    }

    const docs = await FeeEventModel.find(filter)
      .sort({ blockNumber: -1, logIndex: -1, transactionHash: -1, chainId: -1 })
      .limit(opts.limit + 1)
      .lean<FeeEvent[]>()
      .exec()

    const hasNextPage = docs.length > opts.limit
    const items = hasNextPage ? docs.slice(0, opts.limit) : docs
    const last = items[items.length - 1]
    const nextCursor =
      hasNextPage && last
        ? {
            blockNumber: last.blockNumber,
            logIndex: last.logIndex,
            transactionHash: last.transactionHash,
            chainId: last.chainId,
          }
        : null
    return { items, hasNextPage, nextCursor }
  }

  /**
   * Returns all FeeEvent documents for `(chainId, contractAddress)` whose
   * `blockNumber` falls in [fromBlock, toBlock] inclusive. The plugin
   * adapts the result into `IdentityRow[]` for the generic reorg runner via
   * `findIdentityRowsInRange`.
   */
  async findInRange(
    chainId: number,
    contractAddress: string,
    fromBlock: number,
    toBlock: number,
  ): Promise<FeeEvent[]> {
    return FeeEventModel.find({
      chainId,
      contractAddress: contractAddress.toLowerCase(),
      blockNumber: { $gte: fromBlock, $lte: toBlock },
    })
      .lean<FeeEvent[]>()
      .exec()
  }

  /**
   * Adapter that the FeeCollector plugin exposes through
   * `ContractEventPlugin.findInRange`. The generic reorg runner only needs
   * identity + tombstone — full rows would waste bandwidth.
   */
  async findIdentityRowsInRange(
    chainId: number,
    contractAddress: string,
    fromBlock: number,
    toBlock: number,
  ): Promise<IdentityRow[]> {
    const docs = await this.findInRange(chainId, contractAddress, fromBlock, toBlock)
    return docs.map((d) => ({
      identity: {
        chainId: d.chainId,
        contractAddress: d.contractAddress,
        blockNumber: d.blockNumber,
        transactionHash: d.transactionHash,
        logIndex: d.logIndex,
      },
      removed: Boolean(d.removed),
    }))
  }

  /**
   * Restores events whose identity matches one of `identities` AND that are
   * currently flagged `removed: true`. Used by the generic reorg runner when a
   * previously-reorged-out event comes back to the canonical chain. Returns
   * the number of rows actually flipped — rows that were already `removed:false`
   * count as 0.
   */
  async restoreRemoved(identities: EventIdentity[]): Promise<number> {
    if (identities.length === 0) return 0
    const ops = identities.map((id) => ({
      updateOne: {
        filter: {
          chainId: id.chainId,
          contractAddress: id.contractAddress.toLowerCase(),
          blockNumber: id.blockNumber,
          transactionHash: id.transactionHash,
          logIndex: id.logIndex,
          removed: true,
        },
        update: { $set: { removed: false } },
      },
    }))
    try {
      const res = await FeeEventModel.bulkWrite(ops, { ordered: false })
      return res.modifiedCount ?? 0
    } catch (err) {
      throw new DatabaseError(`restoreRemoved failed: ${(err as Error).message}`, err)
    }
  }

  /**
   * Marks the given event identities as removed (reorged out). Returns the
   * count of rows actually mutated — duplicates / already-removed rows count
   * as 0.
   */
  async markRemoved(identities: EventIdentity[]): Promise<number> {
    if (identities.length === 0) return 0
    const ops = identities.map((id) => ({
      updateOne: {
        filter: {
          chainId: id.chainId,
          contractAddress: id.contractAddress.toLowerCase(),
          blockNumber: id.blockNumber,
          transactionHash: id.transactionHash,
          logIndex: id.logIndex,
        },
        update: { $set: { removed: true } },
      },
    }))
    try {
      const res = await FeeEventModel.bulkWrite(ops, { ordered: false })
      return res.modifiedCount ?? 0
    } catch (err) {
      throw new DatabaseError(`markRemoved failed: ${(err as Error).message}`, err)
    }
  }

  /** Returns distinct token addresses across the entire collection. */
  async distinctTokens(chainId?: number): Promise<string[]> {
    const filter: FilterQuery<FeeEvent> = {}
    if (chainId != null) filter.chainId = chainId
    return FeeEventModel.distinct('token', filter).exec()
  }
}

export const feeEventRepository = new FeeEventRepository()

// `EventIdentity` is re-exported for tests / call-sites that still want the
// type without depending on the indexer package directly.
export type { EventIdentity } from '../../indexer/types'
