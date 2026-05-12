import { SyncState, SyncStateModel } from '../models/SyncState'
import { DatabaseError } from '../../app/errors'

export interface SyncKey {
  chainId: number
  chainKey: string
  contractAddress: string
  /** Event name that scopes the checkpoint (e.g. "FeesCollected"). */
  eventName: string
}

/**
 * Repository for the per-(chain, contract, event) sync cursor.
 *
 * Critical invariants:
 *  - `advanceCheckpoint` is only called *after* the chunk's events have been
 *    successfully persisted.
 *  - The cursor uses `$max` so out-of-order calls cannot rewind.
 *  - Every query is keyed on all three of `(chainKey, contractAddress, eventName)`
 *    so two plugins on the same contract never collide.
 */
export class SyncStateRepository {
  async getOrInit(key: SyncKey, defaultStartBlock: number): Promise<SyncState> {
    try {
      const filter = {
        chainKey: key.chainKey,
        contractAddress: key.contractAddress.toLowerCase(),
        eventName: key.eventName,
      }
      // `lastSyncedBlock` is stored as `start - 1` so the next pass scans from start.
      const initial = {
        chainId: key.chainId,
        chainKey: key.chainKey,
        contractAddress: key.contractAddress.toLowerCase(),
        eventName: key.eventName,
        lastSyncedBlock: defaultStartBlock - 1,
      }
      const doc = await SyncStateModel.findOneAndUpdate(
        filter,
        { $setOnInsert: initial },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
        .lean<SyncState>()
        .exec()
      if (!doc) throw new DatabaseError('Failed to load or create sync state')
      return doc
    } catch (err) {
      if (err instanceof DatabaseError) throw err
      throw new DatabaseError(`getOrInit sync state failed: ${(err as Error).message}`, err)
    }
  }

  /**
   * Advance the cursor monotonically. `$max` guards against rewinds caused by
   * out-of-order chunk completion or duplicate jobs.
   */
  async advanceCheckpoint(key: SyncKey, toBlock: number): Promise<void> {
    try {
      await SyncStateModel.updateOne(
        {
          chainKey: key.chainKey,
          contractAddress: key.contractAddress.toLowerCase(),
          eventName: key.eventName,
        },
        {
          $max: { lastSyncedBlock: toBlock },
          $set: { status: 'running', lastError: null },
        },
      ).exec()
    } catch (err) {
      throw new DatabaseError(`advanceCheckpoint failed: ${(err as Error).message}`, err)
    }
  }

  async markRunning(key: SyncKey): Promise<void> {
    await SyncStateModel.updateOne(
      {
        chainKey: key.chainKey,
        contractAddress: key.contractAddress.toLowerCase(),
        eventName: key.eventName,
      },
      { $set: { status: 'running', lastSyncStartedAt: new Date(), lastError: null } },
    ).exec()
  }

  async markIdle(key: SyncKey): Promise<void> {
    await SyncStateModel.updateOne(
      {
        chainKey: key.chainKey,
        contractAddress: key.contractAddress.toLowerCase(),
        eventName: key.eventName,
      },
      { $set: { status: 'idle', lastSyncFinishedAt: new Date() } },
    ).exec()
  }

  async markError(key: SyncKey, error: string): Promise<void> {
    await SyncStateModel.updateOne(
      {
        chainKey: key.chainKey,
        contractAddress: key.contractAddress.toLowerCase(),
        eventName: key.eventName,
      },
      { $set: { status: 'error', lastError: error, lastSyncFinishedAt: new Date() } },
    ).exec()
  }
}

export const syncStateRepository = new SyncStateRepository()

/**
 * Pure helper for the "next from block" calculation. Exposed so the unit
 * test suite can verify the rule without touching Mongo.
 */
export function computeNextFromBlock(
  lastSyncedBlock: number | undefined,
  defaultStartBlock: number,
): number {
  if (lastSyncedBlock == null) return defaultStartBlock
  return Math.max(lastSyncedBlock + 1, defaultStartBlock)
}
