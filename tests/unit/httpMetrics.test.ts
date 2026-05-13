/**
 * Regression test for the `route` label cardinality bug in
 * httpMetricsMiddleware.
 *
 * Pre-fix, requests that never matched an Express route — 429s from the
 * rate limiter, errors short-circuited before routing, or Swagger sub-paths
 * — fell back to the raw `req.path` as the `route` label. Under a
 * wide-source flood (`GET /aaa`, `GET /aab`, …) prom-client would mint
 * unbounded label values and grow the process unbounded.
 *
 * Post-fix, any request without `req.route` reports `route='unmatched'`.
 */
import { httpMetricsMiddleware } from '../../src/api/middleware/metrics'
import { getMetrics, resetMetricsForTests } from '../../src/app/metrics'

function fakeReqRes(opts: {
  method: string
  path: string
  route?: string
  status: number
}): {
  req: unknown
  res: { statusCode: number; on: (ev: string, fn: () => void) => void; emit: () => void }
} {
  const finishHandlers: Array<() => void> = []
  const req = {
    method: opts.method,
    path: opts.path,
    ...(opts.route ? { route: { path: opts.route } } : {}),
  }
  const res = {
    statusCode: opts.status,
    on: (ev: string, fn: () => void): void => {
      if (ev === 'finish') finishHandlers.push(fn)
    },
    emit: (): void => {
      for (const fn of finishHandlers) fn()
    },
  }
  return { req, res }
}

beforeEach(() => {
  resetMetricsForTests()
})

describe('httpMetricsMiddleware — route label cardinality', () => {
  it('uses the matched route pattern when Express resolved one', async () => {
    const mw = httpMetricsMiddleware()
    const { req, res } = fakeReqRes({
      method: 'GET',
      path: '/fee-events',
      route: '/fee-events',
      status: 200,
    })
    mw(req as never, res as never, () => undefined)
    res.emit()

    const text = await getMetrics().registry.metrics()
    expect(text).toMatch(/http_requests_total\{[^}]*route="\/fee-events"[^}]*\} 1/)
  })

  it('labels unmatched requests as `unmatched`, regardless of status code', async () => {
    const mw = httpMetricsMiddleware()

    // A 429 emitted by the rate limiter before routing — no req.route.
    const a = fakeReqRes({ method: 'GET', path: '/some/random/path', status: 429 })
    mw(a.req as never, a.res as never, () => undefined)
    a.res.emit()

    // A 405 on a wide-source attack path — no req.route.
    const b = fakeReqRes({ method: 'GET', path: '/aaaaaaaa', status: 405 })
    mw(b.req as never, b.res as never, () => undefined)
    b.res.emit()

    // A 404 — same fallback expected.
    const c = fakeReqRes({ method: 'GET', path: '/nope', status: 404 })
    mw(c.req as never, c.res as never, () => undefined)
    c.res.emit()

    const text = await getMetrics().registry.metrics()
    // The three requests have different statuses (429, 405, 404), so they
    // land on three distinct series — all sharing route="unmatched".
    const lines = text
      .split('\n')
      .filter((l) => l.startsWith('http_requests_total{') && l.includes('route="unmatched"'))
    expect(lines).toHaveLength(3)
    for (const status of ['429', '405', '404']) {
      expect(lines.some((l) => l.includes(`status="${status}"`) && l.endsWith(' 1'))).toBe(true)
    }
    // And under no circumstances should the raw path become a label value.
    expect(text).not.toContain('route="/some/random/path"')
    expect(text).not.toContain('route="/aaaaaaaa"')
    expect(text).not.toContain('route="/nope"')
  })
})
