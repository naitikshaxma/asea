import { createHash } from 'node:crypto';

// Hash chain for AuditEvents about a VerificationRun. Each event stores
//   hash = sha256(prevHash + canonicalJson(event fields))
// where prevHash is the previous event's hash in the same run's chain, or
// GENESIS_HASH for the first event. Pure functions only; persistence lives
// with the callers.

export const GENESIS_HASH = '0'.repeat(64);

/** The AuditEvent fields covered by the hash: everything except prevHash and hash. */
export interface AuditEventFields {
  id: string;
  workspaceId: string | null;
  actorId: string | null;
  eventType: string;
  resourceType: string;
  resourceId: string | null;
  metadata: unknown;
  requestId: string | null;
  timestamp: Date | string;
}

export interface ChainedAuditEvent extends AuditEventFields {
  prevHash: string | null;
  hash: string | null;
}

export type AuditChainVerification =
  | { valid: true; length: number; headHash: string | null }
  | { valid: false; length: number; brokenEventId: string; reason: string };

/**
 * Deterministic JSON: object keys sorted (UTF-16 order), no whitespace,
 * undefined object members dropped. Throws on values JSON cannot represent.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`Cannot canonicalise non-finite number ${value}`);
    return JSON.stringify(value);
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const members = Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${members.join(',')}}`;
  }
  throw new TypeError(`Cannot canonicalise value of type ${typeof value}`);
}

export function computeAuditHash(prevHash: string, event: AuditEventFields): string {
  const payload = canonicalJson({
    id: event.id,
    workspaceId: event.workspaceId,
    actorId: event.actorId,
    eventType: event.eventType,
    resourceType: event.resourceType,
    resourceId: event.resourceId,
    metadata: event.metadata ?? null,
    requestId: event.requestId,
    timestamp: new Date(event.timestamp).toISOString(),
  });
  return createHash('sha256').update(prevHash + payload, 'utf8').digest('hex');
}

/** prevHash and hash for an event appended after `lastHash` (null for the first event). */
export function chainAuditEvent(
  lastHash: string | null,
  event: AuditEventFields
): { prevHash: string; hash: string } {
  const prevHash = lastHash ?? GENESIS_HASH;
  return { prevHash, hash: computeAuditHash(prevHash, event) };
}

/**
 * Verifies a chain given its events in any order: the chain is followed from
 * GENESIS_HASH through prevHash links, and every event's hash is recomputed.
 * Detects edited fields, edited or missing links, deleted events (other than
 * the newest ones) and forks. Removing events from the end of the chain is
 * not detectable without an externally stored head hash.
 */
export function verifyAuditChain(events: ChainedAuditEvent[]): AuditChainVerification {
  const byPrevHash = new Map<string, ChainedAuditEvent>();
  for (const event of events) {
    if (!event.prevHash || !event.hash) {
      return { valid: false, length: 0, brokenEventId: event.id, reason: 'Event is not part of a hash chain' };
    }
    if (byPrevHash.has(event.prevHash)) {
      return { valid: false, length: 0, brokenEventId: event.id, reason: 'Two events share the same prevHash (fork)' };
    }
    byPrevHash.set(event.prevHash, event);
  }

  const reached = new Set<string>();
  let current = GENESIS_HASH;
  for (let next = byPrevHash.get(current); next; next = byPrevHash.get(current)) {
    if (computeAuditHash(next.prevHash!, next) !== next.hash) {
      return {
        valid: false,
        length: reached.size,
        brokenEventId: next.id,
        reason: 'Stored hash does not match the event fields',
      };
    }
    reached.add(next.id);
    current = next.hash!;
  }

  const unreached = events.find((e) => !reached.has(e.id));
  if (unreached) {
    return {
      valid: false,
      length: reached.size,
      brokenEventId: unreached.id,
      reason: 'Event does not link to the chain (a previous event is missing or was altered)',
    };
  }

  return { valid: true, length: reached.size, headHash: reached.size > 0 ? current : null };
}
