import { Controller, Get } from '@nestjs/common';
import {
  HealthCheckService,
  HealthCheck,
  TypeOrmHealthIndicator,
  MemoryHealthIndicator,
  DiskHealthIndicator,
} from '@nestjs/terminus';
import { RedisHealthIndicator } from './redis.health.js';

@Controller('health')
export class HealthController {
  constructor(
    private health: HealthCheckService,
    private db: TypeOrmHealthIndicator,
    private memory: MemoryHealthIndicator,
    private disk: DiskHealthIndicator,
    private redis: RedisHealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([
      // Database health check
      () => this.db.pingCheck('database'),
      
      // Redis health check
      () => this.redis.isHealthy('redis'),
      
      // Memory health check - heap should not exceed 300MB
      () => this.memory.checkHeap('memory_heap', 300 * 1024 * 1024),
      
      // Memory health check - RSS should not exceed 500MB
      () => this.memory.checkRSS('memory_rss', 500 * 1024 * 1024),
      
      // Disk health check - 90% threshold
      () => this.disk.checkStorage('disk', {
        path: '/',
        thresholdPercent: 0.9,
      }),
    ]);
  }

  @Get('ready')
  @HealthCheck()
  readiness() {
    // Readiness check - is the app ready to serve traffic?
    return this.health.check([
      () => this.db.pingCheck('database'),
      () => this.redis.isHealthy('redis'),
    ]);
  }

  @Get('live')
  @HealthCheck()
  liveness() {
    // Liveness check - is the app alive?
    // Just return OK - if the app can respond, it's alive
    return { status: 'ok', timestamp: new Date().toISOString() };
  }
}
