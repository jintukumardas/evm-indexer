import { ethers } from 'ethers'

/**
 * Minimal ERC20 read ABI — `symbol()`, `decimals()`, `name()`.
 * Some tokens return `bytes32` for symbol/name (old contracts like MKR); we
 * use the standard string ABI and fall back to ignoring failures in the
 * enrichment service.
 */
export const ERC20_READ_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function name() view returns (string)',
] as const

let cachedInterface: ethers.utils.Interface | null = null

export function getErc20Interface(): ethers.utils.Interface {
  if (!cachedInterface) cachedInterface = new ethers.utils.Interface([...ERC20_READ_ABI])
  return cachedInterface
}

export function createErc20Contract(
  address: string,
  provider: ethers.providers.Provider,
): ethers.Contract {
  return new ethers.Contract(address, getErc20Interface(), provider)
}
