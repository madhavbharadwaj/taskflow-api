import { 
  Injectable, 
  CanActivate, 
  ExecutionContext, 
  HttpException, 
  HttpStatus,
  Logger
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RedisService } from '../services/redis.service';
import { RATE_LIMIT_KEY, RateLimitOptions } from '../decorators/rate-limit.decorator';
import { get } from 'lodash';
import * as crypto from 'crypto';

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  reset: number;
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  constructor(
    private reflector: Reflector,
    private redisService: RedisService
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.get<RateLimitOptions>(
      RATE_LIMIT_KEY,
      context.getHandler()
    );

    if (!options) {
      return true; // No rate limiting if no metadata
    }

    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();
    
    try {
      // Get the rate limit key based on options
      const key = this.getRateLimitKey(request, options);
      const result = await this.checkRateLimit(key, options);
      
      // Add rate limit headers if enabled
      if (options.addHeaders) {
        response.header('X-RateLimit-Limit', options.limit.toString());
        response.header('X-RateLimit-Remaining', result.remaining.toString());
        response.header('X-RateLimit-Reset', result.reset.toString());
        if (!result.allowed) {
          response.header('Retry-After', Math.ceil(result.reset - Date.now() / 1000).toString());
        }
      }

      if (!result.allowed) {
        throw new HttpException({
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'Too Many Requests',
          message: options.message || 'Rate limit exceeded',
          retryAfter: Math.ceil(result.reset - Date.now() / 1000)
        }, HttpStatus.TOO_MANY_REQUESTS);
      }

      return true;
    } catch (error) {
      // If Redis is down, allow the request but log the error
      if (!(error instanceof HttpException)) {
        this.logger.error('Rate limiting failed:', error);
        return true;
      }
      throw error;
    }
  }

  private getRateLimitKey(request: any, options: RateLimitOptions): string {
    const identifier = options.keyPrefix === 'ip' 
      ? request.ip
      : options.keyPrefix ? get(request, options.keyPrefix) : request.ip;

    if (!identifier) {
      throw new Error(`Could not determine rate limit key from ${options.keyPrefix}`);
    }

    // Hash the identifier for privacy
    const hash = this.hashIdentifier(identifier);
    return `ratelimit:${hash}`;
  }

  private hashIdentifier(identifier: string): string {
    return crypto
      .createHash('sha256')
      .update(identifier)
      .digest('base64');
  }

  private async checkRateLimit(key: string, options: RateLimitOptions): Promise<RateLimitResult> {
    const redis = this.redisService.getClient();
    const now = Date.now();
    const windowKey = `${key}:${Math.floor(now / options.windowMs)}`;

    // Use Redis MULTI to ensure atomic operations
    const multi = redis.multi();
    multi.incr(windowKey);
    multi.pttl(windowKey);

    const results = await multi.exec();
    if (!results) {
      throw new Error('Redis transaction failed');
    }

    const [[countErr, count], [ttlErr, ttlValue]] = results;
    if (countErr || ttlErr) {
      throw countErr || ttlErr;
    }

    const requestCount = count as number;
    const ttl = ttlValue as number;

    // Set expiry if this is the first request in the window
    if (ttl === -1) {
      await redis.pexpire(windowKey, options.windowMs);
    }

    const reset = Math.floor(now / 1000) + Math.floor((ttl === -1 ? options.windowMs : ttl) / 1000);
    const remaining = Math.max(0, options.limit - requestCount);

    return {
      allowed: requestCount <= options.limit,
      remaining,
      reset
    };
  }
}