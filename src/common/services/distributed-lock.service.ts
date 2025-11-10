import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from './redis.service';
import * as crypto from 'crypto';

export interface LockOptions {
  /** Lock timeout in milliseconds (default: 30000) */
  ttl?: number;
  /** Number of retry attempts (default: 3) */
  retries?: number;
  /** Delay between retries in milliseconds (default: 100) */
  retryDelay?: number;
}

/**
 * Distributed lock service using Redis for multi-instance deployments.
 * Implements the Redlock algorithm for distributed locking.
 */
@Injectable()
export class DistributedLockService {
  private readonly logger = new Logger(DistributedLockService.name);
  private readonly DEFAULT_TTL = 30000; // 30 seconds
  private readonly DEFAULT_RETRIES = 3;
  private readonly DEFAULT_RETRY_DELAY = 100; // 100ms

  constructor(private readonly redisService: RedisService) {}

  /**
   * Acquire a distributed lock
   * @param lockKey - The key to lock
   * @param options - Lock options
   * @returns Lock token if successful, null if lock could not be acquired
   */
  async acquireLock(
    lockKey: string,
    options: LockOptions = {}
  ): Promise<string | null> {
    const ttl = options.ttl ?? this.DEFAULT_TTL;
    const retries = options.retries ?? this.DEFAULT_RETRIES;
    const retryDelay = options.retryDelay ?? this.DEFAULT_RETRY_DELAY;

    // Generate a unique token for this lock instance
    const lockToken = this.generateLockToken();
    const redisKey = `lock:${lockKey}`;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const redis = this.redisService.getClient();
        
        // Use SET with NX (only if not exists) and PX (expiry in ms)
        // This is atomic and prevents race conditions
        const result = await redis.set(
          redisKey,
          lockToken,
          'PX',
          ttl,
          'NX'
        );

        if (result === 'OK') {
          this.logger.debug(`Lock acquired: ${lockKey} (token: ${lockToken})`);
          return lockToken;
        }

        // Lock already held, retry if we have attempts left
        if (attempt < retries) {
          await this.sleep(retryDelay * Math.pow(2, attempt)); // Exponential backoff
        }
      } catch (error) {
        this.logger.error(
          `Error acquiring lock for ${lockKey}:`,
          error instanceof Error ? error.message : String(error)
        );
        
        if (attempt === retries) {
          return null;
        }
      }
    }

    this.logger.warn(`Failed to acquire lock: ${lockKey} after ${retries} attempts`);
    return null;
  }

  /**
   * Release a distributed lock
   * @param lockKey - The key to unlock
   * @param lockToken - The token received when acquiring the lock
   * @returns true if lock was released, false otherwise
   */
  async releaseLock(lockKey: string, lockToken: string): Promise<boolean> {
    try {
      const redis = this.redisService.getClient();
      const redisKey = `lock:${lockKey}`;

      // Use Lua script to ensure atomic check-and-delete
      // Only delete if the token matches (prevent releasing someone else's lock)
      const script = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `;

      const result = await redis.eval(script, 1, redisKey, lockToken);

      if (result === 1) {
        this.logger.debug(`Lock released: ${lockKey} (token: ${lockToken})`);
        return true;
      } else {
        this.logger.warn(
          `Lock release failed: ${lockKey} - token mismatch or already released`
        );
        return false;
      }
    } catch (error) {
      this.logger.error(
        `Error releasing lock for ${lockKey}:`,
        error instanceof Error ? error.message : String(error)
      );
      return false;
    }
  }

  /**
   * Execute a function with a distributed lock
   * @param lockKey - The key to lock
   * @param fn - Function to execute while holding the lock
   * @param options - Lock options
   * @returns Result of the function execution
   */
  async withLock<T>(
    lockKey: string,
    fn: () => Promise<T>,
    options: LockOptions = {}
  ): Promise<T | null> {
    const lockToken = await this.acquireLock(lockKey, options);

    if (!lockToken) {
      this.logger.warn(`Could not acquire lock for ${lockKey}, skipping execution`);
      return null;
    }

    try {
      return await fn();
    } finally {
      await this.releaseLock(lockKey, lockToken);
    }
  }

  /**
   * Extend the TTL of an existing lock
   * @param lockKey - The key to extend
   * @param lockToken - The token of the lock
   * @param additionalTtl - Additional time in milliseconds
   * @returns true if extended, false otherwise
   */
  async extendLock(
    lockKey: string,
    lockToken: string,
    additionalTtl: number
  ): Promise<boolean> {
    try {
      const redis = this.redisService.getClient();
      const redisKey = `lock:${lockKey}`;

      // Use Lua script to atomically check token and extend TTL
      const script = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("pexpire", KEYS[1], ARGV[2])
        else
          return 0
        end
      `;

      const result = await redis.eval(script, 1, redisKey, lockToken, additionalTtl);
      return result === 1;
    } catch (error) {
      this.logger.error(
        `Error extending lock for ${lockKey}:`,
        error instanceof Error ? error.message : String(error)
      );
      return false;
    }
  }

  /**
   * Check if a lock is currently held
   * @param lockKey - The key to check
   * @returns true if lock exists, false otherwise
   */
  async isLocked(lockKey: string): Promise<boolean> {
    try {
      const redis = this.redisService.getClient();
      const redisKey = `lock:${lockKey}`;
      const exists = await redis.exists(redisKey);
      return exists === 1;
    } catch (error) {
      this.logger.error(
        `Error checking lock for ${lockKey}:`,
        error instanceof Error ? error.message : String(error)
      );
      return false;
    }
  }

  private generateLockToken(): string {
    return crypto.randomBytes(16).toString('hex');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
