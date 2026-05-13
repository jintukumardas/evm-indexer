# HTTP API

The OpenAPI 3.0.3 spec is served at `/openapi.json` and Swagger UI is mounted
at `/docs`. Every endpoint described below is generated from that spec.

All responses are JSON. Errors share a consistent shape:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "integrator must be a 0x-prefixed address" } }
```

---

## GET /health

Liveness probe. Returns `200` when MongoDB is connected and `503` otherwise.

```json
{ "status": "ok", "db": "connected" }
```

## GET /metrics

Prometheus scrape endpoint. Returns standard Node and process metrics plus
the indexer's custom series (chunk duration and event counts, inserts and
duplicates, reorgs detected, range shrinks, RPC error kinds, sync-pass
outcomes, last synced block, plus HTTP request totals and latency). Every
indexer series carries `chain` and `plugin` labels so multi-plugin or
multi-chain deployments stay separable. The full metric list is in
[Design.md → Metrics](Design.md#metrics).

## GET /fee-events

List `FeesCollected` events for an integrator, newest first, with cursor
pagination.

| Param        | Required | Notes                                                            |
| ------------ | -------- | ---------------------------------------------------------------- |
| `integrator` | Yes      | `0x`-prefixed 40-hex address. Case-insensitive (lowercased server-side). |
| `limit`      | No       | 1–500. Default 50.                                               |
| `cursor`     | No       | Opaque cursor returned by a previous response.                   |
| `chainId`    | No       | Optional chain filter (e.g. `137` for Polygon).                  |

```bash
curl -s 'http://localhost:3000/fee-events?integrator=0x000...dead&limit=2'
```

```json
{
  "data": [
    {
      "chainId": 137,
      "chainKey": "polygon",
      "contractAddress": "0xbd6c7b0d…",
      "blockNumber": 78650123,
      "blockHash": "0x…",
      "transactionHash": "0x…",
      "logIndex": 4,
      "token": "0xc02aaa39…",
      "integrator": "0x000…dead",
      "integratorFee": "1000000000000000000",
      "lifiFee": "500000000000000000",
      "removed": false,
      "eventName": "FeesCollected",
      "processedAt": "2024-01-01T00:00:00.000Z"
    }
  ],
  "pageInfo": {
    "nextCursor": "eyJibG9ja051bWJlciI6Nzg2NTAxMjMsImxvZ0luZGV4Ijo0fQ",
    "hasNextPage": true
  }
}
```

Addresses are returned lowercased. Fee amounts are decimal strings so
uint256 precision survives the JSON boundary. `processedAt` is the moment the
indexer persisted the row, not the on-chain timestamp. Cursors are opaque
base64 — clients should pass them back verbatim rather than parse them.

## GET /fee-events/aggregates

Pre-rolled daily sums per `(chainId, integrator, token, day)`. Rolled up
after every successful sync pass over the days touched by the new block range.

| Param        | Required | Notes                                   |
| ------------ | -------- | --------------------------------------- |
| `integrator` | Yes      | `0x`-prefixed address.                  |
| `token`      | No       | Filter by ERC20 token address.          |
| `chainId`    | No       | Optional chain filter.                  |
| `fromDay`    | No       | ISO date `YYYY-MM-DD`.                  |
| `toDay`      | No       | ISO date `YYYY-MM-DD`.                  |
| `limit`      | No       | 1–1000. Default 365.                    |

```json
{
  "data": [
    {
      "chainId": 137,
      "integrator": "0x…",
      "token": "0x…",
      "day": "2024-04-01",
      "integratorFeeSum": "3000000000000000000",
      "lifiFeeSum": "1500000000000000000",
      "eventCount": 2
    }
  ]
}
```

Days are UTC. Rows touched by reorg reconciliation (`removed=true` in the
event collection) are excluded from the sums.

---

## Rate limiting

Every API instance runs an in-process per-IP token-bucket limiter. Defaults
are **60 burst, 30 tokens/sec sustained** (≈1800 req/min per client). Override
via `API_RATE_LIMIT_BURST` and `API_RATE_LIMIT_REFILL_PER_SEC`; set
`API_RATE_LIMIT_BURST=0` to disable entirely (useful for tests or when a
front-proxy already throttles).

- `/health` and `/metrics` are exempt so probes and Prometheus scrapes keep
  working under load.
- `trust proxy = 1` is set, so `req.ip` honours the first `X-Forwarded-For`
  hop — the limiter sees the real client behind nginx or an ALB.
- `429` responses include a `Retry-After` header in seconds.
- The bucket map is capped (`maxBuckets`, default 10 000) and LRU-evicts so
  process memory stays bounded under a wide-source flood.

For multi-instance deployments where cluster-wide accounting matters, swap
this for a Redis-backed limiter; the middleware surface is intentionally
small so the swap is mechanical.
