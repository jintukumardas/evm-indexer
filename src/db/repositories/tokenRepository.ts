import { Token, TokenModel } from '../models/Token'
import { DatabaseError } from '../../app/errors'

export interface TokenMetadataUpsert {
  chainId: number
  address: string
  symbol?: string
  decimals?: number
  name?: string
  lastError?: string
}

export class TokenRepository {
  /**
   * Returns the set of token addresses for `chainId` that have not been
   * resolved yet (`symbol` is missing or `lastError` is set). Capped at
   * `limit` so the enrichment worker doesn't blow up batch sizes.
   */
  async findUnresolved(chainId: number, candidates: string[], limit: number): Promise<string[]> {
    if (candidates.length === 0) return []
    const lowered = candidates.map((a) => a.toLowerCase())
    const resolved = await TokenModel.find({
      chainId,
      address: { $in: lowered },
      symbol: { $exists: true, $ne: null },
    })
      .select('address')
      .lean<Array<{ address: string }>>()
      .exec()
    const resolvedSet = new Set(resolved.map((r) => r.address))
    return lowered.filter((a) => !resolvedSet.has(a)).slice(0, limit)
  }

  async upsertMetadata(records: TokenMetadataUpsert[]): Promise<void> {
    if (records.length === 0) return
    try {
      await TokenModel.bulkWrite(
        records.map((r) => {
          // `$set: { lastError: undefined }` is silently dropped by Mongoose,
          // so a successful retry of a previously-failed token would otherwise
          // keep the stale error message. Use `$unset` on success to actively
          // clear it.
          const set: Record<string, unknown> = {
            lastFetchedAt: new Date(),
          }
          if (r.symbol !== undefined) set.symbol = r.symbol
          if (r.decimals !== undefined) set.decimals = r.decimals
          if (r.name !== undefined) set.name = r.name
          const update: Record<string, unknown> = {
            $set: set,
            $inc: { fetchAttempts: 1 },
            $setOnInsert: { chainId: r.chainId, address: r.address.toLowerCase() },
          }
          if (r.lastError != null) {
            set.lastError = r.lastError
          } else {
            update.$unset = { lastError: '' }
          }
          return {
            updateOne: {
              filter: { chainId: r.chainId, address: r.address.toLowerCase() },
              update,
              upsert: true,
            },
          }
        }),
        { ordered: false },
      )
    } catch (err) {
      throw new DatabaseError(`Token upsert failed: ${(err as Error).message}`, err)
    }
  }

  async getByChainAndAddresses(chainId: number, addresses: string[]): Promise<Token[]> {
    if (addresses.length === 0) return []
    return TokenModel.find({
      chainId,
      address: { $in: addresses.map((a) => a.toLowerCase()) },
    })
      .lean<Token[]>()
      .exec()
  }
}

export const tokenRepository = new TokenRepository()
