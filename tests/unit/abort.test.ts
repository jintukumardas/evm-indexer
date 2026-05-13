import { adaptiveFetchLogs } from '../../src/blockchain/scanners/eventScanner'

describe('adaptiveFetchLogs abort signal', () => {
  async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
    const out: T[] = []
    for await (const x of it) out.push(x)
    return out
  }

  it('stops yielding chunks after the signal fires', async () => {
    const abort = new AbortController()
    let calls = 0
    const fetcher = jest.fn(async () => {
      calls += 1
      if (calls === 2) abort.abort()
      return []
    })
    const out = await collect(
      adaptiveFetchLogs(0, 100, fetcher, {
        initialChunkSize: 10,
        minChunkSize: 1,
        maxRetries: 3,
        signal: abort.signal,
      }),
    )
    expect(out.length).toBeLessThan(11) // would have been 11 without abort
    expect(out.length).toBeGreaterThan(0) // first chunk should have been yielded
  })

  it('returns immediately if signal is already aborted', async () => {
    const abort = new AbortController()
    abort.abort()
    const fetcher = jest.fn()
    const out = await collect(
      adaptiveFetchLogs(0, 100, fetcher, {
        initialChunkSize: 10,
        minChunkSize: 1,
        maxRetries: 3,
        signal: abort.signal,
      }),
    )
    expect(out).toEqual([])
    expect(fetcher).not.toHaveBeenCalled()
  })
})
