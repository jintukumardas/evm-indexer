import { ethers } from 'ethers'

/**
 * Minimal ABI for the LI.FI FeeCollector contract — only the FeesCollected
 * event is required for indexing. Keeping the ABI local avoids pulling in the
 * full `lifi-contract-types` package and keeps the indexer dependency-light.
 *
 * Event signature (verified against the deployed contract):
 *   event FeesCollected(
 *     address indexed _token,
 *     address indexed _integrator,
 *     uint256 _integratorFee,
 *     uint256 _lifiFee
 *   )
 */
export const FEE_COLLECTOR_ABI = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'address', name: '_token', type: 'address' },
      { indexed: true, internalType: 'address', name: '_integrator', type: 'address' },
      { indexed: false, internalType: 'uint256', name: '_integratorFee', type: 'uint256' },
      { indexed: false, internalType: 'uint256', name: '_lifiFee', type: 'uint256' },
    ],
    name: 'FeesCollected',
    type: 'event',
  },
] as const

export const FEES_COLLECTED_EVENT = 'FeesCollected'

let cachedInterface: ethers.utils.Interface | null = null

/**
 * Lazily-built singleton ethers Interface for the FeeCollector. Cached so we
 * don't rebuild the ABI parse tree per chunk.
 */
export function getFeeCollectorInterface(): ethers.utils.Interface {
  if (!cachedInterface) {
    // The ABI is `as const`, which TS types narrowly; the Interface constructor
    // accepts JsonFragment[] but ethers v5 doesn't re-export that name through
    // `ethers.utils`. Round-trip through JSON for a safe, type-clean handoff.
    cachedInterface = new ethers.utils.Interface(JSON.stringify(FEE_COLLECTOR_ABI))
  }
  return cachedInterface
}

/** Returns an ethers Contract bound to the given provider, using the shared interface. */
export function createFeeCollectorContract(
  address: string,
  provider: ethers.providers.Provider,
): ethers.Contract {
  return new ethers.Contract(address, getFeeCollectorInterface(), provider)
}
