import {
  clampLimit,
  decodeCursor,
  encodeCursor,
} from '../../src/services/fee-events/feeEventsService'
import { ValidationError } from '../../src/app/errors'

describe('cursor encoding', () => {
  it('round-trips a cursor through base64url', () => {
    const c = {
      blockNumber: 78_600_123,
      logIndex: 7,
      transactionHash: '0x' + 'a'.repeat(64),
      chainId: 137,
    }
    expect(decodeCursor(encodeCursor(c))).toEqual(c)
  })

  it('rejects garbage cursors with a ValidationError', () => {
    expect(() => decodeCursor('not-a-cursor')).toThrow(ValidationError)
    expect(() => decodeCursor(Buffer.from('{}', 'utf8').toString('base64url'))).toThrow(
      ValidationError,
    )
    expect(() =>
      decodeCursor(
        Buffer.from(
          JSON.stringify({
            blockNumber: -1,
            logIndex: 0,
            transactionHash: '0x' + 'a'.repeat(64),
            chainId: 137,
          }),
        ).toString('base64url'),
      ),
    ).toThrow(ValidationError)
    // Missing transactionHash → invalid
    expect(() =>
      decodeCursor(
        Buffer.from(JSON.stringify({ blockNumber: 1, logIndex: 0, chainId: 137 })).toString(
          'base64url',
        ),
      ),
    ).toThrow(ValidationError)
    // Empty transactionHash → invalid (must be a non-empty string)
    expect(() =>
      decodeCursor(
        Buffer.from(
          JSON.stringify({
            blockNumber: 1,
            logIndex: 0,
            transactionHash: '',
            chainId: 137,
          }),
        ).toString('base64url'),
      ),
    ).toThrow(ValidationError)
  })

  it('rejects empty cursors', () => {
    expect(() => decodeCursor('')).toThrow(ValidationError)
  })

  it('rejects oversized cursors before attempting to decode them', () => {
    // A real cursor is < 100 bytes. We hard-cap at 256 so a malicious caller
    // can't make us allocate megabytes parsing a giant base64 blob.
    const huge = 'a'.repeat(10_000)
    expect(() => decodeCursor(huge)).toThrow(ValidationError)
  })
})

describe('clampLimit', () => {
  it('uses the default for undefined / NaN', () => {
    expect(clampLimit(undefined)).toBe(50)
    expect(clampLimit(Number.NaN)).toBe(50)
  })
  it('clamps to [1, 500]', () => {
    expect(clampLimit(0)).toBe(1)
    expect(clampLimit(-5)).toBe(1)
    expect(clampLimit(10_000)).toBe(500)
    expect(clampLimit(75)).toBe(75)
  })
  it('floors fractional limits', () => {
    expect(clampLimit(7.9)).toBe(7)
  })
})
