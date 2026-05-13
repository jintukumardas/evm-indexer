import { adaptiveFetchLogs, computeChunkRanges } from '../../src/blockchain/scanners/eventScanner'
import { RpcError } from '../../src/app/errors'

describe('computeChunkRanges', () => {
  it('splits an inclusive range into equal chunks', () => {
    const ranges = computeChunkRanges(100, 109, 4)
    expect(ranges).toEqual([
      { fromBlock: 100, toBlock: 103 },
      { fromBlock: 104, toBlock: 107 },
      { fromBlock: 108, toBlock: 109 },
    ])
  })

  it('returns an empty array when from > to', () => {
    expect(computeChunkRanges(10, 5, 100)).toEqual([])
  })

  it('returns a single chunk when range is smaller than chunkSize', () => {
    expect(computeChunkRanges(1, 5, 100)).toEqual([{ fromBlock: 1, toBlock: 5 }])
  })

  it('handles a chunkSize of 1', () => {
    expect(computeChunkRanges(0, 2, 1)).toEqual([
      { fromBlock: 0, toBlock: 0 },
      { fromBlock: 1, toBlock: 1 },
      { fromBlock: 2, toBlock: 2 },
    ])
  })

  it('throws when chunkSize <= 0', () => {
    expect(() => computeChunkRanges(0, 10, 0)).toThrow()
  })
})

// Fake provider error mimicking the common "block range too large" shape.
class RangeError extends Error {
  code = -32005
  constructor() {
    super('query returned more than 10000 results; range is too large')
  }
}

describe('adaptiveFetchLogs', () => {
  async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
    const out: T[] = []
    for await (const x of it) out.push(x)
    return out
  }

  it('yields one entry per chunk when the fetcher succeeds', async () => {
    const fetcher = jest.fn(async (from: number, to: number) =>
      [{ blockNumber: from, transactionHash: '0xtx', logIndex: 0, blockHash: '0xb' } as never].concat(
        to > from
          ? [{ blockNumber: to, transactionHash: '0xtx2', logIndex: 0, blockHash: '0xb' } as never]
          : [],
      ),
    )
    const out = await collect(
      adaptiveFetchLogs(10, 25, fetcher, {
        initialChunkSize: 5,
        minChunkSize: 1,
        maxRetries: 3,
      }),
    )
    expect(out.map((r) => r.range)).toEqual([
      { fromBlock: 10, toBlock: 14 },
      { fromBlock: 15, toBlock: 19 },
      { fromBlock: 20, toBlock: 24 },
      { fromBlock: 25, toBlock: 25 },
    ])
    expect(fetcher).toHaveBeenCalledTimes(4)
  })

  it('halves the chunk size on a range-limit error and retries the same block', async () => {
    let calls = 0
    const fetcher = jest.fn(async (from: number, to: number) => {
      calls += 1
      // First call covers a 16-block window — fail.
      if (calls === 1) {
        expect(from).toBe(0)
        expect(to).toBe(15)
        throw new RangeError()
      }
      // Subsequent calls should be 8-block windows (halved).
      expect(to - from).toBe(7)
      return []
    })
    const out = await collect(
      adaptiveFetchLogs(0, 15, fetcher, {
        initialChunkSize: 16,
        minChunkSize: 1,
        maxRetries: 5,
      }),
    )
    expect(out.map((r) => r.range)).toEqual([
      { fromBlock: 0, toBlock: 7 },
      { fromBlock: 8, toBlock: 15 },
    ])
  })

  it('keeps halving until the call succeeds or we hit the floor', async () => {
    let calls = 0
    // Only accept single-block windows. Forces the scanner to shrink from 4 -> 2 -> 1.
    const fetcher = jest.fn(async (from: number, to: number) => {
      calls += 1
      if (to !== from) throw new RangeError()
      return []
    })
    const out = await collect(
      adaptiveFetchLogs(0, 3, fetcher, { initialChunkSize: 4, minChunkSize: 1, maxRetries: 10 }),
    )
    // 4 -> fail; 2 -> fail; 1 -> success x4 = 6 calls total
    expect(calls).toBe(6)
    expect(out.map((r) => r.range)).toEqual([
      { fromBlock: 0, toBlock: 0 },
      { fromBlock: 1, toBlock: 1 },
      { fromBlock: 2, toBlock: 2 },
      { fromBlock: 3, toBlock: 3 },
    ])
  })

  it('throws RpcError when the chunk cannot be shrunk further', async () => {
    const fetcher = async () => {
      throw new RangeError()
    }
    await expect(
      collect(
        adaptiveFetchLogs(0, 100, fetcher, { initialChunkSize: 2, minChunkSize: 2, maxRetries: 3 }),
      ),
    ).rejects.toBeInstanceOf(RpcError)
  })

  it('does not retry non-range errors', async () => {
    const fetcher = jest.fn(async () => {
      throw new Error('socket hang up')
    })
    await expect(
      collect(adaptiveFetchLogs(0, 9, fetcher, { initialChunkSize: 10, minChunkSize: 1, maxRetries: 3 })),
    ).rejects.toBeInstanceOf(RpcError)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('returns nothing when from > to', async () => {
    const fetcher = jest.fn()
    const out = await collect(
      adaptiveFetchLogs(20, 10, fetcher, { initialChunkSize: 5, minChunkSize: 1, maxRetries: 1 }),
    )
    expect(out).toEqual([])
    expect(fetcher).not.toHaveBeenCalled()
  })
})
