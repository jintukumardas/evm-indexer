import { Router } from 'express'
import swaggerUi from 'swagger-ui-express'
import { openApiSpec } from '../openapi'

/**
 * Serves the OpenAPI spec at `/openapi.json` and the Swagger UI at `/docs`.
 *
 * Both endpoints are static-ish: the spec is a TS object, so the only cost on
 * each request is the JSON serialization (negligible). We don't ship a yaml
 * dependency.
 */
export function openApiRouter(): Router {
  const router = Router()
  router.get('/openapi.json', (_req, res) => res.json(openApiSpec))
  // `swaggerUi.serve` is an array of middlewares; mount under /docs.
  router.use(
    '/docs',
    swaggerUi.serve,
    swaggerUi.setup(openApiSpec, { customSiteTitle: 'LI.FI Indexer API' }),
  )
  return router
}
