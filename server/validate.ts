import type { Request, Response } from 'express';
import { z } from 'zod';

/**
 * Validate request body against a Zod schema.
 * Returns the parsed data or sends a 400 response and returns null.
 */
export function validateBody<T extends z.ZodTypeAny>(
  req: Request,
  res: Response,
  schema: T,
): z.infer<T> | null {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    const errors = result.error.issues.map(
      (i) => `${i.path.join('.')}: ${i.message}`,
    );
    res.status(400).json({ error: errors.join('; ') });
    return null;
  }
  return result.data;
}

/**
 * Validate request query parameters against a Zod schema.
 * Returns the parsed data or sends a 400 response and returns null.
 */
export function validateQuery<T extends z.ZodTypeAny>(
  req: Request,
  res: Response,
  schema: T,
): z.infer<T> | null {
  const result = schema.safeParse(req.query);
  if (!result.success) {
    const errors = result.error.issues.map(
      (i) => `${i.path.join('.')}: ${i.message}`,
    );
    res.status(400).json({ error: errors.join('; ') });
    return null;
  }
  return result.data;
}

/** Coerce a string to a positive integer or fail. Useful for route params and query strings. */
export const zIntString = z.coerce.number().int().positive();

/** Coerce a string to a non-negative integer or fail. */
export const zIntStringNonNeg = z.coerce.number().int().min(0);
