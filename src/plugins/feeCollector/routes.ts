import { Request, Router, type Express } from 'express'
import { z } from 'zod'
import { validateQuery } from '../../api/middleware/validate'
import { AggregateService } from '../../services/aggregates/aggregateService'
import { FeeEventsService } from '../../services/fee-events/feeEventsService'

const listQuerySchema = z.object({
  integrator: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'integrator must be a 0x-prefixed address'),
  limit: z.coerce.number().int().positive().max(500).optional(),
  cursor: z.string().optional(),
  chainId: z.coerce.number().int().positive().optional(),
})

const aggregatesQuerySchema = z.object({
  integrator: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  token: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .optional(),
  chainId: z.coerce.number().int().positive().optional(),
  fromDay: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'fromDay must be YYYY-MM-DD')
    .optional(),
  toDay: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'toDay must be YYYY-MM-DD')
    .optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
})

type ListQuery = z.infer<typeof listQuerySchema>
type AggregatesQuery = z.infer<typeof aggregatesQuerySchema>

export interface FeeCollectorRouteDeps {
  feeEventsService: FeeEventsService
  aggregateService: AggregateService
}

/**
 * Builds a router with the two FeeCollector-owned endpoints. Exposed as a
 * plain `Router` (for tests) and as `mountFeeCollectorRoutes(app, deps)` so a
 * plugin's `registerRoutes(app)` is a one-liner.
 */
export function feeCollectorRouter(deps: FeeCollectorRouteDeps): Router {
  const router = Router()

  /**
   * GET /fee-events?integrator=0x...&limit=...&cursor=...&chainId=...
   * Response: `{ data: FeeEvent[], pageInfo: { nextCursor, hasNextPage } }`
   */
  router.get(
    '/fee-events',
    validateQuery(listQuerySchema),
    async (req: Request, res, next): Promise<void> => {
      try {
        const q = (req as Request & { validatedQuery: ListQuery }).validatedQuery
        const result = await deps.feeEventsService.listByIntegrator({
          integrator: q.integrator,
          limit: q.limit,
          cursor: q.cursor,
          chainId: q.chainId,
        })
        res.json({
          data: result.items,
          pageInfo: { nextCursor: result.nextCursor, hasNextPage: result.hasNextPage },
        })
      } catch (err) {
        next(err)
      }
    },
  )

  /**
   * GET /fee-events/aggregates — pre-rolled daily sums per integrator+token+day.
   * Response: `{ data: DailyAggregate[] }`.
   */
  router.get(
    '/fee-events/aggregates',
    validateQuery(aggregatesQuerySchema),
    async (req: Request, res, next): Promise<void> => {
      try {
        const q = (req as Request & { validatedQuery: AggregatesQuery }).validatedQuery
        const items = await deps.aggregateService.list(q)
        res.json({ data: items })
      } catch (err) {
        next(err)
      }
    },
  )

  return router
}

export function mountFeeCollectorRoutes(app: Express, deps: FeeCollectorRouteDeps): void {
  app.use(feeCollectorRouter(deps))
}
