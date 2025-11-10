import { SetMetadata, applyDecorators, UseGuards } from '@nestjs/common';
import { RateLimitGuard } from '../guards/rate-limit.guard';

export const RATE_LIMIT_KEY = 'rate_limit';

export interface RateLimitOptions {
  /**
   * Maximum number of requests allowed within the window
   */
  limit: number;
  
  /**
   * Time window in milliseconds
   */
  windowMs: number;
  
  /**
   * Optional key to use for rate limiting instead of IP
   * Can be a path to a request property like 'user.id'
   */
  keyPrefix?: string;
  
  /**
   * Custom error message when rate limit is exceeded
   */
  message?: string;
  
  /**
   * Whether to include rate limit headers in response
   */
  addHeaders?: boolean;
}

/**
 * Decorator for rate limiting endpoints
 * @param options Rate limiting options
 * 
 * @example
 * ```typescript
 * @RateLimit({ limit: 100, windowMs: 60000 }) // 100 requests per minute
 * async function handler() {}
 * 
 * @RateLimit({ 
 *   limit: 5,
 *   windowMs: 60000,
 *   keyPrefix: 'user.id',
 *   message: 'Too many attempts, please try again later'
 * })
 * async function login() {}
 * ```
 */
export const RateLimit = (options: RateLimitOptions) => {
  return applyDecorators(
    SetMetadata(RATE_LIMIT_KEY, {
      ...options,
      // Set defaults
      keyPrefix: options.keyPrefix || 'ip',
      addHeaders: options.addHeaders ?? true,
      message: options.message || 'Rate limit exceeded'
    }),
    UseGuards(RateLimitGuard)
  );
}; 