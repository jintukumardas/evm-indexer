import { ethers } from 'ethers'

/**
 * Provider abstraction. Centralizing creation here means:
 *  - retry / fallback transports are added in one place
 *  - tests can swap the factory cleanly
 *  - we never construct providers ad-hoc in business code
 *
 * Multi-URL behaviour: when more than one RPC URL is supplied for a chain we
 * build a `FallbackProvider`. ethers FallbackProvider already implements
 * quorum + automatic failover across child providers.
 */
export interface ProviderFactory {
  create(rpcUrls: string[], chainId: number): ethers.providers.Provider
}

class DefaultProviderFactory implements ProviderFactory {
  private cache = new Map<string, ethers.providers.Provider>()

  create(rpcUrls: string[], chainId: number): ethers.providers.Provider {
    if (rpcUrls.length === 0) throw new Error('At least one RPC URL is required')
    const cacheKey = `${chainId}:${rpcUrls.join('|')}`
    const existing = this.cache.get(cacheKey)
    if (existing) return existing

    const provider =
      rpcUrls.length === 1
        ? new ethers.providers.StaticJsonRpcProvider(rpcUrls[0], chainId)
        : new ethers.providers.FallbackProvider(
            rpcUrls.map((url, i) => ({
              provider: new ethers.providers.StaticJsonRpcProvider(url, chainId),
              // Lower-indexed RPCs are preferred. Single-quorum since a single
              // healthy node is sufficient — we are read-only and tolerate
              // eventual consistency across RPC peers.
              priority: i + 1,
              stallTimeout: 2_000,
              weight: 1,
            })),
            1, // quorum
          )
    this.cache.set(cacheKey, provider)
    return provider
  }
}

export const providerFactory: ProviderFactory = new DefaultProviderFactory()
