/**
 * Architecture invariant test for `SyncRunner`.
 *
 * Proves the runner has no FeeCollector-specific knowledge: a synthetic
 * `DummyPlugin` is registered and driven through a full sync pass with a
 * fake provider, and the assertions verify the *contract* the runner
 * promises every plugin:
 *
 *   (1) Reorg runs before any forward-chunk parsing
 *   (2) persistChunk receives exactly what parse returned, in order
 *   (3) advanceCheckpoint is called AFTER persistChunk resolves, never before
 *   (4) onPostSync is called once at the end with the union of the reorg
 *       and forward block ranges, and is skipped when aborted
 *   (5) Two plugins on the same chain run independently — separate
 *       checkpoints, separate metric labels, no shared state
 *
 * Adding a new plugin should not require changing this test or `SyncRunner`.
 */
import { ethers } from 'ethers'
import pino from 'pino'
import type { AppConfig, ChainIndexConfig } from '../../src/app/config'
import { resetMetricsForTests } from '../../src/app/metrics'
import { SyncRunner } from '../../src/indexer/syncRunner'
import { ReorgRunner } from '../../src/indexer/reorgRunner'
import type {
  ContractEventPlugin,
  EventIdentity,
  IdentityRow,
  PluginPostSyncContext,
} from '../../src/indexer/types'

const logger = pino({ level: 'silent' })

const CHAIN: ChainIndexConfig = {
  key: 'polygon',
  chainId: 137,
  rpcUrls: ['http://stub'],
  feeCollectorAddress: '0xunused',
  startBlock: 100,
  confirmations: 0,
  chunkSize: 1000,
  minChunkSize: 100,
  maxChunkRetries: 1,
  reorgWindow: 5,
}

const CONFIG: AppConfig = {
  env: 'test',
  logLevel: 'silent',
  api: { enabled: false, port: 0, rateLimit: { burst: 0, refillPerSec: 0 } },
  mongoUri: 'mongodb://localhost/x',
  sync: { runOnce: true, intervalMs: 0 },
  retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
  tokenEnrichmentEnabled: false,
  aggregatesEnabled: false,
  chains: [CHAIN],
}

interface Event {
  blockNumber: number
  logIndex: number
  transactionHash: string
}

function makeEvent(over: Partial<Event> = {}): Event {
  return {
    blockNumber: 110,
    logIndex: 0,
    transactionHash: '0x' + 'a'.repeat(64),
    ...over,
  }
}

/**
 * Records the call order of every plugin and repo method we care about.
 * Each entry is `"<plugin-key>:<method>(...args)"`. The architecture asserts
 * are then just `indexOf` comparisons.
 */
type CallLog = string[]

function makeDummyPlugin(opts: {
  key: string
  callLog: CallLog
  parsedEvents: Event[]
  contractAddress?: string
  eventName?: string
  postSyncSpy?: (ctx: PluginPostSyncContext) => void
}): ContractEventPlugin<Event> {
  const contractAddress = opts.contractAddress ?? '0xdummycontract'
  const eventName = opts.eventName ?? 'Dummy'
  const tag = opts.key

  return {
    key: opts.key,
    chainKey: CHAIN.key,
    chainId: CHAIN.chainId,
    contractAddress,
    eventName,
    startBlock: CHAIN.startBlock,
    metricsLabels: { chain: CHAIN.key, plugin: opts.key },
    getInterface: () =>
      new ethers.utils.Interface([
        // We never actually parse from this ABI — the runner only uses the
        // interface to build a Contract, and our DummyPlugin.parse() ignores
        // the input. The ABI is non-empty so ethers does not complain.
        'event Dummy(uint256 a)',
      ]),
    buildFilter: () => ({ address: contractAddress, topics: [] }),
    parse: jest.fn((events: ethers.Event[]) => {
      opts.callLog.push(`${tag}:parse(${events.length})`)
      // The architecture test asserts persistChunk gets *what parse returned*,
      // in order. We ignore the synthetic event stream and emit our canned set.
      return opts.parsedEvents.map((e) => ({ ...e }))
    }),
    identityOf: (e): EventIdentity => ({
      chainId: CHAIN.chainId,
      contractAddress,
      blockNumber: e.blockNumber,
      transactionHash: e.transactionHash,
      logIndex: e.logIndex,
    }),
    persistChunk: jest.fn(async (parsed: Event[]) => {
      opts.callLog.push(
        `${tag}:persistChunk(${parsed.map((e) => `${e.blockNumber}/${e.logIndex}`).join(',')})`,
      )
      return { insertedCount: parsed.length, duplicateCount: 0 }
    }),
    findInRange: jest.fn(async (from: number, to: number): Promise<IdentityRow[]> => {
      opts.callLog.push(`${tag}:findInRange(${from}-${to})`)
      return []
    }),
    markRemoved: jest.fn(async () => 0),
    restoreRemoved: jest.fn(async () => 0),
    onPostSync: jest.fn(async (ctx: PluginPostSyncContext) => {
      opts.callLog.push(`${tag}:onPostSync(${ctx.fromBlock}-${ctx.toBlock})`)
      opts.postSyncSpy?.(ctx)
    }),
  }
}

