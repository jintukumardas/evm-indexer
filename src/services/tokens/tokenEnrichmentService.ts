import { ethers } from 'ethers'
import type { Logger } from 'pino'
import type { ChainIndexConfig } from '../../app/config'
import { createErc20Contract } from '../../blockchain/contracts/erc20'
import { withRetry, type RetryPolicy } from '../../blockchain/providers/retry'
import { FeeEventRepository } from '../../plugins/feeCollector/repository'
import { TokenRepository, type TokenMetadataUpsert } from '../../db/repositories/tokenRepository'

export interface TokenEnrichmentDeps {
  feeEvents: FeeEventRepository
  tokens: TokenRepository
  logger: Logger
  retry: RetryPolicy
}

export interface TokenEnrichmentOptions {
  /** Max tokens to resolve per pass — keeps RPC fan-out predictable. */
  batchSize?: number
}

const NATIVE_ETH = '0x0000000000000000000000000000000000000000'
const NATIVE_FALLBACKS: Record<number, { symbol: string; decimals: number; name: string }> = {
  1: { symbol: 'ETH', decimals: 18, name: 'Ether' },
  137: { symbol: 'MATIC', decimals: 18, name: 'Polygon' },
  42_161: { symbol: 'ETH', decimals: 18, name: 'Ether' },
}

/**
 * Resolves ERC20 `symbol`, `decimals`, `name` for every distinct token
 * referenced by a FeeEvent that we haven't already resolved. Errors are
 * persisted (`lastError`) — they don't abort the pass.
 *
 * The "native" address `0x000…000` is short-circuited to the chain's native
 * coin metadata. Real native ETH/MATIC isn't an ERC20 contract, so calling
 * `symbol()` against it would always revert.
 */
export class TokenEnrichmentService {
  constructor(private readonly deps: TokenEnrichmentDeps) {}

  async enrich(
    chain: ChainIndexConfig,
    provider: ethers.providers.Provider,
    opts: TokenEnrichmentOptions = {},
  ): Promise<{ resolved: number; failed: number; skipped: number }> {
    const batchSize = opts.batchSize ?? 25
    const distinct = await this.deps.feeEvents.distinctTokens(chain.chainId)
    const unresolved = await this.deps.tokens.findUnresolved(chain.chainId, distinct, batchSize)
    if (unresolved.length === 0) return { resolved: 0, failed: 0, skipped: 0 }

    this.deps.logger.info(
      { chain: chain.key, batch: unresolved.length },
      'Token enrichment pass starting',
    )

    let resolved = 0
    let failed = 0
    let skipped = 0
    const upserts: TokenMetadataUpsert[] = []

    for (const address of unresolved) {
      if (address === NATIVE_ETH) {
        const native = NATIVE_FALLBACKS[chain.chainId]
        if (native) {
          upserts.push({ chainId: chain.chainId, address, ...native })
          resolved += 1
        } else {
          skipped += 1
        }
        continue
      }

      try {
        const contract = createErc20Contract(address, provider)
        // Call symbol/decimals/name in parallel under the same retry policy.
        const [symbol, decimals, name] = await Promise.all([
          withRetry(() => contract.symbol() as Promise<string>, {
            policy: this.deps.retry,
            logger: this.deps.logger,
            label: `erc20-symbol(${address})`,
          }),
          withRetry(() => contract.decimals() as Promise<number>, {
            policy: this.deps.retry,
            logger: this.deps.logger,
            label: `erc20-decimals(${address})`,
          }),
          withRetry(() => contract.name() as Promise<string>, {
            policy: this.deps.retry,
            logger: this.deps.logger,
            label: `erc20-name(${address})`,
          }).catch(() => undefined), // name is optional in some tokens
        ])
        upserts.push({ chainId: chain.chainId, address, symbol, decimals, name })
        resolved += 1
      } catch (err) {
        const msg = (err as Error).message.slice(0, 200)
        upserts.push({ chainId: chain.chainId, address, lastError: msg })
        failed += 1
        this.deps.logger.debug({ chain: chain.key, address, err: msg }, 'Token enrichment failed')
      }
    }

    await this.deps.tokens.upsertMetadata(upserts)
    this.deps.logger.info(
      { chain: chain.key, resolved, failed, skipped },
      'Token enrichment pass complete',
    )
    return { resolved, failed, skipped }
  }
}
