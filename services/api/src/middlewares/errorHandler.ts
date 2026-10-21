import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import type { ApiErrorResponse, ErrorCode, ValidationErrorDetail } from '@autonomous-engineer/contracts';
import { logger } from '../logger.js';

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: ErrorCode;
  public readonly details?: ValidationErrorDetail[];

  constructor(statusCode: number, code: ErrorCode, message: string, details?: ValidationErrorDetail[]) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function notFoundHandler(req: Request, res: Response, _next: NextFunction): void {
  const errorResponse: ApiErrorResponse = {
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: `Resource not found: ${req.method} ${req.originalUrl || req.url}`,
      requestId: req.id,
      timestamp: new Date().toISOString(),
    },
  };

  res.status(404).json(errorResponse);
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const timestamp = new Date().toISOString();
  const requestId = req.id;

  // Handle Zod validation errors
  if (err instanceof ZodError) {
    const details: ValidationErrorDetail[] = err.issues.map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message,
      code: issue.code,
    }));

    const response: ApiErrorResponse = {
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request payload validation failed',
        details,
        requestId,
        timestamp,
      },
    };

    logger.warn('Validation error', { requestId, url: req.url, details });
    res.status(400).json(response);
    return;
  }

  // Handle custom AppErrors
  if (err instanceof AppError) {
    const response: ApiErrorResponse = {
      success: false,
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
        requestId,
        timestamp,
      },
    };

    logger.warn(`AppError: ${err.message}`, {
      requestId,
      statusCode: err.statusCode,
      code: err.code,
    });

    res.status(err.statusCode).json(response);
    return;
  }

  // Handle syntax error (e.g. malformed JSON in request body)
  if (err instanceof SyntaxError && 'status' in err && (err as { status: number }).status === 400) {
    const response: ApiErrorResponse = {
      success: false,
      error: {
        code: 'BAD_REQUEST',
        message: 'Malformed JSON payload',
        requestId,
        timestamp,
      },
    };

    res.status(400).json(response);
    return;
  }

  // Fallback to internal server error
  const message = err instanceof Error ? err.message : 'An unexpected error occurred';
  const stack = err instanceof Error ? err.stack : undefined;

  logger.error('Unhandled internal server error', {
    requestId,
    url: req.url,
    method: req.method,
    errorMessage: message,
    stack,
  });

  const response: ApiErrorResponse = {
    success: false,
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: process.env['NODE_ENV'] === 'production' ? 'Internal server error' : message,
      requestId,
      timestamp,
    },
  };

  res.status(500).json(response);
}
