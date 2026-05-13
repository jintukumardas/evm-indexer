import { defaultIsTransient, withRetry } from '../../src/blockchain/providers/retry'
import { isRangeLimitError, RpcError } from '../../src/app/errors'

const POLICY = { maxAttempts: 4, baseDelayMs: 10, maxDelayMs: 100 }

// Test-only sleeper that is instant — keeps the suite fast.
const noSleep = () => Promise.resolve()

describe('defaultIsTransient', () => {
  it('classifies common transient errors as retryable', () => {
    expect(defaultIsTransient(new Error('ETIMEDOUT'))).toBe(true)
    expect(defaultIsTransient(new Error('socket hang up'))).toBe(true)
    expect(defaultIsTransient(new Error('rate limit exceeded'))).toBe(true)
    expect(defaultIsTransient({ status: 503, message: 'service unavailable' })).toBe(true)
    expect(defaultIsTransient({ status: 429, message: 'too many' })).toBe(true)
    expect(defaultIsTransient({ code: 'ECONNRESET' })).toBe(true)
  })

  it('rejects non-transient errors', () => {
    expect(defaultIsTransient(new Error('user not found'))).toBe(false)
    expect(defaultIsTransient(new Error('invalid input'))).toBe(false)
  })

  it('rejects range-limit errors (handled separately by the scanner)', () => {
    expect(defaultIsTransient(new Error('query returned more than 10000 results'))).toBe(false)
    expect(defaultIsTransient(new Error('block range is too wide'))).toBe(false)
  })

  it('treats AbortError as non-transient', () => {
    const err = new Error('aborted')
    ;(err as Error & { name: string }).name = 'AbortError'
    expect(defaultIsTransient(err)).toBe(false)
  })
})

describe('isRangeLimitError', () => {
  it('classifies obvious range/size phrases', () => {
    expect(isRangeLimitError(new Error('block range is too wide'))).toBe(true)
    expect(isRangeLimitError(new Error('query returned more than 10000 results'))).toBe(true)
    expect(isRangeLimitError(new Error('response size is too large'))).toBe(true)
    expect(isRangeLimitError(new Error('too many logs'))).toBe(true)
  })

  it('does NOT treat the bare JSON-RPC code -32005 as range-limit', () => {
    // Infura/Alchemy reuse `-32005` for plain throughput rate limits — those
    // need to flow into the retry/backoff layer, not chunk shrinking. Without
    // a range/size phrase the classifier should refuse.
    const rateLimit = { code: -32005, message: 'daily request count exceeded' }
    expect(isRangeLimitError(rateLimit)).toBe(false)
    // And the retry layer should still consider this transient.
    expect(defaultIsTransient(rateLimit)).toBe(false) // no "rate limit" phrase
    const withPhrase = { code: -32005, message: 'rate limit exceeded' }
    expect(isRangeLimitError(withPhrase)).toBe(false)
    expect(defaultIsTransient(withPhrase)).toBe(true)
  })

  it('still classifies -32005 + range phrase as range', () => {
    // The real-world payload that prompted the original `-32005` heuristic
    // always carried a range phrase too — that's the case we still catch.
    expect(
      isRangeLimitError({
        code: -32005,
        message: 'query returned more than 10000 results',
      }),
    ).toBe(true)
  })
})

describe('withRetry', () => {
  it('returns immediately on success without retrying', async () => {
    const op = jest.fn().mockResolvedValue('ok')
    await expect(withRetry(op, { policy: POLICY, sleeper: noSleep })).resolves.toBe('ok')
    expect(op).toHaveBeenCalledTimes(1)
  })

  it('retries transient errors up to maxAttempts and then throws RpcError', async () => {
    const op = jest.fn().mockRejectedValue(new Error('ECONNRESET'))
    await expect(withRetry(op, { policy: POLICY, sleeper: noSleep })).rejects.toBeInstanceOf(RpcError)
    expect(op).toHaveBeenCalledTimes(POLICY.maxAttempts)
  })

  it('does NOT retry non-transient errors', async () => {
    const op = jest.fn().mockRejectedValue(new Error('user not found'))
    await expect(withRetry(op, { policy: POLICY, sleeper: noSleep })).rejects.toThrow('user not found')
    expect(op).toHaveBeenCalledTimes(1)
  })

  it('returns success on a later attempt after transient failures', async () => {
    let calls = 0
    const op = jest.fn().mockImplementation(async () => {
      calls += 1
      if (calls < 3) throw new Error('socket hang up')
      return 'recovered'
    })
    await expect(withRetry(op, { policy: POLICY, sleeper: noSleep })).resolves.toBe('recovered')
    expect(op).toHaveBeenCalledTimes(3)
  })

  it('stops retrying when the abort signal fires', async () => {
    const abort = new AbortController()
    const op = jest.fn().mockImplementation(async () => {
      abort.abort()
      throw new Error('socket hang up')
    })
    await expect(
      withRetry(op, { policy: POLICY, sleeper: noSleep, signal: abort.signal }),
    ).rejects.toThrow('socket hang up')
    expect(op).toHaveBeenCalledTimes(1)
  })

  it('passes a label through to the wrapped RpcError', async () => {
    const op = jest.fn().mockRejectedValue(new Error('ECONNRESET'))
    await expect(
      withRetry(op, { policy: POLICY, sleeper: noSleep, label: 'polygon-getBlockNumber' }),
    ).rejects.toThrow(/polygon-getBlockNumber/)
  })
})
