import { getModelForClass, index, modelOptions, prop, Severity } from '@typegoose/typegoose'

/**
 * Per-(chain, contract, event) sync cursor.
 *
 * `lastSyncedBlock` is the highest block number (inclusive) whose events have
 * been fully persisted. The next sync pass starts at `lastSyncedBlock + 1`.
 *
 * Only updated after a chunk has been successfully written, so a crash
 * mid-chunk replays that chunk on next start (safe because of the unique
 * index on each plugin's event collection).
 *
 * The unique key includes `eventName` so multiple plugins indexing different
 * events on the same contract (or different contracts on the same chain)
 * each get an independent checkpoint.
 */
@index(
  { chainKey: 1, contractAddress: 1, eventName: 1 },
  { unique: true, name: 'uniq_sync_key' },
)
@modelOptions({
  schemaOptions: { collection: 'sync_state', timestamps: true },
  options: { allowMixed: Severity.ERROR },
})
export class SyncState {
  @prop({ type: Number, required: true }) chainId!: number
  @prop({ type: String, required: true }) chainKey!: string
  @prop({ type: String, required: true, lowercase: true }) contractAddress!: string
  /** Event name that scopes this checkpoint (e.g. "FeesCollected"). */
  @prop({ type: String, required: true }) eventName!: string

  @prop({ type: Number, required: true }) lastSyncedBlock!: number

  /** Free-form status for observability — e.g. "idle", "running", "error". */
  @prop({ type: String, default: 'idle' }) status?: string
  @prop({ type: String }) lastError?: string
  @prop({ type: Date }) lastSyncStartedAt?: Date
  @prop({ type: Date }) lastSyncFinishedAt?: Date
}

export const SyncStateModel = getModelForClass(SyncState)
