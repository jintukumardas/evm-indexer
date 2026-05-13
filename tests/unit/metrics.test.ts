import { getMetrics, resetMetricsForTests } from '../../src/app/metrics'

beforeEach(() => resetMetricsForTests())

const labels = { chain: 'polygon', plugin: 'feeCollector' }

describe('metrics registry', () => {
  it('exposes prom-text metrics after recording, with chain + plugin labels', async () => {
    const m = getMetrics()
    m.eventsInserted.inc(labels, 7)
    m.eventsDuplicates.inc(labels, 3)
    m.lastSyncedBlock.set(labels, 78_650_000)
    m.reorgsDetected.inc(labels, 2)

    const text = await m.registry.metrics()
    expect(text).toMatch(
      /indexer_events_inserted_total\{chain="polygon",plugin="feeCollector"\} 7/,
    )
    expect(text).toMatch(
      /indexer_events_duplicates_total\{chain="polygon",plugin="feeCollector"\} 3/,
    )
    expect(text).toMatch(
      /indexer_last_synced_block\{chain="polygon",plugin="feeCollector"\} 78650000/,
    )
    expect(text).toMatch(
      /indexer_reorgs_detected_total\{chain="polygon",plugin="feeCollector"\} 2/,
    )
  })

  it('keeps two plugins on the same chain in separate series', async () => {
    const m = getMetrics()
    m.eventsInserted.inc({ chain: 'polygon', plugin: 'feeCollector' }, 5)
    m.eventsInserted.inc({ chain: 'polygon', plugin: 'uniswapV3' }, 9)

    const text = await m.registry.metrics()
    expect(text).toMatch(
      /indexer_events_inserted_total\{chain="polygon",plugin="feeCollector"\} 5/,
    )
    expect(text).toMatch(
      /indexer_events_inserted_total\{chain="polygon",plugin="uniswapV3"\} 9/,
    )
  })

  it('returns the same registry instance across calls', () => {
    const a = getMetrics()
    const b = getMetrics()
    expect(a).toBe(b)
  })

  it('resets cleanly between tests', async () => {
    const m1 = getMetrics()
    m1.eventsInserted.inc(labels, 5)
    resetMetricsForTests()
    const m2 = getMetrics()
    const text = await m2.registry.metrics()
    expect(text).not.toMatch(/indexer_events_inserted_total\{[^}]*\} 5/)
  })
})
