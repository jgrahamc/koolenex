import type { Request } from 'express';
import { z } from 'zod';

/**
 * Custom error for validation failures. The Express error middleware
 * checks for this and returns a 400 with the structured error list.
 */
export class ValidationError extends Error {
  status = 400;
  errors: string[];
  constructor(errors: string[]) {
    super(errors.join('; '));
    this.errors = errors;
  }
}

/**
 * Validate request body against a Zod schema.
 * Throws ValidationError on failure (caught by Express error middleware).
 */
export function validateBody<T extends z.ZodTypeAny>(
  req: Request,
  schema: T,
): z.infer<T> {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    const errors = result.error.issues.map(
      (i) => `${i.path.join('.')}: ${i.message}`,
    );
    throw new ValidationError(errors);
  }
  return result.data;
}

/**
 * Validate request query parameters against a Zod schema.
 * Throws ValidationError on failure (caught by Express error middleware).
 */
export function validateQuery<T extends z.ZodTypeAny>(
  req: Request,
  schema: T,
): z.infer<T> {
  const result = schema.safeParse(req.query);
  if (!result.success) {
    const errors = result.error.issues.map(
      (i) => `${i.path.join('.')}: ${i.message}`,
    );
    throw new ValidationError(errors);
  }
  return result.data;
}

/** Coerce a string to a positive integer or fail. Useful for route params and query strings. */
export const zIntString = z.coerce.number().int().positive();

/** Coerce a string to a non-negative integer or fail. */
export const zIntStringNonNeg = z.coerce.number().int().min(0);

/** Extract a numeric route parameter by name. */
/**
 * A numeric route parameter, or a 400.
 *
 * Digits only. `Number()` alone accepted anything it could parse - '-1',
 * '1.5', '1e3', and ' ' (which is 0) - so a malformed id either matched no
 * row or, worse, silently addressed a different one ('1e3' is 1000, ' ' is
 * project 0). It also threw a plain Error, which the app's error middleware
 * reports as a 500: a client could not tell a bad request from a broken
 * server.
 *
 * routes/index.ts used to declare eight identical `router.param` validators
 * (id, pid, did, gid, sid, tid, coid, spaceId) with exactly this rule, but
 * they never ran - Express scopes param callbacks to the router that
 * declares them, and every route with an id lives in a mounted sub-router.
 * Nothing asserted them, so nothing noticed. Validating here covers every
 * parameter, declared or not. See tests/param-validation.test.ts.
 */
export function paramId(req: Request, name: string): number {
  const raw = req.params[name];
  if (typeof raw !== 'string' || !/^\d+$/.test(raw))
    throw new ValidationError([`Invalid ID: ${name}`]);
  return Number(raw);
}
