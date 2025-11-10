import { Injectable } from '@nestjs/common';
import { HealthIndicator, HealthIndicatorResult, HealthCheckError } from '@nestjs/terminus';
import { RedisService } from '../../common/services/redis.service';

@Injectable()
export class RedisHealthIndicator extends HealthIndicator {
  constructor(private readonly redisService: RedisService) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    try {
      const redis = this.redisService.getClient();
      
      // Try to ping Redis
      const result = await redis.ping();
      
      if (result === 'PONG') {
        return this.getStatus(key, true, {
          message: 'Redis is healthy',
        });
      }
      
      throw new Error('Redis ping failed');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new HealthCheckError(
        'Redis check failed',
        this.getStatus(key, false, {
          message: errorMessage,
        }),
      );
    }
  }
}
