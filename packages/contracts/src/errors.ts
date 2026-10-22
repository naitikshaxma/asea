import { z } from 'zod';
import { IsoTimestampSchema, RequestIdSchema } from './request.js';

export const ErrorCodeEnum = z.enum([
  'INTERNAL_SERVER_ERROR',
  'BAD_REQUEST',
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'SERVICE_UNAVAILABLE',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'CONFLICT',
  'DEPENDENCY_FAILURE',
  'TIMEOUT',
]);

export type ErrorCode = z.infer<typeof ErrorCodeEnum>;

export const ValidationErrorDetailSchema = z.object({
  field: z.string(),
  message: z.string(),
  code: z.string().optional(),
});

export type ValidationErrorDetail = z.infer<typeof ValidationErrorDetailSchema>;

export const ApiErrorResponseSchema = z.object({
  success: z.literal(false),
  error: z.object({
    code: ErrorCodeEnum,
    message: z.string(),
    details: z.array(ValidationErrorDetailSchema).optional(),
    requestId: RequestIdSchema.optional(),
    timestamp: IsoTimestampSchema,
  }),
});

export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;
