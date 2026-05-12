import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client'

/**
 * Prometheus metrics registry. We expose a single process-wide registry +
 * named metrics so both the worker and the API can write to / read from it.
 *
 * Why a custom Registry (not `register` global): keeps metrics scoped, avoids
 * leaking between Jest tests, and lets us reset cleanly in tests.
 *
 * Every indexer metric carries both `chain` and `plugin` labels so that
 * multiple plugins on one chain (or one plugin on multiple chains) emit into
 * distinct series. Adding more plugins later requires no metric changes.
 */
export interface Metrics {
  registry: Registry
  chunkDuration: Histogram<'chain' | 'plugin' | 'outcome'>
  chunkEvents: Histogram<'chain' | 'plugin'>
  rpcErrors: Counter<'chain' | 'plugin' | 'kind'>
  eventsInserted: Counter<'chain' | 'plugin'>
  eventsDuplicates: Counter<'chain' | 'plugin'>
  reorgsDetected: Counter<'chain' | 'plugin'>
  rangeShrinks: Counter<'chain' | 'plugin'>
  lastSyncedBlock: Gauge<'chain' | 'plugin'>
  syncPasses: Counter<'chain' | 'plugin' | 'outcome'>
  httpRequests: Counter<'method' | 'route' | 'status'>
  httpDuration: Histogram<'method' | 'route' | 'status'>
}

let instance: Metrics | null = null

export function getMetrics(): Metrics {
  if (instance) return instance
  const registry = new Registry()
  collectDefaultMetrics({ register: registry })

  instance = {
    registry,
    chunkDuration: new Histogram({
      name: 'indexer_chunk_duration_seconds',
      help: 'Wall-clock time per chunk (parse + persist)',
      labelNames: ['chain', 'plugin', 'outcome'] as const,
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
      registers: [registry],
    }),
    chunkEvents: new Histogram({
      name: 'indexer_chunk_events',
      help: 'Number of events found per chunk',
      labelNames: ['chain', 'plugin'] as const,
      buckets: [0, 1, 5, 10, 50, 100, 500, 1000, 5000, 10_000],
      registers: [registry],
    }),
    rpcErrors: new Counter({
      name: 'indexer_rpc_errors_total',
      help: 'RPC errors observed by the indexer',
      labelNames: ['chain', 'plugin', 'kind'] as const,
      registers: [registry],
    }),
    eventsInserted: new Counter({
      name: 'indexer_events_inserted_total',
      help: 'New events written to MongoDB',
      labelNames: ['chain', 'plugin'] as const,
      registers: [registry],
    }),
    eventsDuplicates: new Counter({
      name: 'indexer_events_duplicates_total',
      help: 'Duplicate events skipped by the unique index',
      labelNames: ['chain', 'plugin'] as const,
      registers: [registry],
    }),
    reorgsDetected: new Counter({
      name: 'indexer_reorgs_detected_total',
      help: 'Persisted events flagged as removed during reorg reconciliation',
      labelNames: ['chain', 'plugin'] as const,
      registers: [registry],
    }),
    rangeShrinks: new Counter({
      name: 'indexer_range_shrinks_total',
      help: 'Adaptive chunk-shrink events triggered by RPC range limits',
      labelNames: ['chain', 'plugin'] as const,
      registers: [registry],
    }),
    lastSyncedBlock: new Gauge({
      name: 'indexer_last_synced_block',
      help: 'Highest block number persisted per (chain, plugin)',
      labelNames: ['chain', 'plugin'] as const,
      registers: [registry],
    }),
    syncPasses: new Counter({
      name: 'indexer_sync_passes_total',
      help: 'Sync passes by outcome',
      labelNames: ['chain', 'plugin', 'outcome'] as const,
      registers: [registry],
    }),
    httpRequests: new Counter({
      name: 'http_requests_total',
      help: 'HTTP requests served by the API',
      labelNames: ['method', 'route', 'status'] as const,
      registers: [registry],
    }),
    httpDuration: new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request duration',
      labelNames: ['method', 'route', 'status'] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [registry],
    }),
  }
  return instance
}

/** Test helper — drops the singleton so a clean registry is built. */
export function resetMetricsForTests(): void {
  if (instance) instance.registry.clear()
  instance = null
}
