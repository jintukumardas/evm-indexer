import { computeNextFromBlock } from '../../src/db/repositories/syncStateRepository'

describe('computeNextFromBlock', () => {
  it('returns the configured start when no checkpoint exists yet', () => {
    expect(computeNextFromBlock(undefined, 78_600_000)).toBe(78_600_000)
  })

  it('returns lastSynced + 1 when ahead of the configured start', () => {
    expect(computeNextFromBlock(78_700_000, 78_600_000)).toBe(78_700_001)
  })

  it('clamps to the configured start when checkpoint is behind it', () => {
    // Could happen if an operator bumps START_BLOCK forward.
    expect(computeNextFromBlock(50_000, 78_600_000)).toBe(78_600_000)
  })

  it('handles lastSynced exactly equal to start - 1 (initial state)', () => {
    expect(computeNextFromBlock(78_599_999, 78_600_000)).toBe(78_600_000)
  })
})
