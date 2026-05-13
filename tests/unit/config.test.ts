import { loadConfig, resetConfigForTests } from '../../src/app/config'
import { ConfigError } from '../../src/app/errors'

const BASE: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  MONGO_URI: 'mongodb://localhost:27017/test',
  POLYGON_RPC_URL: 'https://polygon-rpc.com',
  POLYGON_FEE_COLLECTOR_ADDRESS: '0xbD6C7B0d2f68c2b7805d88388319cfB6EcB50eA9',
  POLYGON_START_BLOCK: '78600000',
}

beforeEach(() => resetConfigForTests())

describe('loadConfig', () => {
  it('returns Polygon-only config when only POLYGON_* are set', () => {
    const cfg = loadConfig(BASE)
    expect(cfg.chains.map((c) => c.key)).toEqual(['polygon'])
    expect(cfg.chains[0].rpcUrls).toEqual(['https://polygon-rpc.com'])
    expect(cfg.chains[0].feeCollectorAddress).toBe(
      '0xbd6c7b0d2f68c2b7805d88388319cfb6ecb50ea9', // lowercased
    )
  })

  it('parses POLYGON_RPC_URLS as a comma-separated list', () => {
    const cfg = loadConfig({
      ...BASE,
      POLYGON_RPC_URL: undefined,
      POLYGON_RPC_URLS: 'https://a.example, https://b.example , https://c.example',
    })
    expect(cfg.chains[0].rpcUrls).toEqual([
      'https://a.example',
      'https://b.example',
      'https://c.example',
    ])
  })

  it('prefers _RPC_URLS over _RPC_URL when both are set', () => {
    const cfg = loadConfig({
      ...BASE,
      POLYGON_RPC_URL: 'https://single.example',
      POLYGON_RPC_URLS: 'https://a.example,https://b.example',
    })
    expect(cfg.chains[0].rpcUrls).toEqual(['https://a.example', 'https://b.example'])
  })

  it('opts in Ethereum when its block is fully set', () => {
    const cfg = loadConfig({
      ...BASE,
      ETHEREUM_RPC_URL: 'https://eth.example',
      ETHEREUM_FEE_COLLECTOR_ADDRESS: '0x' + 'a'.repeat(40),
      ETHEREUM_START_BLOCK: '17000000',
    })
    expect(cfg.chains.map((c) => c.key)).toEqual(['polygon', 'ethereum'])
    expect(cfg.chains[1].chainId).toBe(1)
  })

  it('throws ConfigError when Polygon block is missing required fields', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'test',
        MONGO_URI: 'mongodb://localhost:27017/test',
        // no POLYGON_*
      } as NodeJS.ProcessEnv),
    ).toThrow(ConfigError)
  })

  it('throws ConfigError on malformed FEE_COLLECTOR address', () => {
    expect(() => loadConfig({ ...BASE, POLYGON_FEE_COLLECTOR_ADDRESS: 'not-an-address' })).toThrow(
      ConfigError,
    )
  })

  it('exposes retry policy and feature flags with defaults', () => {
    const cfg = loadConfig(BASE)
    expect(cfg.retry).toEqual({ maxAttempts: 5, baseDelayMs: 250, maxDelayMs: 10_000 })
    expect(cfg.tokenEnrichmentEnabled).toBe(true)
    expect(cfg.aggregatesEnabled).toBe(true)
  })

  it('respects opt-out flags', () => {
    const cfg = loadConfig({
      ...BASE,
      TOKEN_ENRICHMENT_ENABLED: 'false',
      AGGREGATES_ENABLED: 'false',
    })
    expect(cfg.tokenEnrichmentEnabled).toBe(false)
    expect(cfg.aggregatesEnabled).toBe(false)
  })

  it('treats empty-string env vars as unset (regression: e2e harness)', () => {
    // Bash scripts commonly export `FOO=""` for unset overrides — those must
    // not trip the `.min(1)` rule on POLYGON_RPC_URLS.
    const cfg = loadConfig({
      ...BASE,
      POLYGON_RPC_URLS: '',
      ETHEREUM_RPC_URL: '',
      ETHEREUM_RPC_URLS: '',
      ETHEREUM_FEE_COLLECTOR_ADDRESS: '',
      ETHEREUM_START_BLOCK: '',
      ARBITRUM_RPC_URL: '',
    })
    expect(cfg.chains.map((c) => c.key)).toEqual(['polygon'])
    expect(cfg.chains[0].rpcUrls).toEqual(['https://polygon-rpc.com'])
  })

  it('exposes reorgWindow per chain (default 0 = disabled)', () => {
    const cfgDefault = loadConfig(BASE)
    expect(cfgDefault.chains[0].reorgWindow).toBe(0)
    resetConfigForTests()
    // Reorg window must cover at least one chunk — see the schema-level
    // `superRefine`. We assert that a valid (window >= chunk) combination is
    // accepted, and that the invalid (window < chunk) combination is rejected.
    const cfgEnabled = loadConfig({
      ...BASE,
      POLYGON_REORG_WINDOW: '2000',
      POLYGON_CHUNK_SIZE: '2000',
    })
    expect(cfgEnabled.chains[0].reorgWindow).toBe(2000)
  })

  it('rejects POLYGON_REORG_WINDOW smaller than POLYGON_CHUNK_SIZE', () => {
    // Otherwise the next pass's reorg window would not cover the last ingested
    // chunk, and reorgs in that gap would go undetected (silent data loss).
    expect(() =>
      loadConfig({ ...BASE, POLYGON_REORG_WINDOW: '50', POLYGON_CHUNK_SIZE: '2000' }),
    ).toThrow(/REORG_WINDOW/)
  })
})
