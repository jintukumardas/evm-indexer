import type { EventIdentity } from './types'

/**
 * Stable string key for an `EventIdentity`. Addresses are lowercased so two
 * identities that differ only by checksumming hash to the same key.
 *
 * Lives in the generic engine — the reorg runner uses it across plugins
 * without ever looking at the plugin-private parsed shape.
 */
export function identityKey(id: EventIdentity): string {
  return `${id.chainId}|${id.contractAddress.toLowerCase()}|${id.blockNumber}|${id.transactionHash}|${id.logIndex}`
}

/**
 * Set difference: identities present in `persisted` but missing from
 * `fetched`. The reorg runner uses this to compute "rows that should be
 * flagged removed because the canonical chain no longer has them."
 */
export function diffPersistedVsFetched(
  persisted: EventIdentity[],
  fetched: EventIdentity[],
): EventIdentity[] {
  const fetchedKeys = new Set(fetched.map(identityKey))
  return persisted.filter((p) => !fetchedKeys.has(identityKey(p)))
}
