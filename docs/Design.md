# Design

This document explains how the indexer is put together: the engine's contract
with plugins, the per-pass pipeline, and how each operational property
(checkpointing, idempotency, reorg reconciliation, retry strategy, graceful
shutdown, observability, multi-chain) is achieved.

---

## Plugin model

The engine never knows about specific contracts. A single interface,
`ContractEventPlugin`, defines what the runner is allowed to call on a plugin:
build a log filter, parse a raw log into the plugin's normalized shape,
compute a stable identity for a row, persist a chunk idempotently, find or
mark rows by identity inside a block range, and (optionally) run a post-sync
hook or register HTTP routes. Everything else — ABI, parser, Mongo model,
routes — lives behind that interface.

That separation buys two things:

- **Adding a new contract or event is a self-contained module plus one
  registration line.** The sync loop, the reorg runner, and the API don't
  change.
- **Two plugins on the same contract** (say `FeesCollected` and
  `FeesWithdrawn`) carry independent checkpoints and metrics labels — they
  sync at their own pace, and one stuck plugin doesn't block the others.

### Adding a plugin

1. Scaffold a folder under `src/plugins/<name>/` with the plugin class, a
   Mongo model + repository, an optional Express router, and a public
   `index.ts` re-export.
2. Define a factory that takes the chain config + shared deps and returns one
   or more `ContractEventPlugin` instances.
3. Register the factory inside the per-chain loop in the engine's bootstrap.
4. Surface any per-chain env vars on the config schema.

Plugin tests should focus on the parser and persistence shape — the runner
is already proven to call your plugin's methods in the right order by the
engine's own architecture test, so you don't need to re-prove that.

Adding a second event to an existing contract is the same pattern: the
factory returns a list, so you append another plugin instance. Each gets its
own `SyncState` row (keyed on `(chainKey, contractAddress, eventName)`) and
its own metric labels.

---

## Indexing pipeline

For each registered plugin, one pass executes:

1. **Resolve safe head.** `safeLatest = latestBlock - confirmations`. The
   indexer never reads above this — confirmation depth is the first defence
   against reorgs.
2. **Reorg reconciliation** *(if `reorgWindow > 0`)*. Re-fetch the recent
   window from RPC and diff against persisted rows; mark missing rows
   `removed=true`, upsert replacement transactions that appear in the
   re-fetched set but aren't yet in the DB.
3. **Load checkpoint** → compute `fromBlock = max(lastSyncedBlock + 1, startBlock)`.
4. **Adaptive chunked scan.** The scanner is a generator that yields one
   chunk at a time. Range-limit-shaped errors halve the chunk and retry;
   other transient errors flow into the retry layer with exponential backoff.
5. **Parse and bulk upsert** with `ordered:false`. Duplicates are dropped via
   the unique index and surfaced as a `duplicateCount`, not a failure.
6. **Advance the checkpoint** — only after a successful chunk write, via
   `$max` so out-of-order or duplicate jobs can't rewind it.
7. **Post-sync hook.** Token enrichment for unresolved ERC20 addresses and
   the aggregate rebuild, scoped to the union of the just-synced ranges.

If the process crashes mid-pass, the last persisted chunk is the high-water
mark; the next run resumes from the next block. Re-running the same chunk is
safe because of the unique index. `SIGINT`/`SIGTERM` aborts at the next chunk
boundary.

---

## Checkpointing and resume semantics

The `SyncState` collection holds one document per
`(chainKey, contractAddress, eventName)` — multiple plugins on the same
contract get independent rows.

- The checkpoint is initialised to `startBlock - 1` so the first pass starts
  exactly at `startBlock`.
- It only advances after a chunk's events are persisted.
- The advance uses `$max`, so out-of-order or duplicate jobs can't rewind it.
- Bumping `START_BLOCK` forward in env still works — the next pass starts at
  the new block even if the cursor is behind it.
- A unique index on `(chainKey, contractAddress, eventName)` prevents
  duplicate cursors.

---

## Idempotency and deduplication

Every persisted event has a unique compound index on:

```
(chainId, contractAddress, blockNumber, transactionHash, logIndex)
```

