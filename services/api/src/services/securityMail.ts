import { randomBytes } from 'node:crypto';
import { config } from '../config.js';

export interface DevelopmentMail {
  id: string;
  to: string;
  subject: string;
  text: string;
  createdAt: string;
}

const messages: DevelopmentMail[] = [];

/** A deliberately process-local development sink; this is not email delivery. */
export function queueDevelopmentMail(input: Omit<DevelopmentMail, 'id' | 'createdAt'>): boolean {
  if (config.NODE_ENV === 'production' || !config.DEV_MAILBOX_TOKEN) return false;
  messages.push({ ...input, id: randomBytes(12).toString('hex'), createdAt: new Date().toISOString() });
  if (messages.length > 100) messages.splice(0, messages.length - 100);
  return true;
}

export function readDevelopmentMailbox(): DevelopmentMail[] {
  return messages.map((message) => ({ ...message }));
}

export function clearDevelopmentMailbox(): void {
  messages.length = 0;
}
