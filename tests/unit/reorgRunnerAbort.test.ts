/**
 * Regression test for the abort-mid-reorg data-loss bug.
 *
 * If `adaptiveFetchLogs` returns cleanly because the signal aborted, the
 * `fetchedIdentities` list is a *partial* snapshot of the canonical chain.
 * Without the guard, ReorgRunner would diff that partial set against the
 * full persisted set and flag every row in the un-scanned portion of the
 * window as `removed: true` — silent mass data loss on SIGTERM.
 *
 * This test wires a plugin whose `parse` aborts the signal after emitting
 * the first batch, then asserts that no write methods are called.
 */
import { ethers } from 'ethers'
import pino from 'pino'
import type { ChainIndexConfig } from '../../src/app/config'
import { resetMetricsForTests } from '../../src/app/metrics'
import { ReorgRunner } from '../../src/indexer/reorgRunner'
import type {
  ContractEventPlugin,
  EventIdentity,
  IdentityRow,
} from '../../src/indexer/types'

const logger = pino({ level: 'silent' })

const CHAIN: ChainIndexConfig = {
  key: 'polygon',
  chainId: 137,
  rpcUrls: ['http://stub'],
  feeCollectorAddress: '0xunused',
  startBlock: 100,
  confirmations: 0,
  chunkSize: 100, // small so we'd take multiple chunks for a 1000-block window
  minChunkSize: 50,
  maxChunkRetries: 1,
  reorgWindow: 1000,
}

interface FakeEvent {
  blockNumber: number
  logIndex: number
  transactionHash: string
}

function fakeProvider(): ethers.providers.Provider {
  const p = new ethers.providers.StaticJsonRpcProvider('http://stub', 137)
  ;(p as unknown as { getBlock: jest.Mock }).getBlock = jest
    .fn()
    .mockImplementation(async (n: number) => ({ number: n, timestamp: 1_700_000_000 }))
  return p
}

beforeEach(() => {
  resetMetricsForTests()
})

afterEach(() => {
  delete (ethers.Contract.prototype as unknown as { queryFilter?: unknown }).queryFilter
})

describe('ReorgRunner — abort safety', () => {
  it('does not call markRemoved / persistChunk when the signal aborts mid-fetch', async () => {
    const callLog: string[] = []
    const abort = new AbortController()

    // Pretend the RPC returns one event per chunk so the for-await loop sees
    // multiple iterations; we abort after the first.
    ;(ethers.Contract.prototype as unknown as { queryFilter: jest.Mock }).queryFilter = jest
      .fn()
      .mockResolvedValue([
        { blockNumber: 1100, removed: false } as unknown as ethers.Event,
      ]) as never

    // Persisted rows span the FULL window (1100..2000). If the bug were
    // present the runner would diff against just the first chunk's fetched
    // identity and mark everything else removed.
    const persistedRows: IdentityRow[] = []
    for (let block = 1100; block <= 2000; block += 100) {
      persistedRows.push({
        identity: {
          chainId: CHAIN.chainId,
          contractAddress: '0xdummy',
          blockNumber: block,
          transactionHash: '0x' + block.toString(16).padStart(64, '0'),
          logIndex: 0,
        },
        removed: false,
      })
    }

    const plugin: ContractEventPlugin<FakeEvent> = {
      key: 'polygon:dummy:Dummy',
      chainKey: CHAIN.key,
      chainId: CHAIN.chainId,
      contractAddress: '0xdummy',
      eventName: 'Dummy',
      startBlock: 100,
      metricsLabels: { chain: CHAIN.key, plugin: 'polygon:dummy:Dummy' },
      getInterface: () => new ethers.utils.Interface(['event Dummy(uint256 a)']),
      buildFilter: () => ({ address: '0xdummy', topics: [] }),
      parse: jest.fn((events: ethers.Event[]) => {
        // Flip the abort after producing the first chunk's parsed output.
        // The runner is currently inside its for-await loop; the next
        // iteration will see the signal and return cleanly.
        if (!abort.signal.aborted) abort.abort()
        return events.map((e) => ({
          blockNumber: e.blockNumber,
          logIndex: 0,
          transactionHash: '0x' + 'a'.repeat(64),
        }))
      }),
      identityOf: (e): EventIdentity => ({
        chainId: CHAIN.chainId,
        contractAddress: '0xdummy',
        blockNumber: e.blockNumber,
        transactionHash: e.transactionHash,
        logIndex: e.logIndex,
      }),
      persistChunk: jest.fn(async () => {
        callLog.push('persistChunk')
        return { insertedCount: 0, duplicateCount: 0 }
      }),
      findInRange: jest.fn(async () => {
        callLog.push('findInRange')
        return persistedRows
      }),
      markRemoved: jest.fn(async () => {
        callLog.push('markRemoved')
        return 0
      }),
      restoreRemoved: jest.fn(async () => {
        callLog.push('restoreRemoved')
        return 0
      }),
    }

    const runner = new ReorgRunner({
      logger,
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    })

    // Window = [max(100, 2000 - 1000 + 1), 2000] = [1001, 2000]; with
    // chunkSize=100 the scanner would yield ~10 chunks, but we abort after
    // the first.
    const result = await runner.reconcile(plugin, CHAIN, fakeProvider(), 2000, abort.signal)

    expect(result).toBeNull() // bailed out cleanly
    expect(plugin.findInRange).not.toHaveBeenCalled()
    expect(plugin.markRemoved).not.toHaveBeenCalled()
    expect(plugin.restoreRemoved).not.toHaveBeenCalled()
    expect(plugin.persistChunk).not.toHaveBeenCalled()
    expect(callLog).toEqual([])
  })
})
