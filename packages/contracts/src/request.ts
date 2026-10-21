import { z } from 'zod';

export const RequestIdSchema = z
  .string()
  .min(1, 'Request ID cannot be empty')
  .max(128, 'Request ID is too long')
  .regex(/^[a-zA-Z0-9_-]+$/, 'Request ID contains invalid characters');

export type RequestId = z.infer<typeof RequestIdSchema>;

export const IsoTimestampSchema = z
  .string()
  .datetime({ message: 'Must be a valid ISO 8601 timestamp' });

export type IsoTimestamp = z.infer<typeof IsoTimestampSchema>;

export const API_VERSION = 'v1' as const;
export const HEADER_REQUEST_ID = 'x-request-id' as const;
export const HEADER_API_VERSION = 'x-api-version' as const;