This is the canonical EVM log identity. Re-running the same chunk inserts
zero new rows. Re-running an entire backfill from block 0 is a no-op (modulo
write cost). Duplicate-key errors during bulk insert are caught and surfaced
as `duplicateCount`.

---

## Reorg reconciliation

Two complementary defences:

1. **Confirmation depth.** The indexer never reads above
   `latestBlock - confirmations`. Polygon's default of 12 gives generous
   margin over the typical 5–6 block reorg depth.
2. **Window-bounded reconciliation** *(opt-in via `<CHAIN>_REORG_WINDOW`)*.
   Before each forward pass, the reorg runner re-fetches the recent window,
   diffs against persisted rows, marks missing ones `removed=true`, and
   upserts replacement transactions. Cost is `O(reorgWindow)`, not
   `O(history)`. `removed=true` rows are excluded from `daily_aggregates`.

The diff itself is a pure function and is covered by unit tests; the
end-to-end flow (including reorg-of-reorg restore) is covered by an
integration test.

---

## Retry and provider failover

RPC calls are wrapped in a retry helper that:

- retries on transient errors (5xx, 429, ETIMEDOUT/ECONNRESET/ECONNREFUSED,
  socket hang up, rate limit, gateway timeout)
- does **not** retry range-limit errors (those flow into the scanner's
  adaptive shrink loop instead)
- uses exponential backoff with full jitter, capped at `RPC_RETRY_MAX_DELAY_MS`
- aborts immediately when the `AbortSignal` fires
- emits structured warnings tagged with the call label so flaking endpoints
  are visible in logs

A subtle bit worth calling out: Infura and Alchemy reuse JSON-RPC code
`-32005` for *both* throughput rate limits *and* block-range / payload-size
caps. The classifier matches on response *phrasing* (e.g. "block range",
"too many results"), not just the code, so a plain throughput throttle flows
into the retry-with-backoff layer rather than uselessly halving the block
window.

When a chain has multiple comma-separated RPC URLs, the provider factory
returns an ethers `FallbackProvider` (priority by order; single quorum).
A single URL falls back to `StaticJsonRpcProvider`.

---

## Graceful shutdown

`SIGINT` and `SIGTERM` flip an `AbortController`. The scanner generator
checks the signal at chunk boundaries — when set, it returns cleanly without
throwing. The current chunk's events (already fetched) are still persisted,
the checkpoint advances, and only then does the worker exit. The retry helper
and the inter-pass sleep both honour the same signal.

Idempotent restart means worst-case data loss is a single in-flight chunk's
events being re-fetched on next start — never duplicated, never lost.

---

## Metrics

Every indexer series carries both `chain` and `plugin` labels so multiple
plugins on the same chain (or one plugin across chains) sit in distinct
series.

| Metric                                | Type      | Labels                       | Meaning                                       |
| ------------------------------------- | --------- | ---------------------------- | --------------------------------------------- |
| `indexer_chunk_duration_seconds`      | Histogram | `chain`, `plugin`, `outcome` | Wall-clock per chunk                          |
| `indexer_chunk_events`                | Histogram | `chain`, `plugin`            | Events found per chunk                        |
| `indexer_events_inserted_total`       | Counter   | `chain`, `plugin`            | New rows written                              |
| `indexer_events_duplicates_total`     | Counter   | `chain`, `plugin`            | Duplicate-key skips                           |
| `indexer_reorgs_detected_total`       | Counter   | `chain`, `plugin`            | Rows marked removed by reconciliation         |
| `indexer_range_shrinks_total`         | Counter   | `chain`, `plugin`            | Adaptive chunk-shrink events                  |
| `indexer_rpc_errors_total`            | Counter   | `chain`, `plugin`, `kind`    | `range \| timeout \| rate_limit \| network`   |
| `indexer_sync_passes_total`           | Counter   | `chain`, `plugin`, `outcome` | `ok \| noop \| error \| aborted`              |
| `indexer_last_synced_block`           | Gauge     | `chain`, `plugin`            | Highest block persisted                       |
| `http_requests_total`                 | Counter   | `method`, `route`, `status`  | API requests                                  |
| `http_request_duration_seconds`       | Histogram | `method`, `route`, `status`  | API latency                                   |

Plus the standard `process_*` / `nodejs_*` metrics from `prom-client`.

---

