import { createHash } from 'node:crypto';
import { Redis } from 'ioredis';
import { config } from '../config.js';
import { logger } from '../logger.js';

export interface RateWindowResult {
  count: number;
  resetAfterMs: number;
}

export interface AuthStateStore {
  createSession(sessionId: string, userId: string, ttlMs: number): Promise<void>;
  getSessionUserId(sessionId: string): Promise<string | null>;
  revokeSession(sessionId: string, userId: string): Promise<boolean>;
  revokeUserSessions(userId: string): Promise<number>;
  consumeOneTimeToken(tokenId: string, ttlMs: number): Promise<boolean>;
  incrementRateLimit(key: string, windowMs: number): Promise<RateWindowResult>;
  close(): Promise<void>;
}

interface RedisAuthClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'PX', ttlMs: number, condition?: 'NX'): Promise<unknown>;
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
  scan(cursor: string, patternToken: 'MATCH', pattern: string, countToken: 'COUNT', count: string): Promise<[string, string[]]>;
  disconnect(): void;
}

const INCREMENT_WINDOW_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return { count, ttl }
`;

const REVOKE_SESSION_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  local deleted = redis.call('DEL', KEYS[1])
  redis.call('SREM', KEYS[2], ARGV[2])
  return deleted
end
return 0
`;

const CREATE_SESSION_SCRIPT = `
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
redis.call('SADD', KEYS[2], KEYS[1])
local ttl = redis.call('PTTL', KEYS[2])
if ttl < tonumber(ARGV[2]) then redis.call('PEXPIRE', KEYS[2], ARGV[2]) end
return 1
`;

const REVOKE_USER_SESSIONS_SCRIPT = `
local keys = redis.call('SMEMBERS', KEYS[1])
local count = 0
for _, sessionKey in ipairs(keys) do count = count + redis.call('DEL', sessionKey) end
redis.call('DEL', KEYS[1])
return count
`;

function opaqueKey(prefix: string, kind: string, identity: string): string {
  const digest = createHash('sha256').update(identity).digest('hex');
  return `${prefix}:${kind}:${digest}`;
}

export function createRedisAuthStateStore(
  getRedis: () => RedisAuthClient,
  prefix = 'asea'
): AuthStateStore {
  return {
    async createSession(sessionId, userId, ttlMs) {
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('Session TTL must be positive');
      await getRedis().eval(
        CREATE_SESSION_SCRIPT,
        2,
        opaqueKey(prefix, 'session', sessionId),
        opaqueKey(prefix, 'user-sessions', userId),
        userId,
        String(Math.ceil(ttlMs))
      );
    },

    async getSessionUserId(sessionId) {
      return getRedis().get(opaqueKey(prefix, 'session', sessionId));
    },

    async revokeSession(sessionId, userId) {
      const result = await getRedis().eval(
        REVOKE_SESSION_SCRIPT,
        2,
        opaqueKey(prefix, 'session', sessionId),
        opaqueKey(prefix, 'user-sessions', userId),
        userId,
        opaqueKey(prefix, 'session', sessionId)
      );
      return Number(result) === 1;
    },

    async revokeUserSessions(userId) {
      const redis = getRedis();
      // The index covers sessions created by this version. Scan this service's
      // opaque session-key namespace as well so sessions issued before the
      // index was introduced are revoked during the rollout.
      let cursor = '0';
      let count = 0;
      do {
        const [nextCursor, keys] = await redis.scan(
          cursor,
          'MATCH',
          `${prefix}:session:*`,
          'COUNT',
          '500'
        );
        cursor = nextCursor;
        for (const sessionKey of keys) {
          const deleted = await redis.eval(
            REVOKE_SESSION_SCRIPT,
            2,
            sessionKey,
            opaqueKey(prefix, 'user-sessions', userId),
            userId,
            sessionKey
          );
          count += Number(deleted) === 1 ? 1 : 0;
        }
      } while (cursor !== '0');
      const result = await getRedis().eval(
        REVOKE_USER_SESSIONS_SCRIPT,
        1,
        opaqueKey(prefix, 'user-sessions', userId)
      );
      return count + Number(result);
    },

    async consumeOneTimeToken(tokenId, ttlMs) {
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('One-time token TTL must be positive');
      const result = await getRedis().set(opaqueKey(prefix, 'nonce', tokenId), '1', 'PX', Math.ceil(ttlMs), 'NX');
      return result === 'OK';
    },

    async incrementRateLimit(key, windowMs) {
      const result = (await getRedis().eval(
        INCREMENT_WINDOW_SCRIPT,
        1,
        opaqueKey(prefix, 'rate', key),
        String(Math.ceil(windowMs))
      )) as [number | string, number | string];

      if (!Array.isArray(result) || result.length < 2) {
        throw new Error('Redis returned an invalid rate-limit result');
      }

      return {
        count: Number(result[0]),
        resetAfterMs: Math.max(0, Number(result[1])),
      };
    },

    async close() {
      // The owner manages connection lifetime. The singleton below disconnects
      // the shared client during API shutdown.
    },
  };
}

