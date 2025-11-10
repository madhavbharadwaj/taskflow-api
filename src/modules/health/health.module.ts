import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { MetricsController } from './metrics.controller';
import { RedisHealthIndicator } from './redis.health.js';
import { RedisModule } from '../../common/services/redis.module';

@Module({
  imports: [TerminusModule, RedisModule],
  controllers: [HealthController, MetricsController],
  providers: [RedisHealthIndicator],
})
export class HealthModule {}