interface FakeSyncStateRepo {
  getOrInit: jest.Mock
  advanceCheckpoint: jest.Mock
  markRunning: jest.Mock
  markIdle: jest.Mock
  markError: jest.Mock
}

function makeSyncState(callLog: CallLog, lastSyncedByEvent: Record<string, number>): FakeSyncStateRepo {
  return {
    getOrInit: jest.fn(async (key, def) => {
      const last = lastSyncedByEvent[key.eventName] ?? def - 1
      return { ...key, lastSyncedBlock: last }
    }),
    advanceCheckpoint: jest.fn(async (key, to) => {
      callLog.push(`syncState:${key.eventName}:advance(${to})`)
      lastSyncedByEvent[key.eventName] = to
    }),
    markRunning: jest.fn(async () => undefined),
    markIdle: jest.fn(async (key) => {
      callLog.push(`syncState:${key.eventName}:idle`)
    }),
    markError: jest.fn(async () => undefined),
  }
}

function fakeProvider(latestBlock: number): ethers.providers.Provider {
  const p = new ethers.providers.StaticJsonRpcProvider('http://stub', 137)
  ;(p as unknown as { getBlockNumber: jest.Mock }).getBlockNumber = jest
    .fn()
    .mockResolvedValue(latestBlock)
  ;(p as unknown as { getBlock: jest.Mock }).getBlock = jest
    .fn()
    .mockImplementation(async (n: number) => ({ number: n, timestamp: 1_700_000_000 }))
  return p
}

beforeEach(() => {
  resetMetricsForTests()
})

afterEach(() => {
  // Clear any prototype patches between tests.
  delete (ethers.Contract.prototype as unknown as { queryFilter?: unknown }).queryFilter
})

