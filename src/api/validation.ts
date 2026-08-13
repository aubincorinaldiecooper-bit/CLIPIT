import type { z } from 'zod';
import { HttpError } from '../lib/errors.js';

/** Parses request input with zod, converting failures into 400s. */
export function parse<T extends z.ZodTypeAny>(schema: T, value: unknown, label = 'request body'): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw HttpError.badRequest(
      `Invalid ${label}`,
      result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }
  return result.data;
}
