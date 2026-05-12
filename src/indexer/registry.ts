import { ConfigError } from '../app/errors'
import type { ContractEventPlugin } from './types'

/**
 * Static plugin registry. Plugins are eagerly constructed in the worker entry
 * (see `bootstrap.ts`) and registered here once. The registry is intentionally
 * dumb — no lazy loading, no DI graph; just an indexed view.
 *
 * Duplicate keys throw immediately: a silent overwrite would mean one plugin's
 * checkpoint would clobber another's, which is the kind of bug nobody catches
 * until production.
 */
export class IndexerRegistry {
  private readonly byKey = new Map<string, ContractEventPlugin>()

  register(plugin: ContractEventPlugin): void {
    if (this.byKey.has(plugin.key)) {
      throw new ConfigError(
        `Duplicate plugin key "${plugin.key}" — every (chain, contract, event) tuple must be unique`,
      )
    }
    this.byKey.set(plugin.key, plugin)
  }

  list(): ContractEventPlugin[] {
    return Array.from(this.byKey.values())
  }

  get(key: string): ContractEventPlugin | undefined {
    return this.byKey.get(key)
  }

  has(key: string): boolean {
    return this.byKey.has(key)
  }

  forChain(chainKey: string): ContractEventPlugin[] {
    return this.list().filter((p) => p.chainKey === chainKey)
  }

  size(): number {
    return this.byKey.size
  }
}