describe('SyncRunner — architecture invariants', () => {
  it('reorg runs before forward parsing, persist precedes checkpoint, onPostSync is last', async () => {
    const callLog: CallLog = []
    const provider = fakeProvider(150)

    // Patch queryFilter at the prototype level so EVERY ethers.Contract the
    // runner builds returns the canned set. The runner does not depend on
    // this — only the plugin's parse() does, and our DummyPlugin discards
    // the events and emits its own.
    ;(ethers.Contract.prototype as unknown as { queryFilter: jest.Mock }).queryFilter = jest
      .fn()
      .mockResolvedValue([
        // Two minimal stand-in ethers.Event objects — fields beyond
        // blockNumber are unused because DummyPlugin.parse ignores them.
        { blockNumber: 110, removed: false } as unknown as ethers.Event,
        { blockNumber: 112, removed: false } as unknown as ethers.Event,
      ]) as never

    const plugin = makeDummyPlugin({
      key: 'polygon:dummy:Dummy',
      callLog,
      parsedEvents: [makeEvent({ blockNumber: 110 }), makeEvent({ blockNumber: 112, logIndex: 1 })],
    })

    const syncState = makeSyncState(callLog, { Dummy: 105 })
    const reorgRunner = new ReorgRunner({
      logger,
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    })
    const runner = new SyncRunner({
      syncState: syncState as never,
      logger,
      config: CONFIG,
      providerFor: () => provider,
    })

    const summary = await runner.run(plugin, CHAIN, undefined, { reorgRunner })

    expect(summary.eventsFound).toBe(2)
    expect(summary.eventsInserted).toBe(2)

    // Reorg runs entirely before the forward chunk loop:
    //   - `findInRange` is only ever invoked by the reorg runner
    //   - `advanceCheckpoint` is only ever invoked by the forward runner
    const reorgIdx = callLog.findIndex((s) => s.includes(':findInRange'))
    const advanceIdx = callLog.findIndex((s) => s.startsWith('syncState:Dummy:advance('))
    expect(reorgIdx).toBeGreaterThanOrEqual(0)
    expect(advanceIdx).toBeGreaterThan(reorgIdx)

    // persistChunk got *exactly* what parse returned, in order, no reordering.
    const persistCall = (plugin.persistChunk as jest.Mock).mock.calls
      .find((args: Event[][]) => args[0].length === 2)
    expect(persistCall).toBeDefined()
    const handed = persistCall![0] as Event[]
    expect(handed.map((e) => [e.blockNumber, e.logIndex])).toEqual([
      [110, 0],
      [112, 1],
    ])

    // advanceCheckpoint follows the forward persistChunk: we identify the
    // forward chunk's persist call by its position relative to findInRange
    // (reorg's persist comes before findInRange; forward's persist comes
    // after).
    const persistEntries = callLog
      .map((s, i) => ({ s, i }))
      .filter((e) => e.s.startsWith('polygon:dummy:Dummy:persistChunk'))
    const forwardPersistIdx = persistEntries.find((e) => e.i > reorgIdx)?.i
    expect(forwardPersistIdx).toBeDefined()
    expect(advanceIdx).toBeGreaterThan(forwardPersistIdx!)

    // onPostSync ran exactly once, after all chunks were persisted+advanced,
    // and before markIdle (which closes the pass).
    const postCalls = callLog.filter((s) => s.startsWith('polygon:dummy:Dummy:onPostSync('))
    expect(postCalls).toHaveLength(1)
    const postIdx = callLog.indexOf(postCalls[0])
    const idleIdx = callLog.indexOf('syncState:Dummy:idle')
    expect(postIdx).toBeGreaterThan(advanceIdx)
    expect(idleIdx).toBeGreaterThan(postIdx)
    // Union range: reorgFromBlock = max(startBlock, checkpoint - reorgWindow + 1)
    //   = max(100, 105 - 5 + 1) = 101
    // forward fromBlock = 106; union start = min(101, 106) = 101; toBlock = 150
    expect(postCalls[0]).toBe('polygon:dummy:Dummy:onPostSync(101-150)')
  })

  it('skips onPostSync when aborted between chunks', async () => {
    const callLog: CallLog = []
    const provider = fakeProvider(120)
    ;(ethers.Contract.prototype as unknown as { queryFilter: jest.Mock }).queryFilter = jest
      .fn()
      .mockResolvedValue([{ blockNumber: 110, removed: false } as unknown as ethers.Event]) as never

    const abort = new AbortController()
    const plugin = makeDummyPlugin({
      key: 'polygon:dummy:Dummy',
      callLog,
      parsedEvents: [makeEvent()],
    })
    // Flip the abort signal mid-pass — after the first persistChunk resolves.
    ;(plugin.persistChunk as jest.Mock).mockImplementationOnce(async (parsed: Event[]) => {
      callLog.push(`dummy:persistChunk(${parsed.length})`)
      abort.abort()
      return { insertedCount: parsed.length, duplicateCount: 0 }
    })

    const syncState = makeSyncState(callLog, { Dummy: 105 })
    const runner = new SyncRunner({
      syncState: syncState as never,
      logger,
      config: CONFIG,
      providerFor: () => provider,
    })

    const summary = await runner.run(plugin, { ...CHAIN, reorgWindow: 0 }, abort.signal)
    expect(summary.aborted).toBe(true)
    expect(plugin.onPostSync).not.toHaveBeenCalled()
  })

  it('two plugins on the same chain keep independent checkpoints and metric labels', async () => {
    const callLog: CallLog = []
    const provider = fakeProvider(140)
    ;(ethers.Contract.prototype as unknown as { queryFilter: jest.Mock }).queryFilter = jest
      .fn()
      .mockResolvedValue([{ blockNumber: 130, removed: false } as unknown as ethers.Event]) as never

    const pluginA = makeDummyPlugin({
      key: 'polygon:dummy:A',
      callLog,
      parsedEvents: [makeEvent({ blockNumber: 130, transactionHash: '0xa' })],
      eventName: 'A',
      contractAddress: '0xcontractA',
    })
    const pluginB = makeDummyPlugin({
      key: 'polygon:dummy:B',
      callLog,
      parsedEvents: [makeEvent({ blockNumber: 130, transactionHash: '0xb' })],
      eventName: 'B',
      contractAddress: '0xcontractB',
    })

    // Different checkpoints by event name — proves the SyncState key isolates
    // them even when contract+chain overlap.
    const lastSynced = { A: 100, B: 120 }
    const syncState = makeSyncState(callLog, lastSynced)

    const runner = new SyncRunner({
      syncState: syncState as never,
      logger,
      config: CONFIG,
      providerFor: () => provider,
    })

    const summaryA = await runner.run(pluginA, { ...CHAIN, reorgWindow: 0 })
    const summaryB = await runner.run(pluginB, { ...CHAIN, reorgWindow: 0 })

    // Each plugin scanned forward from its own checkpoint + 1.
    expect(summaryA.fromBlock).toBe(101)
    expect(summaryB.fromBlock).toBe(121)

    // Sync state was advanced under each event's own key (and the keys map to
    // different rows in production via the unique index).
    expect(callLog).toContain('syncState:A:advance(140)')
    expect(callLog).toContain('syncState:B:advance(140)')

    // Metrics labels carry both `chain` and `plugin` distinctly.
    expect(pluginA.metricsLabels.plugin).not.toBe(pluginB.metricsLabels.plugin)
    expect(pluginA.metricsLabels.chain).toBe(pluginB.metricsLabels.chain)
  })
})
