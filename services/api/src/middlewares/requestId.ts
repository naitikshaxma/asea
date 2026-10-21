import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import {
  HEADER_REQUEST_ID,
  HEADER_API_VERSION,
  API_VERSION,
  RequestIdSchema,
} from '@autonomous-engineer/contracts';

declare global {
  namespace Express {
    interface Request {
      id: string;
    }
  }
}

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incomingHeader = req.headers[HEADER_REQUEST_ID];
  let requestId: string;

  if (typeof incomingHeader === 'string') {
    const parseResult = RequestIdSchema.safeParse(incomingHeader);
    requestId = parseResult.success ? parseResult.data : randomUUID();
  } else {
    requestId = randomUUID();
  }

  req.id = requestId;
  res.setHeader(HEADER_REQUEST_ID, requestId);
  res.setHeader(HEADER_API_VERSION, API_VERSION);
  next();
}
