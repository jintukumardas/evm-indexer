/**
 * Regression test for the null-block crash in `fetchBlockTimestamps`.
 *
 * ethers `provider.getBlock(n)` returns `null` for unknown / pruned /
 * freshly-reorged blocks. Pre-fix, the function dereferenced
 * `block.timestamp` and threw a TypeError that bypassed `withRetry` and
 * crashed the entire chunk + sync pass. Post-fix, missing blocks are
 * silently skipped — the parser already handles `blockTimestamp == null`
 * by dropping the event.
 */
import { ethers } from 'ethers'
import { fetchBlockTimestamps } from '../../src/blockchain/scanners/blockTimestamps'

function provider(stub: (n: number) => unknown): ethers.providers.Provider {
  const p = new ethers.providers.StaticJsonRpcProvider('http://stub', 137)
  ;(p as unknown as { getBlock: jest.Mock }).getBlock = jest.fn(stub)
  return p
}

const policy = { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 }

describe('fetchBlockTimestamps', () => {
  it('returns a map keyed by block number with unix-seconds timestamps', async () => {
    const p = provider(async (n: number) => ({ number: n, timestamp: 1_700_000_000 + n }))
    const map = await fetchBlockTimestamps([10, 11, 12], p, { policy, label: 't' })
    expect(map.size).toBe(3)
    expect(map.get(11)).toBe(1_700_000_011)
  })

  it('skips blocks the provider returns null for instead of throwing', async () => {
    // Block 11 is "pruned" — ethers returns null.
    const p = provider(async (n: number) =>
      n === 11 ? null : { number: n, timestamp: 1_700_000_000 + n },
    )
    const map = await fetchBlockTimestamps([10, 11, 12], p, { policy, label: 't' })
    expect(map.has(11)).toBe(false)
    expect(map.get(10)).toBe(1_700_000_010)
    expect(map.get(12)).toBe(1_700_000_012)
  })

  it('dedupes block numbers before fetching', async () => {
    const calls: number[] = []
    const p = provider(async (n: number) => {
      calls.push(n)
      return { number: n, timestamp: 1 }
    })
    await fetchBlockTimestamps([10, 10, 11, 10], p, { policy, label: 't' })
    expect(calls.sort()).toEqual([10, 11])
  })

  it('honours an already-aborted signal without making any RPC calls', async () => {
    const calls: number[] = []
    const p = provider(async (n: number) => {
      calls.push(n)
      return { number: n, timestamp: 1 }
    })
    const ac = new AbortController()
    ac.abort()
    await fetchBlockTimestamps([10, 11], p, { policy, label: 't', signal: ac.signal })
    expect(calls).toEqual([])
  })
})
