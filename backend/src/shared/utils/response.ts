import { Response } from 'express';

/** Sends a generic 500 and logs the error internally — never exposes stack traces. */
export function internalError(res: Response, err?: unknown): void {
  if (err) console.error(err);
  res.status(500).json({ error: 'Internal server error' });
}
