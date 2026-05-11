import { z } from 'zod'

/**
 * Per-chain env block schema. Each chain has its own ENV prefix; the prefix
 * is supplied by `buildPerChainSchema` so we only describe the shape once.
 *
 * A chain is considered "configured" if at minimum `<PREFIX>_RPC_URL(S)` and
 * `<PREFIX>_FEE_COLLECTOR_ADDRESS` and `<PREFIX>_START_BLOCK` are set.
 * Optional fields fall back to safe defaults.
 */
/**
 * Empty strings in env vars are equivalent to the var being unset — operators
 * commonly export `FOO=""` from shell scripts or `.env` files. Pre-coalesce
 * to `undefined` so `.optional()` works as expected.
 */
const emptyToUndefined = (v: unknown): unknown =>
  typeof v === 'string' && v.trim() === '' ? undefined : v

const rpcUrlsField = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .min(1, 'RPC URL(s) must not be empty')
    .transform((s) =>
      s
        .split(',')
        .map((u) => u.trim())
        .filter(Boolean),
    )
    .refine((arr) => arr.length > 0, 'At least one RPC URL required')
    .refine(
      (arr) => arr.every((u) => /^https?:\/\//.test(u) || /^wss?:\/\//.test(u)),
      'Each RPC URL must start with http(s):// or ws(s)://',
    )
    .optional(),
)

const optionalString = z.preprocess(emptyToUndefined, z.string().optional())
const optionalAddress = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .optional(),
)
const optionalNonNegativeInt = z.preprocess(
  emptyToUndefined,
  z.coerce.number().int().nonnegative().optional(),
)

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  API_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
  API_PORT: z.coerce.number().int().positive().default(3000),

  // --- API rate limiting (per-IP token bucket; 0 disables) ---
  API_RATE_LIMIT_BURST: z.coerce.number().int().nonnegative().default(60),
  API_RATE_LIMIT_REFILL_PER_SEC: z.coerce.number().int().nonnegative().default(30),

  MONGO_URI: z.string().refine((s) => s.startsWith('mongodb'), 'MONGO_URI must start with mongodb'),

  // --- Polygon (required for baseline behaviour) ---
  // Accept either POLYGON_RPC_URL (single) or POLYGON_RPC_URLS (csv).
  POLYGON_RPC_URL: optionalString,
  POLYGON_RPC_URLS: rpcUrlsField,
  POLYGON_FEE_COLLECTOR_ADDRESS: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid contract address'),
  POLYGON_START_BLOCK: z.coerce.number().int().nonnegative(),
  POLYGON_CONFIRMATIONS: z.coerce.number().int().nonnegative().default(12),
  POLYGON_CHUNK_SIZE: z.coerce.number().int().positive().default(2000),
  POLYGON_MIN_CHUNK_SIZE: z.coerce.number().int().positive().default(50),
  POLYGON_MAX_CHUNK_RETRIES: z.coerce.number().int().positive().default(6),
  POLYGON_REORG_WINDOW: z.coerce.number().int().nonnegative().default(0),

  // --- Ethereum (opt-in) ---
  ETHEREUM_RPC_URL: optionalString,
  ETHEREUM_RPC_URLS: rpcUrlsField,
  ETHEREUM_FEE_COLLECTOR_ADDRESS: optionalAddress,
  ETHEREUM_START_BLOCK: optionalNonNegativeInt,
  ETHEREUM_CONFIRMATIONS: z.coerce.number().int().nonnegative().default(20),
  ETHEREUM_CHUNK_SIZE: z.coerce.number().int().positive().default(2000),
  ETHEREUM_MIN_CHUNK_SIZE: z.coerce.number().int().positive().default(50),
  ETHEREUM_MAX_CHUNK_RETRIES: z.coerce.number().int().positive().default(6),
  ETHEREUM_REORG_WINDOW: z.coerce.number().int().nonnegative().default(0),

  // --- Arbitrum (opt-in) ---
  ARBITRUM_RPC_URL: optionalString,
  ARBITRUM_RPC_URLS: rpcUrlsField,
  ARBITRUM_FEE_COLLECTOR_ADDRESS: optionalAddress,
  ARBITRUM_START_BLOCK: optionalNonNegativeInt,
  ARBITRUM_CONFIRMATIONS: z.coerce.number().int().nonnegative().default(1),
  ARBITRUM_CHUNK_SIZE: z.coerce.number().int().positive().default(5000),
  ARBITRUM_MIN_CHUNK_SIZE: z.coerce.number().int().positive().default(100),
  ARBITRUM_MAX_CHUNK_RETRIES: z.coerce.number().int().positive().default(6),
  ARBITRUM_REORG_WINDOW: z.coerce.number().int().nonnegative().default(0),

  // --- Sync loop behaviour ---
  SYNC_RUN_ONCE: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
  SYNC_INTERVAL_MS: z.coerce.number().int().nonnegative().default(15_000),

  // --- RPC retry policy ---
  RPC_RETRY_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  RPC_RETRY_BASE_DELAY_MS: z.coerce.number().int().nonnegative().default(250),
  RPC_RETRY_MAX_DELAY_MS: z.coerce.number().int().nonnegative().default(10_000),

  // --- Token enrichment / aggregates ---
  TOKEN_ENRICHMENT_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
  AGGREGATES_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
})
  // Reorg window must cover at least one full chunk per chain. Otherwise the
  // checkpoint will advance past blocks that the *next* pass's reorg window
  // does not cover, and reorgs in that gap are undetectable. `0` disables
  // reorg reconciliation entirely and is allowed.
  .superRefine((cfg, ctx) => {
    const pairs: Array<[string, number, number]> = [
      ['POLYGON', cfg.POLYGON_REORG_WINDOW, cfg.POLYGON_CHUNK_SIZE],
      ['ETHEREUM', cfg.ETHEREUM_REORG_WINDOW, cfg.ETHEREUM_CHUNK_SIZE],
      ['ARBITRUM', cfg.ARBITRUM_REORG_WINDOW, cfg.ARBITRUM_CHUNK_SIZE],
    ]
    for (const [prefix, window, chunk] of pairs) {
      if (window > 0 && window < chunk) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [`${prefix}_REORG_WINDOW`],
          message: `${prefix}_REORG_WINDOW (${window}) must be >= ${prefix}_CHUNK_SIZE (${chunk}) when reorg reconciliation is enabled, otherwise the post-chunk window cannot cover the last ingested chunk and reorgs in that gap go undetected. Set to 0 to disable reorg reconciliation.`,
        })
      }
    }
  })

export type Env = z.infer<typeof envSchema>
