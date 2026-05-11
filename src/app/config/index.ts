import { envSchema, type Env } from './schema'
import { ConfigError } from '../errors'

export interface ChainIndexConfig {
  key: string
  chainId: number
  rpcUrls: string[]
  feeCollectorAddress: string
  startBlock: number
  confirmations: number
  chunkSize: number
  minChunkSize: number
  maxChunkRetries: number
  /**
   * How many blocks below the checkpoint to re-scan for reorgs on each pass.
   * 0 (default) disables reorg reconciliation — `confirmations` is the only
   * safety net in that mode.
   */
  reorgWindow: number
}

export interface RetryPolicyConfig {
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
}

export interface AppConfig {
  env: Env['NODE_ENV']
  logLevel: Env['LOG_LEVEL']
  api: {
    enabled: boolean
    port: number
    /** Per-IP token-bucket params. burst=0 disables the limiter entirely. */
    rateLimit: { burst: number; refillPerSec: number }
  }
  mongoUri: string
  sync: { runOnce: boolean; intervalMs: number }
  retry: RetryPolicyConfig
  tokenEnrichmentEnabled: boolean
  aggregatesEnabled: boolean
  chains: ChainIndexConfig[]
}

type ChainPrefix = 'POLYGON' | 'ETHEREUM' | 'ARBITRUM'

const CHAIN_DESCRIPTORS: ReadonlyArray<{
  key: string
  chainId: number
  prefix: ChainPrefix
  required: boolean
}> = [
  { key: 'polygon', chainId: 137, prefix: 'POLYGON', required: true },
  { key: 'ethereum', chainId: 1, prefix: 'ETHEREUM', required: false },
  { key: 'arbitrum', chainId: 42_161, prefix: 'ARBITRUM', required: false },
]

let cached: AppConfig | null = null

/**
 * Load, validate, and cache application configuration.
 *
 * A chain is registered when its `_RPC_URL(S)` + `_FEE_COLLECTOR_ADDRESS` +
 * `_START_BLOCK` are all present. Polygon is mandatory; Ethereum/Arbitrum are
 * opt-in.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (cached) return cached

  const parsed = envSchema.safeParse(env)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n')
    throw new ConfigError(`Invalid configuration:\n${issues}`)
  }
  const e = parsed.data

  const chains: ChainIndexConfig[] = []
  for (const desc of CHAIN_DESCRIPTORS) {
    const cfg = extractChainConfig(e, desc.prefix, desc.key, desc.chainId)
    if (cfg) {
      chains.push(cfg)
    } else if (desc.required) {
      throw new ConfigError(
        `Required chain "${desc.key}" is missing config. Set ${desc.prefix}_RPC_URL(S), ${desc.prefix}_FEE_COLLECTOR_ADDRESS, and ${desc.prefix}_START_BLOCK.`,
      )
    }
  }

  cached = {
    env: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    api: {
      enabled: e.API_ENABLED,
      port: e.API_PORT,
      rateLimit: {
        burst: e.API_RATE_LIMIT_BURST,
        refillPerSec: e.API_RATE_LIMIT_REFILL_PER_SEC,
      },
    },
    mongoUri: e.MONGO_URI,
    sync: { runOnce: e.SYNC_RUN_ONCE, intervalMs: e.SYNC_INTERVAL_MS },
    retry: {
      maxAttempts: e.RPC_RETRY_MAX_ATTEMPTS,
      baseDelayMs: e.RPC_RETRY_BASE_DELAY_MS,
      maxDelayMs: e.RPC_RETRY_MAX_DELAY_MS,
    },
    tokenEnrichmentEnabled: e.TOKEN_ENRICHMENT_ENABLED,
    aggregatesEnabled: e.AGGREGATES_ENABLED,
    chains,
  }
  return cached
}

/**
 * Pulls a chain block out of the parsed env. Returns undefined when the chain
 * isn't configured (no fee-collector address). This lets non-Polygon chains
 * be silently absent.
 */
function extractChainConfig(
  e: Env,
  prefix: ChainPrefix,
  key: string,
  chainId: number,
): ChainIndexConfig | undefined {
  const address = e[`${prefix}_FEE_COLLECTOR_ADDRESS` as keyof Env] as string | undefined
  const startBlock = e[`${prefix}_START_BLOCK` as keyof Env] as number | undefined
  const singleRpc = e[`${prefix}_RPC_URL` as keyof Env] as string | undefined
  const multiRpc = e[`${prefix}_RPC_URLS` as keyof Env] as string[] | undefined
  const rpcUrls = multiRpc && multiRpc.length > 0 ? multiRpc : singleRpc ? [singleRpc] : []

  if (!address || startBlock == null || rpcUrls.length === 0) return undefined

  return {
    key,
    chainId,
    rpcUrls,
    feeCollectorAddress: address.toLowerCase(),
    startBlock,
    confirmations: e[`${prefix}_CONFIRMATIONS` as keyof Env] as number,
    chunkSize: e[`${prefix}_CHUNK_SIZE` as keyof Env] as number,
    minChunkSize: e[`${prefix}_MIN_CHUNK_SIZE` as keyof Env] as number,
    maxChunkRetries: e[`${prefix}_MAX_CHUNK_RETRIES` as keyof Env] as number,
    reorgWindow: e[`${prefix}_REORG_WINDOW` as keyof Env] as number,
  }
}

/** Test helper — clears the cached config so a fresh env can be re-parsed. */
export function resetConfigForTests(): void {
  cached = null
}
