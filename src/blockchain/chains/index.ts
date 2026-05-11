import type { ChainIndexConfig } from '../../app/config'

/**
 * Chain registry. Whatever chains the validated config produced, they're all
 * supported — the registry is just an indexed view. Adding a new chain is a
 * config schema addition + the descriptor in `loadConfig`; no code change here.
 */
export interface ChainRegistry {
  list(): ChainIndexConfig[]
  get(key: string): ChainIndexConfig | undefined
  has(key: string): boolean
}

export function buildChainRegistry(chains: ChainIndexConfig[]): ChainRegistry {
  const byKey = new Map(chains.map((c) => [c.key, c]))
  return {
    list: () => Array.from(byKey.values()),
    get: (key: string) => byKey.get(key),
    has: (key: string) => byKey.has(key),
  }
}
