import { getModelForClass, index, modelOptions, prop, Severity } from '@typegoose/typegoose'

/**
 * Per-chain ERC20 token metadata, populated by the token enrichment worker.
 *
 * The `(chainId, address)` pair is unique. `symbol` / `decimals` may be null
 * for tokens that haven't yet been resolved or that return invalid ABI
 * responses (e.g. non-standard ERC20). `lastFetchedAt` lets the worker
 * back off on tokens that keep failing.
 */
@index({ chainId: 1, address: 1 }, { unique: true, name: 'uniq_chain_address' })
@modelOptions({
  schemaOptions: { collection: 'tokens', timestamps: true },
  options: { allowMixed: Severity.ERROR },
})
export class Token {
  @prop({ type: Number, required: true }) chainId!: number
  @prop({ type: String, required: true, lowercase: true }) address!: string
  @prop({ type: String }) symbol?: string
  @prop({ type: Number }) decimals?: number
  @prop({ type: String }) name?: string
  @prop({ type: Date }) lastFetchedAt?: Date
  @prop({ type: Number, default: 0 }) fetchAttempts?: number
  @prop({ type: String }) lastError?: string
}

export const TokenModel = getModelForClass(Token)
