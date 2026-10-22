import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// GitHub signs each webhook delivery with the webhook's secret:
//   X-Hub-Signature-256: sha256=<hex HMAC-SHA256(secret, raw body)>

export function signPayload(secret: string, body: Buffer | string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/** Constant-time check of an X-Hub-Signature-256 header against the raw body. */
export function verifySignature(secret: string, body: Buffer, header: string | undefined): boolean {
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = Buffer.from(signPayload(secret, body), 'utf8');
  const given = Buffer.from(header, 'utf8');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function generateWebhookSecret(): string {
  return randomBytes(32).toString('hex');
}
