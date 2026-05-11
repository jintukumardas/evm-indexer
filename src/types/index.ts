/**
 * Cross-cutting types used by multiple layers of the indexer.
 * Domain models live next to their owning module; only shared shapes go here.
 */

/**
 * The canonical, normalized representation of a FeesCollected event.
 * `*Fee` values are kept as decimal strings to preserve full uint256 precision.
 */
export interface NormalizedFeeEvent {
  chainId: number
  chainKey: string
  contractAddress: string
  blockNumber: number
  blockHash: string
  /** Unix seconds — pulled from the block header. Used for daily bucketing. */
  blockTimestamp: number
  transactionHash: string
  logIndex: number
  token: string
  integrator: string
  integratorFee: string
  lifiFee: string
  removed: boolean
  eventName: string
}

/** Inclusive block range. */
export interface BlockRange {
  fromBlock: number
  toBlock: number
}
