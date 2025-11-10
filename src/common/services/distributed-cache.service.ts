import { Injectable, Logger } from '@nestjs/common';

type MaybeRedisClient = any;

@Injectable()
export class DistributedCacheService {
  private readonly logger = new Logger(DistributedCacheService.name);
  private redisClient: MaybeRedisClient | null = null;
  private inMemory = new Map<string, { value: any; expiresAt?: number }>();

  // tag -> set of keys (in-memory fallback)
  private tagIndex = new Map<string, Set<string>>();

  constructor() {
    // Attempt to lazily require a redis client if available in node_modules.
    try {
      // Prefer ioredis if present
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const IORedis = require('ioredis');
      const host = process.env.REDIS_HOST || '127.0.0.1';
      const port = process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT, 10) : 6379;
      this.redisClient = new IORedis({ host, port });
      this.logger.log('DistributedCacheService: connected to Redis via ioredis');
    } catch (err) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const redis = require('@redis/client');
        const url = process.env.REDIS_URL;
        const client = redis.createClient({ url });
        // connect is async; call but don't await here
        client.connect().catch((e: any) => this.logger.warn('Redis client connect failed: ' + e?.message));
        this.redisClient = client;
        this.logger.log('DistributedCacheService: connected to Redis via @redis/client');
      } catch (e) {
        this.logger.log('DistributedCacheService: Redis client not found, using in-memory cache fallback');
        this.redisClient = null;
      }
    }
  }

  private isRedisReady(): boolean {
    return !!this.redisClient;
  }

  async set(key: string, value: any, ttlSeconds?: number, tags?: string[]) {
    if (this.isRedisReady()) {
      try {
        // use redis SET with EX if available
        if (ttlSeconds) {
          // some clients expose .set with options
          if (typeof this.redisClient.set === 'function') {
            await this.redisClient.set(key, JSON.stringify(value), 'EX', ttlSeconds);
          } else if (typeof this.redisClient.setEx === 'function') {
            await this.redisClient.setEx(key, ttlSeconds, JSON.stringify(value));
          } else {
            await this.redisClient.set(key, JSON.stringify(value));
            // no TTL support available
          }
        } else {
          await this.redisClient.set(key, JSON.stringify(value));
        }

        // handle tags
        if (Array.isArray(tags) && tags.length > 0) {
          for (const tag of tags) {
            const tagKey = `tag:${tag}`;
            try {
              if (typeof this.redisClient.sAdd === 'function') {
                await this.redisClient.sAdd(tagKey, key);
              } else if (typeof this.redisClient.sadd === 'function') {
                await this.redisClient.sadd(tagKey, key);
              }
            } catch (_) {
              // ignore
            }
          }
        }

        return true;
      } catch (err) {
        this.logger.warn('Redis SET failed, falling back to in-memory: ' + (err instanceof Error ? err.message : String(err)));
      }
    }

    // In-memory fallback
    const expiresAt = ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined;
    this.inMemory.set(key, { value, expiresAt });
    if (Array.isArray(tags)) {
      for (const tag of tags) {
        let set = this.tagIndex.get(tag);
        if (!set) {
          set = new Set();
          this.tagIndex.set(tag, set);
        }
        set.add(key);
      }
    }
    return true;
  }

  async get<T = any>(key: string): Promise<T | undefined> {
    if (this.isRedisReady()) {
      try {
        const raw = await this.redisClient.get(key);
        if (raw == null) return undefined;
        return JSON.parse(raw) as T;
      } catch (err) {
        this.logger.warn('Redis GET failed, falling back to in-memory: ' + (err instanceof Error ? err.message : String(err)));
      }
    }

    const entry = this.inMemory.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.inMemory.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  async del(key: string) {
    if (this.isRedisReady()) {
      try {
        if (typeof this.redisClient.del === 'function') {
          await this.redisClient.del(key);
        } else if (typeof this.redisClient.unlink === 'function') {
          await this.redisClient.unlink(key);
        }
        return true;
      } catch (err) {
        this.logger.warn('Redis DEL failed, falling back to in-memory del: ' + (err instanceof Error ? err.message : String(err)));
      }
    }

    this.inMemory.delete(key);
    // also remove from tag index
    for (const [tag, set] of this.tagIndex.entries()) {
      set.delete(key);
      if (set.size === 0) this.tagIndex.delete(tag);
    }
    return true;
  }

  // Invalidate by prefix (scan keys in Redis or iterate in-memory)
  async invalidateByPrefix(prefix: string) {
    if (this.isRedisReady()) {
      try {
        // Try to use SCAN for Redis
        const streamKeys: string[] = [];
        if (typeof this.redisClient.scan === 'function') {
          // Basic SCAN implementation
          let cursor = '0';
          do {
            // @ts-ignore
            const reply = await this.redisClient.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', '1000');
            cursor = reply[0];
            const keys = reply[1];
            streamKeys.push(...keys);
          } while (cursor !== '0');
        }

        if (streamKeys.length > 0) {
          if (typeof this.redisClient.del === 'function') {
            await this.redisClient.del(...streamKeys);
          }
        }
        return true;
      } catch (err) {
        this.logger.warn('Redis prefix invalidation failed: ' + (err instanceof Error ? err.message : String(err)));
      }
    }

    // In-memory fallback
    const keys = Array.from(this.inMemory.keys()).filter(k => k.startsWith(prefix));
    for (const k of keys) this.inMemory.delete(k);
    // Clean tag index
    for (const [tag, set] of this.tagIndex.entries()) {
      for (const k of keys) set.delete(k);
      if (set.size === 0) this.tagIndex.delete(tag);
    }
    return true;
  }

  // Invalidate by tag: remove all keys associated with a tag
  async invalidateByTag(tag: string) {
    if (this.isRedisReady()) {
      try {
        const tagKey = `tag:${tag}`;
        let members: string[] = [];
        if (typeof this.redisClient.sMembers === 'function') {
          members = await this.redisClient.sMembers(tagKey);
        } else if (typeof this.redisClient.smembers === 'function') {
          members = await this.redisClient.smembers(tagKey);
        }
        if (members.length > 0) {
          if (typeof this.redisClient.del === 'function') {
            await this.redisClient.del(...members);
          }
        }
        // remove tag set
        if (typeof this.redisClient.del === 'function') await this.redisClient.del(tagKey);
        return true;
      } catch (err) {
        this.logger.warn('Redis tag invalidation failed: ' + (err instanceof Error ? err.message : String(err)));
      }
    }

    const set = this.tagIndex.get(tag);
    if (!set) return true;
    for (const k of set) this.inMemory.delete(k);
    this.tagIndex.delete(tag);
    return true;
  }

  // Convenience: get or set wrapper
  async wrap<T>(key: string, ttlSeconds: number | undefined, fn: () => Promise<T>, tags?: string[]): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== undefined) return cached;
    const value = await fn();
    await this.set(key, value, ttlSeconds, tags);
    return value;
  }
}

export default DistributedCacheService;
