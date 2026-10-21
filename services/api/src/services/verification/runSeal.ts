import type { AuditChainVerification, ChainedAuditEvent } from '../auditChain.js';

// When a VerificationRun reaches a terminal state it is sealed: the run stores
// the audit chain's head hash and event count at that moment, and a final
// RUN_SEALED event records the same two values. The chain alone cannot show
// that its newest events were removed; comparing it with the stored seal can.

export const RUN_SEALED = 'RUN_SEALED';
export const TERMINAL_VERIFICATION_STATUSES: ReadonlySet<string> = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

export interface SealableRun {
  status: string;
  auditHeadHash: string | null;
  auditEventCount: number | null;
}

export interface SealVerification {
  required: boolean;
  /** null: not sealed and not required to be (the run is still in progress) */
  valid: boolean | null;
  reason?: string;
}

/** Pure check of a run's seal against its audit events and their chain verification. */
export function verifyRunSeal(
  run: SealableRun,
  events: ChainedAuditEvent[],
  chain: AuditChainVerification
): SealVerification {
  const required = TERMINAL_VERIFICATION_STATUSES.has(run.status);
  const seals = events.filter((e) => e.eventType === RUN_SEALED);
  const invalid = (reason: string): SealVerification => ({ required, valid: false, reason });

  if (!required) {
    if (seals.length > 0 || run.auditHeadHash !== null || run.auditEventCount !== null) {
      return invalid(`Run is ${run.status} but has a seal`);
    }
    return { required, valid: null };
  }
  if (run.auditHeadHash === null || run.auditEventCount === null) {
    return invalid('Terminal run has no stored audit head hash and event count');
  }
  if (!chain.valid) {
    return invalid('Audit chain is broken');
  }
  if (seals.length === 0) {
    return invalid('RUN_SEALED event is missing (the newest events were removed)');
  }
  if (seals.length > 1) {
    return invalid('More than one RUN_SEALED event');
  }

  const seal = seals[0]!;
  const recorded = (seal.metadata ?? {}) as { auditHeadHash?: unknown; auditEventCount?: unknown };
  if (chain.headHash !== seal.hash) {
    return invalid('RUN_SEALED is not the newest event in the chain');
  }
  if (seal.prevHash !== run.auditHeadHash || recorded.auditHeadHash !== run.auditHeadHash) {
    return invalid('Stored audit head hash does not match the sealed chain');
  }
  if (chain.length !== run.auditEventCount + 1 || recorded.auditEventCount !== run.auditEventCount) {
    return invalid('Stored audit event count does not match the sealed chain');
  }
  return { required, valid: true };
}
