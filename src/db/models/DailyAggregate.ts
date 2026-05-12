import { getModelForClass, index, modelOptions, prop, Severity } from '@typegoose/typegoose'

/**
 * Pre-computed daily rollup of fees per `(chainId, integrator, token, day)`.
 *
 * `day` is the ISO date string (YYYY-MM-DD) derived from each event's
 * `blockTimestamp` (the chain's block-header time) so that backfills and
 * re-indexes do not shift events across UTC day boundaries.
 *
 * Sums are stored as decimal strings to keep uint256 precision; the API can
 * sum them by client-side BigInt arithmetic or expose them raw.
 */
@index(
  { chainId: 1, integrator: 1, token: 1, day: 1 },
  { unique: true, name: 'uniq_aggregate_key' },
)
@index({ integrator: 1, day: -1 }, { name: 'integrator_day_desc' })
@modelOptions({
  schemaOptions: { collection: 'daily_aggregates', timestamps: true },
  options: { allowMixed: Severity.ERROR },
})
export class DailyAggregate {
  @prop({ type: Number, required: true }) chainId!: number
  @prop({ type: String, required: true, lowercase: true }) integrator!: string
  @prop({ type: String, required: true, lowercase: true }) token!: string
  /** ISO date string (YYYY-MM-DD). */
  @prop({ type: String, required: true }) day!: string

  @prop({ type: String, required: true }) integratorFeeSum!: string
  @prop({ type: String, required: true }) lifiFeeSum!: string
  @prop({ type: Number, required: true }) eventCount!: number
}

export const DailyAggregateModel = getModelForClass(DailyAggregate)
