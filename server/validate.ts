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
export function paramId(req: Request, name: string): number {
  const val = Number(req.params[name]);
  if (!Number.isFinite(val)) throw new Error(`Invalid param: ${name}`);
  return val;
}
