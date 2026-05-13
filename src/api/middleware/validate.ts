import type { NextFunction, Request, Response } from 'express'
import { ZodSchema } from 'zod'
import { ValidationError } from '../../app/errors'

/**
 * Validates `req.query` with a Zod schema and replaces it with the parsed
 * output (typed downstream). Throws `ValidationError` on failure so the
 * central error handler renders a consistent 400 response.
 */
export function validateQuery<T>(schema: ZodSchema<T>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.query)
    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
      next(new ValidationError(issues))
      return
    }
    ;(req as Request & { validatedQuery: T }).validatedQuery = result.data
    next()
  }
}