export function createMemoryAuthStateStore(now: () => number = Date.now): AuthStateStore {
  const sessions = new Map<string, { userId: string; expiresAt: number }>();
  const rateWindows = new Map<string, { count: number; expiresAt: number }>();
  const consumedTokens = new Map<string, number>();

  return {
    async createSession(sessionId, userId, ttlMs) {
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('Session TTL must be positive');
      sessions.set(sessionId, { userId, expiresAt: now() + ttlMs });
    },

    async getSessionUserId(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return null;
      if (session.expiresAt <= now()) {
        sessions.delete(sessionId);
        return null;
      }
      return session.userId;
    },

    async revokeSession(sessionId, userId) {
      const session = sessions.get(sessionId);
      if (!session || session.userId !== userId) return false;
      sessions.delete(sessionId);
      return true;
    },

    async revokeUserSessions(userId) {
      let count = 0;
      for (const [sessionId, session] of sessions) {
        if (session.userId === userId) {
          sessions.delete(sessionId);
          count += 1;
        }
      }
      return count;
    },

    async consumeOneTimeToken(tokenId, ttlMs) {
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('One-time token TTL must be positive');
      const currentTime = now();
      const consumedUntil = consumedTokens.get(tokenId);
      if (consumedUntil && consumedUntil > currentTime) return false;
      consumedTokens.set(tokenId, currentTime + ttlMs);
      if (consumedTokens.size > 10_000) {
        for (const [candidate, expiresAt] of consumedTokens) if (expiresAt <= currentTime) consumedTokens.delete(candidate);
      }
      return true;
    },

    async incrementRateLimit(key, windowMs) {
      const currentTime = now();
      let bucket = rateWindows.get(key);
      if (!bucket || bucket.expiresAt <= currentTime) {
        if (rateWindows.size >= 10_000) {
          for (const [candidate, value] of rateWindows) {
            if (value.expiresAt <= currentTime) rateWindows.delete(candidate);
          }
          if (rateWindows.size >= 10_000) {
            const oldest = rateWindows.keys().next().value;
            if (oldest) rateWindows.delete(oldest);
          }
        }
        bucket = { count: 0, expiresAt: currentTime + windowMs };
        rateWindows.set(key, bucket);
      }
      bucket.count += 1;
      return { count: bucket.count, resetAfterMs: Math.max(0, bucket.expiresAt - currentTime) };
    },

    async close() {
      sessions.clear();
      rateWindows.clear();
      consumedTokens.clear();
    },
  };
}

let redisClient: Redis | null = null;
let lastRedisErrorLogAt = 0;

function getRedisClient(): Redis {
  if (!redisClient) {
    const options = {
      connectTimeout: 1500,
      maxRetriesPerRequest: 1,
      retryStrategy: (attempt: number) => Math.min(attempt * 200, 1000),
    };
    redisClient = config.REDIS_URL
      ? new Redis(config.REDIS_URL, options)
      : new Redis({ host: config.REDIS_HOST, port: config.REDIS_PORT, ...options });
    redisClient.on('error', () => {
      const now = Date.now();
      if (now - lastRedisErrorLogAt < 30_000) return;
      lastRedisErrorLogAt = now;
      // Do not log connection URLs or error payloads, which may contain secrets.
      logger.warn('Redis authentication state store is unavailable');
    });
  }
  return redisClient;
}

const memoryStore = createMemoryAuthStateStore();
const redisStore = createRedisAuthStateStore(() => getRedisClient(), config.AUTH_STATE_KEY_PREFIX);

/**
 * Redis is the normal shared store. Process-local memory is selected only in
 * test mode or by an explicit development override; production config rejects it.
 */
export const authStateStore: AuthStateStore = config.AUTH_STATE_STORE === 'memory' ? memoryStore : redisStore;

export async function closeAuthStateStore(): Promise<void> {
  if (redisClient) {
    redisClient.disconnect();
    redisClient = null;
  }
  await memoryStore.close();
}
