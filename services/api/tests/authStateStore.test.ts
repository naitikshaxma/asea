import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createMemoryAuthStateStore, createRedisAuthStateStore } from '../src/services/authStateStore.js';

class FakeRedis {
  private readonly values = new Map<string, { value: string; expiresAt: number }>();
  private readonly sets = new Map<string, Set<string>>();
  now = 10_000;

  async get(key: string): Promise<string | null> {
    const record = this.values.get(key);
    if (!record) return null;
    if (record.expiresAt <= this.now) {
      this.values.delete(key);
      return null;
    }
    return record.value;
  }

  async set(key: string, value: string, _mode: 'PX', ttlMs: number, condition?: 'NX'): Promise<'OK' | null> {
    const current = this.values.get(key);
    if (condition === 'NX' && current && current.expiresAt > this.now) return null;
    this.values.set(key, { value, expiresAt: this.now + ttlMs });
    return 'OK';
  }

  keys(): string[] {
    return [...this.values.keys()];
  }

  put(key: string, value: string): void {
    this.values.set(key, { value, expiresAt: this.now + 60_000 });
  }

  async eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown> {
    const keys = args.slice(0, numberOfKeys);
    const values = args.slice(numberOfKeys);
    if (script.includes("redis.call('SADD'")) {
      const [sessionKey, indexKey] = keys;
      const [userId, ttlText] = values;
      const ttl = Number(ttlText);
      this.values.set(sessionKey!, { value: userId!, expiresAt: this.now + ttl });
      const index = this.sets.get(indexKey!) ?? new Set<string>();
      index.add(sessionKey!);
      this.sets.set(indexKey!, index);
      return 1;
    }
    if (script.includes("redis.call('SREM'")) {
      const [sessionKey, indexKey] = keys;
      const [expectedUserId, sessionMember] = values;
      const record = this.values.get(sessionKey!);
      if (!record || record.expiresAt <= this.now || record.value !== expectedUserId) return 0;
      this.values.delete(sessionKey!);
      this.sets.get(indexKey!)?.delete(sessionMember!);
      return 1;
    }
    if (script.includes("redis.call('SMEMBERS'")) {
      const [indexKey] = keys;
      const members = this.sets.get(indexKey!) ?? new Set<string>();
      let count = 0;
      for (const member of members) if (this.values.delete(member)) count += 1;
      this.sets.delete(indexKey!);
      return count;
    }
    if (script.includes("redis.call('GET', KEYS[1])")) {
      const expectedUserId = values[0];
      const record = this.values.get(keys[0]!);
      if (!record || record.expiresAt <= this.now || record.value !== expectedUserId) return 0;
      this.values.delete(keys[0]!);
      return 1;
    }

    const durationMs = Number(values[0]);
    const key = keys[0]!;
    const current = this.values.get(key);
    if (!current || current.expiresAt <= this.now) {
      this.values.set(key, { value: '1', expiresAt: this.now + durationMs });
      return [1, durationMs];
    }

    current.value = String(Number(current.value) + 1);
    return [Number(current.value), current.expiresAt - this.now];
  }

  async scan(_cursor: string, _match: 'MATCH', pattern: string, _count: 'COUNT', _limit: string): Promise<[string, string[]]> {
    const prefix = pattern.replace('*', '');
    return ['0', [...this.values.keys()].filter((key) => key.startsWith(prefix))];
  }

  disconnect(): void {}
}

describe('auth state stores', () => {
  it('shares sessions and rate windows between Redis store instances', async () => {
    const redis = new FakeRedis();
    const first = createRedisAuthStateStore(() => redis, 'test');
    const second = createRedisAuthStateStore(() => redis, 'test');

    await first.createSession('session-secret-id', 'user-1', 2_000);
    expect(await second.getSessionUserId('session-secret-id')).toBe('user-1');
    expect(redis.keys().every((key) => !key.includes('session-secret-id'))).toBe(true);

    expect(await first.incrementRateLimit('login:192.0.2.4', 1_000)).toEqual({ count: 1, resetAfterMs: 1_000 });
    expect(await second.incrementRateLimit('login:192.0.2.4', 1_000)).toEqual({ count: 2, resetAfterMs: 1_000 });
    expect(await first.consumeOneTimeToken('callback-state', 1_000)).toBe(true);
    expect(await second.consumeOneTimeToken('callback-state', 1_000)).toBe(false);

    expect(await second.revokeSession('session-secret-id', 'another-user')).toBe(false);
    expect(await second.getSessionUserId('session-secret-id')).toBe('user-1');
    expect(await second.revokeSession('session-secret-id', 'user-1')).toBe(true);
    expect(await first.getSessionUserId('session-secret-id')).toBeNull();

    await first.createSession('session-a', 'user-1', 2_000);
    await second.createSession('session-b', 'user-1', 2_000);
    await second.createSession('session-c', 'user-2', 2_000);
    const legacySessionKey = `test:session:${createHash('sha256').update('legacy-session').digest('hex')}`;
    redis.put(legacySessionKey, 'user-1');
    expect(await first.revokeUserSessions('user-1')).toBe(3);
    expect(await second.getSessionUserId('session-a')).toBeNull();
    expect(await second.getSessionUserId('session-b')).toBeNull();
    expect(await second.getSessionUserId('session-c')).toBe('user-2');
    expect(await redis.get(legacySessionKey)).toBeNull();

    redis.now += 1_000;
    expect(await first.incrementRateLimit('login:192.0.2.4', 1_000)).toEqual({ count: 1, resetAfterMs: 1_000 });
  });

  it('expires and revokes process-local sessions in test/development mode', async () => {
    let now = 50_000;
    const store = createMemoryAuthStateStore(() => now);
    await store.createSession('session-id', 'user-2', 500);
    expect(await store.getSessionUserId('session-id')).toBe('user-2');
    expect(await store.revokeSession('session-id', 'wrong-user')).toBe(false);
    now += 500;
    expect(await store.getSessionUserId('session-id')).toBeNull();
    await store.createSession('session-2', 'user-2', 500);
    await store.createSession('session-3', 'user-2', 500);
    expect(await store.revokeUserSessions('user-2')).toBe(2);
    expect(await store.getSessionUserId('session-2')).toBeNull();
    expect(await store.consumeOneTimeToken('state-1', 100)).toBe(true);
    expect(await store.consumeOneTimeToken('state-1', 100)).toBe(false);
  });
});
