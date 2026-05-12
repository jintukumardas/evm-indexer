import { getModelForClass, index, modelOptions, prop, Severity } from '@typegoose/typegoose'

/**
 * Persisted FeesCollected event row.
 *
 * Indexes:
 *  - Unique compound on (chainId, contractAddress, blockNumber, transactionHash, logIndex)
 *    so re-running a chunk is a no-op (idempotent ingestion).
 *  - (integrator, blockNumber desc) and (integrator, logIndex desc) to support
 *    the API's `?integrator=` cursor-paginated query without a collection scan.
 *
 * Address fields are persisted lowercase. Fee amounts are persisted as strings
 * to preserve uint256 precision (JS `number` only safely represents 2^53 - 1).
 *
 * NOTE on `@prop({ type: ... })`: explicit types are required because the
 * `tsx` runtime (esbuild) does not emit TypeScript's `design:type` reflection
 * metadata. ts-jest does, which is why this only manifests at runtime, not
 * in the test suite.
 */
@index(
  { chainId: 1, contractAddress: 1, blockNumber: 1, transactionHash: 1, logIndex: 1 },
  { unique: true, name: 'uniq_event_identity' },
)
@index({ integrator: 1, blockNumber: -1, logIndex: -1 }, { name: 'integrator_block_desc' })
@index({ chainId: 1, blockNumber: -1 }, { name: 'chain_block_desc' })
@modelOptions({
  schemaOptions: { collection: 'fee_events', timestamps: { createdAt: 'processedAt', updatedAt: true } },
  options: { allowMixed: Severity.ERROR },
})
export class FeeEvent {
  @prop({ type: Number, required: true, index: true }) chainId!: number
  @prop({ type: String, required: true }) chainKey!: string
  @prop({ type: String, required: true, lowercase: true }) contractAddress!: string

  @prop({ type: Number, required: true }) blockNumber!: number
  @prop({ type: String, required: true }) blockHash!: string
  /**
   * Unix seconds from the block header. Used to bucket aggregates by the
   * chain's own clock rather than the indexer's ingestion time — backfills
   * and restarts then no longer shift events across UTC day boundaries.
   */
  @prop({ type: Number, required: true }) blockTimestamp!: number
  @prop({ type: String, required: true }) transactionHash!: string
  @prop({ type: Number, required: true }) logIndex!: number

  @prop({ type: String, required: true, lowercase: true }) token!: string
  @prop({ type: String, required: true, lowercase: true }) integrator!: string

  @prop({ type: String, required: true }) integratorFee!: string
  @prop({ type: String, required: true }) lifiFee!: string

  @prop({ type: Boolean, required: true, default: false }) removed!: boolean
  @prop({ type: String, required: true }) eventName!: string

  @prop({ type: Date }) processedAt?: Date
}

export const FeeEventModel = getModelForClass(FeeEvent)
