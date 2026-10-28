import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { config } from '../config.js';
import { readDevelopmentMailbox } from '../services/securityMail.js';

function tokenMatches(candidate: string | undefined, expected: string | undefined): boolean {
  if (!candidate || !expected) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export const devMailboxRouter = Router();

devMailboxRouter.get('/mailbox', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const authorization = req.header('authorization');
  const candidate = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
  if (config.NODE_ENV === 'production' || !tokenMatches(candidate, config.DEV_MAILBOX_TOKEN)) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } });
  }
  return res.status(200).json({ delivery: 'development-memory-mailbox', messages: readDevelopmentMailbox() });
});
