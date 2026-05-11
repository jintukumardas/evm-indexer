import type { ChainIndexConfig } from '../../app/config'

export const POLYGON_KEY = 'polygon'
export const POLYGON_CHAIN_ID = 137

/**
 * Polygon-specific helper. The actual runtime values come from validated env
 * config (`ChainIndexConfig`); this module is the seam that ties a chain's
 * identity to its config entry. Adding a new chain means:
 *   1. Add the config keys in `src/app/config/schema.ts`
 *   2. Add a sibling module (e.g. `arbitrum.ts`)
 *   3. Register it in `src/blockchain/chains/index.ts`
 */
export function findPolygonConfig(chains: ChainIndexConfig[]): ChainIndexConfig | undefined {
  return chains.find((c) => c.key === POLYGON_KEY)
}
