import { describe, it, expect } from 'vitest';
import {
  GENESIS_HASH,
  canonicalJson,
  chainAuditEvent,
  computeAuditHash,
  verifyAuditChain,
  type AuditEventFields,
  type ChainedAuditEvent,
} from '../src/services/auditChain.js';

function event(n: number, overrides: Partial<AuditEventFields> = {}): AuditEventFields {
  return {
    id: `evt-${n}`,
    workspaceId: 'ws-1',
    actorId: null,
    eventType: ['VERIFICATION_STARTED', 'STATIC_ANALYSIS_COMPLETED', 'VERIFICATION_COMPLETED'][n - 1] ?? 'X',
    resourceType: 'VerificationRun',
    resourceId: 'vr-1',
    metadata: { step: n },
    requestId: null,
    timestamp: new Date(Date.UTC(2026, 9, 21, 12, 0, 0, n)),
    ...overrides,
  };
}

function buildChain(count: number): ChainedAuditEvent[] {
  const chain: ChainedAuditEvent[] = [];
  let last: string | null = null;
  for (let n = 1; n <= count; n++) {
    const fields = event(n);
    const link = chainAuditEvent(last, fields);
    chain.push({ ...fields, ...link });
    last = link.hash;
  }
  return chain;
}

describe('canonicalJson', () => {
  it('sorts keys recursively, keeps array order and drops undefined members', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: null }, u: undefined })).toBe(
      '{"a":{"c":null,"d":[3,1]},"b":1}'
    );
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
    expect(canonicalJson(new Date('2026-10-21T12:00:00Z'))).toBe('"2026-10-21T12:00:00.000Z"');
  });

  it('rejects values JSON cannot represent', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(TypeError);
  });
});

describe('audit hash chain', () => {
  it('matches a hash computed independently (Python json.dumps(sort_keys) + sha256)', () => {
    const hash = computeAuditHash(GENESIS_HASH, {
      id: 'evt-1',
      workspaceId: 'ws-1',
      actorId: null,
      eventType: 'VERIFICATION_STARTED',
      resourceType: 'VerificationRun',
      resourceId: 'vr-1',
      metadata: { z: 1, a: [true, 'x'] },
      requestId: null,
      timestamp: '2026-10-21T12:00:00.000Z',
    });
    expect(hash).toBe('fb414f6cafcc9747d5d87c449202c28121c9fb4a236e4057a9a3d8888f60e931');
  });

  it('chains from GENESIS_HASH and verifies a valid chain in any order', () => {
    const chain = buildChain(3);
    expect(chain[0].prevHash).toBe(GENESIS_HASH);
    expect(chain[1].prevHash).toBe(chain[0].hash);

    expect(verifyAuditChain(chain)).toEqual({ valid: true, length: 3, headHash: chain[2].hash });
    expect(verifyAuditChain([chain[2], chain[0], chain[1]])).toEqual({
      valid: true,
      length: 3,
      headHash: chain[2].hash,
    });
    expect(verifyAuditChain([])).toEqual({ valid: true, length: 0, headHash: null });
  });

  it('accepts a timestamp as a Date or an ISO string (DB round trip)', () => {
    const [first] = buildChain(1);
    const roundTripped = { ...first, timestamp: (first.timestamp as Date).toISOString() };
    expect(verifyAuditChain([roundTripped]).valid).toBe(true);
  });

  it('detects a tampered event field', () => {
    const chain = buildChain(3);
    chain[1] = { ...chain[1], metadata: { step: 2, findings: 0 } };

    expect(verifyAuditChain(chain)).toMatchObject({
      valid: false,
      length: 1,
      brokenEventId: 'evt-2',
      reason: 'Stored hash does not match the event fields',
    });
  });

  it('detects a tampered event whose hash was recomputed to match', () => {
    const chain = buildChain(3);
    const forged = { ...chain[1], eventType: 'VERIFICATION_SKIPPED' };
    forged.hash = computeAuditHash(forged.prevHash!, forged);
    chain[1] = forged;

    // evt-2 now verifies on its own, but evt-3 no longer links to it
    expect(verifyAuditChain(chain)).toMatchObject({ valid: false, length: 2, brokenEventId: 'evt-3' });
  });

  it('detects a deleted event in the middle of the chain', () => {
    const chain = buildChain(3);
    expect(verifyAuditChain([chain[0], chain[2]])).toMatchObject({
      valid: false,
      length: 1,
      brokenEventId: 'evt-3',
    });
  });

  it('detects a fork and an unchained event', () => {
    const chain = buildChain(2);
    const fork = { ...event(9), ...chainAuditEvent(chain[0].hash, event(9)) };
    expect(verifyAuditChain([...chain, fork])).toMatchObject({ valid: false, reason: expect.stringMatching(/fork/) });

    const unchained = { ...event(3), prevHash: null, hash: null };
    expect(verifyAuditChain([...chain, unchained])).toMatchObject({ valid: false, brokenEventId: 'evt-3' });
  });
});
