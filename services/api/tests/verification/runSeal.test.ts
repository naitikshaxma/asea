import { describe, it, expect } from 'vitest';
import { chainAuditEvent, verifyAuditChain, type ChainedAuditEvent } from '../../src/services/auditChain.js';
import { verifyRunSeal } from '../../src/services/verification/runSeal.js';

function sealedChain(eventTypes: string[]): ChainedAuditEvent[] {
  const chain: ChainedAuditEvent[] = [];
  let last: string | null = null;
  for (const [i, eventType] of [...eventTypes, 'RUN_SEALED'].entries()) {
    const fields = {
      id: `e${i}`,
      workspaceId: 'ws',
      actorId: null,
      eventType,
      resourceType: 'VerificationRun',
      resourceId: 'vr',
      metadata: eventType === 'RUN_SEALED' ? { status: 'FAILED', auditHeadHash: last, auditEventCount: i } : { i },
      requestId: null,
      timestamp: new Date(Date.UTC(2026, 9, 22, 0, 0, i)),
    };
    const link = chainAuditEvent(last, fields);
    chain.push({ ...fields, ...link });
    last = link.hash;
  }
  return chain;
}

const check = (run: Parameters<typeof verifyRunSeal>[0], events: ChainedAuditEvent[]) =>
  verifyRunSeal(run, events, verifyAuditChain(events));

describe('verifyRunSeal', () => {
  const events = sealedChain(['VERIFICATION_STARTED', 'VERIFICATION_FAILED']);
  const run = { status: 'FAILED', auditHeadHash: events[1]!.hash, auditEventCount: 2 };

  it('accepts a correctly sealed terminal run', () => {
    expect(check(run, events)).toEqual({ required: true, valid: true });
  });

  it.each([1, 2])('detects the last %i event(s) being deleted', (count) => {
    const truncated = events.slice(0, events.length - count);
    expect(verifyAuditChain(truncated).valid).toBe(true); // the remaining chain links correctly
    expect(check(run, truncated)).toMatchObject({ valid: false, reason: expect.stringMatching(/RUN_SEALED event is missing/) });
  });

  it('detects a changed count or head hash on the run', () => {
    expect(check({ ...run, auditEventCount: 3 }, events)).toMatchObject({ valid: false, reason: expect.stringMatching(/event count/) });
    expect(check({ ...run, auditHeadHash: events[0]!.hash }, events)).toMatchObject({
      valid: false,
      reason: expect.stringMatching(/head hash/),
    });
  });

  it('rejects a terminal run that was never sealed', () => {
    expect(check({ ...run, auditHeadHash: null, auditEventCount: null }, events.slice(0, 2))).toMatchObject({
      valid: false,
      reason: expect.stringMatching(/no stored audit head hash/),
    });
  });

  it('rejects a seal on a run that is not terminal', () => {
    expect(check({ ...run, status: 'RUNNING' }, events)).toMatchObject({ required: false, valid: false });
    expect(check({ status: 'RUNNING', auditHeadHash: null, auditEventCount: null }, events.slice(0, 1))).toEqual({
      required: false,
      valid: null,
    });
  });

  it('rejects an event appended after the seal', () => {
    const fields = { ...events[0]!, id: 'late', eventType: 'LATE', metadata: {} };
    const late = { ...fields, ...chainAuditEvent(events[2]!.hash, fields) };
    expect(check(run, [...events, late])).toMatchObject({
      valid: false,
      reason: 'RUN_SEALED is not the newest event in the chain',
    });
  });
});
