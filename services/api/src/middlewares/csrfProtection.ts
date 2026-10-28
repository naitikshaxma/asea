import type { Request, Response, NextFunction } from 'express';
import { AppError } from './errorHandler.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function hasAllowedOrigin(value: string | undefined, allowedOrigin: string): boolean {
  if (!value) return false;
  try {
    return new URL(value).origin === allowedOrigin;
  } catch {
    return false;
  }
}

/** Enforce same-origin checks on unsafe methods, especially cookie sessions. */
export function createCsrfProtection(allowedOrigin: string, cookieName: string) {
  let expectedOrigin: string;
  try {
    expectedOrigin = new URL(allowedOrigin).origin;
  } catch {
    throw new Error('CORS_ORIGIN must be an absolute origin for CSRF protection');
  }

  return (req: Request, _res: Response, next: NextFunction): void => {
    if (SAFE_METHODS.has(req.method)) return next();

    const origin = req.get('origin');
    if (origin) {
      if (hasAllowedOrigin(origin, expectedOrigin)) return next();
      return next(new AppError(403, 'FORBIDDEN', 'Request origin is not allowed'));
    }

    const referer = req.get('referer');
    if (referer) {
      if (hasAllowedOrigin(referer, expectedOrigin)) return next();
      return next(new AppError(403, 'FORBIDDEN', 'Request origin is not allowed'));
    }

    // Native clients without browser credentials may omit Origin/Referer. A
    // browser-cookie request must prove it came from the configured web app.
    if (req.cookies?.[cookieName]) {
      return next(new AppError(403, 'FORBIDDEN', 'Origin is required for cookie-authenticated requests'));
    }
    next();
  };
}