## Token enrichment and daily aggregates

### Token enrichment

After each sync pass (when enabled), the indexer pulls the set of distinct
token addresses seen in events, filters to ones not yet resolved, and calls
`symbol()` / `decimals()` / `name()` on each via the same retry layer.
Native-coin sentinel (`0x000…000`) is short-circuited to per-chain metadata
(`MATIC` for Polygon, `ETH` for Ethereum/Arbitrum). Errors are recorded on
the token row and don't abort the pass.

### Daily aggregates

After each successful pass (when enabled), the indexer rebuilds aggregates
for every UTC day the new block range touched:

1. Find the distinct days for non-removed events in the new range.
2. Re-aggregate **all** non-removed events whose day is in that set —
   regardless of block — bucketing by `(chainId, integrator, token, day)`.
3. Sum `integratorFee` + `lifiFee` (converted to `Decimal128` inside the
   `$sum`, then stringified again for storage — no precision loss).
4. `$merge` into `daily_aggregates` with `whenMatched: replace`.

The two-step shape (find days first, then recompute the whole day) is
deliberate. The naive single-pass design — match only the new block range
and `replace` — corrupts sums when the same `(integrator, token, day)` is
touched by two passes: pass 2's slice would overwrite pass 1's contribution.
By scoping the rebuild to *whole days*, replace stays safe.

The unique key `(chainId, integrator, token, day)` keeps rebuilds idempotent.

---

## Multi-chain support

The chain registry is config-driven. To enable a new chain:

1. Set its `<PREFIX>_RPC_URL(S)`, `<PREFIX>_FEE_COLLECTOR_ADDRESS`, and
   `<PREFIX>_START_BLOCK` in env. Other settings have sensible defaults.
2. Restart the worker — it picks up the new chain on the next pass.

Polygon, Ethereum, and Arbitrum are pre-wired. Adding a fourth chain is a
descriptor entry in the config loader (`{ key, chainId, prefix, required }`)
plus the matching env block in the schema. No business-logic branching.

---

## Tech stack and choices

| Concern              | Choice                                                | Why                                                                                            |
| -------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Language             | TypeScript (strict) on Node 20                        | Required by spec; strict mode catches the easy mistakes.                                       |
| Blockchain client    | ethers v5                                             | Required by spec. `FallbackProvider` is used when multiple RPC URLs are configured.            |
| ABI source           | Local minimal ABI                                     | Avoids a dependency on `lifi-contract-types` — only `FeesCollected` is needed and the signature is stable. |
| DB                   | MongoDB via mongoose + Typegoose                      | Required. Typegoose keeps schema + TS types in one place.                                      |
| Validation           | zod                                                   | One schema for env, one per query string; clean error messages.                                |
| API                  | Express                                               | Tiny surface, plays well with `supertest`. No framework magic.                                 |
| Docs                 | swagger-ui-express + inline OpenAPI 3 spec            | `/docs` UI + `/openapi.json` raw spec; no YAML dependency.                                     |
| Metrics              | prom-client                                           | Default Node metrics + custom indexer metrics.                                                 |
| Logging              | pino (+ pino-pretty in dev)                           | Structured JSON in prod, readable in dev.                                                      |
| Tests                | Jest + ts-jest + mongodb-memory-server + supertest    | Industry standard; integration tests use an in-process Mongo.                                  |

---

## Assumptions and tradeoffs

- **One plugin per (chain, contract, event).** The registry rejects
  duplicate plugin keys and the `SyncState` unique index is on the same
  triple, so two plugins on the same contract emit into independent
  checkpoints.
- **Addresses lowercased on write.** Simplifies queryability and matches how
  most indexers expose the data. Checksum form can be recovered with
  `ethers.utils.getAddress(...)` at read time.
- **Fee values stored as strings.** Preserves uint256 precision; the
  aggregate pipeline converts to `Decimal128` only inside the `$sum`, then
  stringifies again on write — no precision loss.
- **One process per role.** API and worker share an image but ship as
  independent processes so they scale independently — the worker is
  write-heavy; the API is read-only and scales horizontally.
- **No persistent job queue.** The worker is a simple loop. For fan-out
  across many chains, run multiple workers each pinned to a subset via a
  chain-key filter.
