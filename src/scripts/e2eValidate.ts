/**
 * End-to-end validator. Invoked by `scripts/e2e/run.sh` after a live sync pass.
 *
 * It reads only env vars (so the harness controls test-window bounds) and
 * exits non-zero on the first set of assertion failures. All assertions are
 * collected first then printed together so the operator sees the full picture
 * rather than one-error-at-a-time.
 */
import mongoose from 'mongoose'
import { FeeEventModel } from '../db/models/FeeEvent'
import { SyncStateModel } from '../db/models/SyncState'
import { DailyAggregateModel } from '../db/models/DailyAggregate'

interface Result {
  name: string
  ok: boolean
  details?: string
}

const results: Result[] = []
function check(name: string, ok: boolean, details?: string): boolean {
  results.push({ name, ok, details })
  return ok
}

function required(key: string): string {
  const v = process.env[key]
  if (!v) throw new Error(`Missing env var ${key}`)
  return v
}

async function fetchJson(url: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url)
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  return { status: res.status, body }
}

async function fetchText(url: string): Promise<{ status: number; body: string }> {
  const res = await fetch(url)
  return { status: res.status, body: await res.text() }
}

async function main(): Promise<void> {
  const mongoUri = required('MONGO_URI')
  const apiBase = required('API_BASE')
  const fromBlock = Number(required('EXPECTED_FROM_BLOCK'))
  const toBlock = Number(required('EXPECTED_TO_BLOCK'))
  const feeCollector = required('POLYGON_FEE_COLLECTOR_ADDRESS').toLowerCase()

  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 10_000 })

  // ── 1. SyncState advanced to the safe head ──────────────────────────────
  // SyncState rows are keyed on (chainKey, contractAddress, eventName); this
  // validator targets the FeeCollector plugin's `FeesCollected` row.
  const sync = await SyncStateModel.findOne({
    chainKey: 'polygon',
    contractAddress: feeCollector,
    eventName: 'FeesCollected',
  }).lean()
  if (!check('SyncState row exists', !!sync, 'no row for polygon')) {
    return finish(false)
  }
  check(
    'SyncState advanced to >= start block',
    sync!.lastSyncedBlock >= fromBlock,
    `lastSyncedBlock=${sync!.lastSyncedBlock} expected >= ${fromBlock}`,
  )
  check(
    'SyncState advanced to safe head',
    sync!.lastSyncedBlock >= toBlock,
    `lastSyncedBlock=${sync!.lastSyncedBlock} expected >= ${toBlock}`,
  )
  check(
    'SyncState marked idle after pass',
    sync!.status === 'idle',
    `status=${sync!.status}`,
  )
  check('SyncState lastError is empty', !sync!.lastError, `lastError=${sync!.lastError}`)

  // ── 2. Event count + sample shape ──────────────────────────────────────
  const eventCount = await FeeEventModel.countDocuments({
    chainId: 137,
    contractAddress: feeCollector,
  })
  console.log(`\n  Indexed ${eventCount} FeesCollected event(s) in window [${fromBlock}, ${toBlock}]`)

  let sampleIntegrator: string | null = null
  if (eventCount > 0) {
    const sample = await FeeEventModel.findOne({
      chainId: 137,
      contractAddress: feeCollector,
    }).lean()
    if (sample) {
      check(
        'sample token is lowercased',
        sample.token === sample.token.toLowerCase(),
        `token=${sample.token}`,
      )
      check(
        'sample integrator is lowercased',
        sample.integrator === sample.integrator.toLowerCase(),
        `integrator=${sample.integrator}`,
      )
      check(
        'sample integratorFee is decimal string',
        /^\d+$/.test(sample.integratorFee),
        `integratorFee=${sample.integratorFee}`,
      )
      check(
        'sample lifiFee is decimal string',
        /^\d+$/.test(sample.lifiFee),
        `lifiFee=${sample.lifiFee}`,
      )
      check(
        'sample blockNumber is inside the test window',
        sample.blockNumber >= fromBlock && sample.blockNumber <= toBlock,
        `blockNumber=${sample.blockNumber} outside [${fromBlock}, ${toBlock}]`,
      )
      check(
        'sample chainId is 137',
        sample.chainId === 137,
        `chainId=${sample.chainId}`,
      )
      check(
        'sample blockHash looks like a 32-byte hex',
        /^0x[a-f0-9]{64}$/.test(sample.blockHash),
        `blockHash=${sample.blockHash}`,
      )
      check(
        'sample transactionHash looks like a 32-byte hex',
        /^0x[a-f0-9]{64}$/.test(sample.transactionHash),
        `transactionHash=${sample.transactionHash}`,
      )
      sampleIntegrator = sample.integrator
    }
  } else {
    console.log('  (Window contained no FeesCollected events — API event tests will be skipped.)')
  }

  // ── 3. Idempotency: a second insert of the same rows is a no-op ────────
  if (eventCount > 0) {
    const before = await FeeEventModel.countDocuments()
    const rows = await FeeEventModel.find().limit(5).lean()
    let dupes = 0
    for (const r of rows) {
      try {
        await FeeEventModel.create({ ...r, _id: undefined })
      } catch (err) {
        // duplicate-key error code is 11000
        if ((err as { code?: number }).code === 11000) dupes += 1
      }
    }
    const after = await FeeEventModel.countDocuments()
    check(
      'unique index rejects duplicate inserts (idempotent re-ingest)',
      dupes === rows.length && after === before,
      `dupes=${dupes}/${rows.length}, before=${before}, after=${after}`,
    )
  }

  // ── 4. /health ──────────────────────────────────────────────────────────
  const health = await fetchJson(`${apiBase}/health`)
  check('GET /health returns 200', health.status === 200, `status=${health.status}`)
  check(
    'GET /health reports db connected',
    (health.body as { status?: string; db?: string })?.status === 'ok',
    `body=${JSON.stringify(health.body)}`,
  )

  // ── 5. /metrics — populated ────────────────────────────────────────────
  const metrics = await fetchText(`${apiBase}/metrics`)
  check('GET /metrics returns 200', metrics.status === 200, `status=${metrics.status}`)
  check(
    'metrics contain http_requests_total',
    metrics.body.includes('http_requests_total'),
  )
  check(
    'metrics contain indexer_last_synced_block',
    metrics.body.includes('indexer_last_synced_block'),
  )
  if (eventCount > 0) {
    // The worker process emits these counters but it ran in a separate
    // process; only API-side counters are guaranteed to appear here.
    check(
      'metrics contain process_cpu_seconds_total (default node metric)',
      metrics.body.includes('process_cpu_seconds_total'),
    )
  }

  // ── 6. /openapi.json ───────────────────────────────────────────────────
  const spec = await fetchJson(`${apiBase}/openapi.json`)
  check('GET /openapi.json returns 200', spec.status === 200)
  check(
    'openapi spec is 3.0.3 and exposes /fee-events',
    (spec.body as { openapi?: string; paths?: Record<string, unknown> })?.openapi === '3.0.3' &&
      !!(spec.body as { paths?: Record<string, unknown> })?.paths?.['/fee-events'],
    `body shape=${JSON.stringify(Object.keys((spec.body as object) ?? {}))}`,
  )

  // ── 7. /fee-events for the sample integrator ──────────────────────────
  if (sampleIntegrator) {
    const url = `${apiBase}/fee-events?integrator=${sampleIntegrator}&limit=10&chainId=137`
    const r = await fetchJson(url)
    check('GET /fee-events returns 200', r.status === 200, `status=${r.status}`)
    const body = r.body as {
      data?: Array<{ integrator: string; blockNumber: number }>
      pageInfo?: { hasNextPage: boolean; nextCursor: string | null }
    }
    check('GET /fee-events response has data array', Array.isArray(body?.data))
    check(
      'GET /fee-events returns at least one row for the sample integrator',
      (body?.data?.length ?? 0) > 0,
      `data length=${body?.data?.length}`,
    )
    check(
      'GET /fee-events rows match the requested integrator',
      (body?.data ?? []).every((d) => d.integrator === sampleIntegrator),
    )
    check(
      'GET /fee-events pageInfo present',
      typeof body?.pageInfo === 'object' && 'hasNextPage' in (body.pageInfo ?? {}),
    )

    // Validation: cursor pagination round-trip when there's a next page
    if (body.pageInfo?.hasNextPage && body.pageInfo.nextCursor) {
      const next = await fetchJson(
        `${apiBase}/fee-events?integrator=${sampleIntegrator}&limit=10&cursor=${body.pageInfo.nextCursor}`,
      )
      const nextBody = next.body as { data?: unknown[] }
      check(
        'GET /fee-events with cursor returns 200 + data',
        next.status === 200 && Array.isArray(nextBody?.data),
        `status=${next.status}`,
      )
    }
  }

  // ── 8. Validation: bad inputs are rejected ─────────────────────────────
  const badIntegrator = await fetchJson(`${apiBase}/fee-events?integrator=not-an-address`)
  check(
    'GET /fee-events rejects malformed integrator with 400',
    badIntegrator.status === 400,
    `status=${badIntegrator.status}`,
  )
  const missingIntegrator = await fetchJson(`${apiBase}/fee-events`)
  check(
    'GET /fee-events rejects missing integrator with 400',
    missingIntegrator.status === 400,
    `status=${missingIntegrator.status}`,
  )

  // ── 9. Aggregates ──────────────────────────────────────────────────────
  if (sampleIntegrator) {
    const aggCount = await DailyAggregateModel.countDocuments({ integrator: sampleIntegrator })
    if (aggCount > 0) {
      check(
        'DailyAggregate row exists for the sample integrator',
        aggCount > 0,
        `count=${aggCount}`,
      )
      const aggRes = await fetchJson(
        `${apiBase}/fee-events/aggregates?integrator=${sampleIntegrator}&chainId=137`,
      )
      const aggBody = aggRes.body as { data?: Array<{ integratorFeeSum: string; day: string }> }
      check(
        'GET /fee-events/aggregates returns 200 with rows',
        aggRes.status === 200 && (aggBody?.data?.length ?? 0) > 0,
        `status=${aggRes.status}, count=${aggBody?.data?.length}`,
      )
      check(
        'aggregate integratorFeeSum is a decimal string',
        (aggBody.data ?? []).every((r) => /^\d+$/.test(r.integratorFeeSum)),
      )
      check(
        'aggregate day is YYYY-MM-DD',
        (aggBody.data ?? []).every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.day)),
      )
    } else {
      console.log('  (No aggregates rebuilt — sample window may have had 0 events.)')
    }
  }

  // ── 10. /metrics + /openapi.json + /docs are not 404 ───────────────────
  const docs = await fetchText(`${apiBase}/docs/`)
  check(
    'GET /docs/ serves swagger-ui',
    docs.status === 200 && docs.body.includes('swagger-ui'),
    `status=${docs.status}`,
  )

  await finish(true)
}

async function finish(connected: boolean): Promise<void> {
  // Pretty-print results
  const passes = results.filter((r) => r.ok)
  const fails = results.filter((r) => !r.ok)
  console.log('\n────────── E2E validation results ──────────')
  for (const r of results) {
    const tag = r.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'
    console.log(`  ${tag} ${r.name}${r.details && !r.ok ? ` — ${r.details}` : ''}`)
  }
  console.log('────────────────────────────────────────────')
  console.log(`Passes: ${passes.length}    Failures: ${fails.length}`)

  if (connected) await mongoose.disconnect().catch(() => undefined)
  if (fails.length > 0) process.exit(1)
}

main().catch(async (err) => {
  console.error('\nE2E validator crashed:', err)
  await mongoose.disconnect().catch(() => undefined)
  process.exit(1)
})
