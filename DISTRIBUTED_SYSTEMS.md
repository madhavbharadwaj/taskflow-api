# Distributed Systems Design Improvements

This document outlines the changes made to ensure the TaskFlow API works correctly in multi-instance deployments.

## Overview

In distributed environments with multiple application instances, several challenges arise:
- Race conditions in scheduled tasks (cron jobs)
- Cache inconsistency across instances
- Rate limiting accuracy
- Data consistency

## Solutions Implemented

### 1. Distributed Locking Service

**File:** `src/common/services/distributed-lock.service.ts`

A Redis-based distributed locking mechanism implementing the Redlock algorithm.

**Features:**
- Atomic lock acquisition using Redis `SET NX` (set if not exists)
- Automatic lock expiration (TTL) to prevent deadlocks
- Token-based lock ownership verification
- Exponential backoff for retry logic
- Lock extension capability for long-running operations

**Usage Example:**
```typescript
// Acquire lock manually
const lockToken = await lockService.acquireLock('my-resource', { ttl: 30000 });
if (lockToken) {
  try {
    // Protected operation
  } finally {
    await lockService.releaseLock('my-resource', lockToken);
  }
}

// Or use the convenience method
await lockService.withLock('my-resource', async () => {
  // Protected operation  
}, { ttl: 30000 });
```

### 2. Distributed Cron Job Execution

**File:** `src/queues/scheduled-tasks/overdue-tasks.service.ts`

**Problem:** Multiple instances running the same cron job simultaneously, causing:
- Duplicate task processing
- Wasted resources
- Race conditions

**Solution:**
- Wrap cron job execution in distributed lock
- Only one instance acquires the lock and processes tasks
- Other instances skip execution if lock is held
- Lock auto-expires if instance crashes

**Implementation:**
```typescript
@Cron(CronExpression.EVERY_HOUR)
async checkOverdueTasks() {
  await this.lockService.withLock(
    'cron:overdue-tasks-check',
    async () => await this.processOverdueTasks(),
    { ttl: 10 * 60 * 1000, retries: 0 }
  );
}
```

### 3. Distributed Cache

**File:** `src/common/services/distributed-cache.service.ts`

**Features:**
- Redis-backed cache shared across all instances
- Automatic fallback to in-memory cache if Redis unavailable
- Tag-based cache invalidation
- TTL support
- Atomic operations

**Benefits:**
- Cache hits shared across all instances
- No cache stampede issues
- Consistent data across instances

### 4. Distributed Rate Limiting

**File:** `src/common/guards/rate-limit.guard.ts`

**Implementation:**
- Redis-based rate limiting using sliding window algorithm
- Atomic operations with Redis MULTI/EXEC
- Consistent rate limits across all instances
- Proper error handling (fail open if Redis unavailable)

**Key Features:**
```typescript
private async checkRateLimit(key: string, options: RateLimitOptions) {
  const redis = this.redisService.getClient();
  const windowKey = `${key}:${Math.floor(Date.now() / options.windowMs)}`;

  // Atomic increment and TTL check
  const multi = redis.multi();
  multi.incr(windowKey);
  multi.pttl(windowKey);
  const results = await multi.exec();
  
  // Set expiry on first request
  if (ttl === -1) {
    await redis.pexpire(windowKey, options.windowMs);
  }
}
```

## Best Practices for Multi-Instance Deployments

### 1. Stateless Application Design
- **Never** store state in memory that needs to be shared
- Use Redis for shared state (cache, locks, sessions)
- Database for persistent state

### 2. Idempotent Operations
- Ensure operations can be safely retried
- Use unique identifiers for deduplication
- Implement proper error handling

### 3. Distributed Locks
- **Use locks for:**
  - Cron jobs / scheduled tasks
  - Critical sections with race conditions
  - Resource initialization

- **Lock Guidelines:**
  - Keep lock duration as short as possible
  - Set appropriate TTL to prevent deadlocks
  - Always release locks in `finally` blocks
  - Use unique tokens to prevent lock stealing

### 4. Database Transactions
- Use database transactions for data consistency
- Implement optimistic locking where appropriate
- Handle deadlocks with retry logic

### 5. Queue-Based Processing
- Use BullMQ for background jobs (already Redis-backed)
- Ensures exactly-once or at-least-once processing
- Automatic retry and failure handling
- Load balancing across instances

### 6. Health Checks and Graceful Shutdown
```typescript
// Implement in main.ts
app.enableShutdownHooks();

process.on('SIGTERM', async () => {
  await app.close();
});
```

## Configuration for Production

### Environment Variables
```env
# Redis Configuration (required for distributed systems)
REDIS_HOST=redis-cluster.example.com
REDIS_PORT=6379
REDIS_PASSWORD=secure_password
REDIS_TLS=true

# Database Connection Pool
DB_POOL_SIZE=20
DB_POOL_TIMEOUT=30000

# Application
NODE_ENV=production
INSTANCE_ID=${HOSTNAME} # For logging/debugging
```

### Load Balancer Configuration
- Enable session affinity for WebSocket connections (if used)
- Health check endpoint: `GET /health`
- Distribute load evenly across instances
- Set proper timeout values

### Redis Configuration
```bash
# Redis persistence for reliability
appendonly yes
appendfsync everysec

# Memory management
maxmemory 2gb
maxmemory-policy allkeys-lru

# Replication for high availability
replicaof redis-primary 6379
```

## Monitoring and Debugging

### Key Metrics to Monitor
1. **Redis Connection**
   - Connection pool utilization
   - Command latency
   - Failed operations

2. **Distributed Locks**
   - Lock acquisition failures
   - Lock wait times
   - Stuck locks (monitor lock expiration)

3. **Rate Limiting**
   - Rate limit hits per endpoint
   - Redis rate limiter errors

4. **Cron Jobs**
   - Execution frequency per instance
   - Lock acquisition success rate
   - Job completion time

### Debugging Multi-Instance Issues

**Symptom:** Cron job running multiple times
- Check: Lock acquisition logs
- Verify: Redis connectivity
- Monitor: Lock expiration times

**Symptom:** Cache misses across instances
- Check: Redis connection health
- Verify: Cache key consistency
- Monitor: Network latency to Redis

**Symptom:** Inconsistent rate limiting
- Check: System clock synchronization (NTP)
- Verify: Redis MULTI/EXEC transactions
- Monitor: Rate limit window calculations

## Testing Distributed Behavior

### Local Testing with Multiple Instances
```bash
# Terminal 1
PORT=3000 npm run start:dev

# Terminal 2
PORT=3001 npm run start:dev

# Terminal 3 - Make requests to both
curl http://localhost:3000/api/endpoint
curl http://localhost:3001/api/endpoint
```

### Integration Tests
```typescript
// Test distributed lock behavior
it('should allow only one instance to acquire lock', async () => {
  const lock1 = await lockService.acquireLock('test-lock');
  const lock2 = await lockService.acquireLock('test-lock', { retries: 0 });
  
  expect(lock1).not.toBeNull();
  expect(lock2).toBeNull(); // Second attempt fails
  
  await lockService.releaseLock('test-lock', lock1);
});
```

## Migration Guide

### From Single Instance to Multi-Instance

1. **Deploy Redis** (if not already available)
2. **Update environment variables** with Redis connection
3. **Deploy new code** with distributed locking
4. **Scale horizontally** to multiple instances
5. **Monitor** for issues in first 24 hours
6. **Verify** cron jobs run only once per schedule

### Rollback Plan
1. Scale back to single instance
2. Previous code works without Redis (fallback to in-memory)
3. No database schema changes required

## Performance Considerations

### Redis Operation Costs
- **Lock acquisition**: 1-2ms typical
- **Cache get/set**: <1ms typical
- **Rate limit check**: 1-2ms typical

### Network Latency
- Co-locate Redis with application instances
- Use Redis cluster for high availability
- Consider read replicas for cache-heavy workloads

### Failure Modes
- **Redis unavailable**: Application degrades gracefully
  - Locks fail open (allow all requests)
  - Cache falls back to in-memory (per instance)
  - Rate limiting disabled
  
- **High Redis latency**: Set appropriate timeouts
  - Lock acquisition timeout: 100-500ms
  - Cache timeout: 50-100ms
  - Circuit breaker pattern for repeated failures

## Security Considerations

1. **Redis Authentication**
   - Always use password authentication
   - Use TLS for Redis connections in production
   - Isolate Redis network access

2. **Lock Tokens**
   - Cryptographically random tokens prevent guessing
   - Tokens verified before lock release
   - Prevents accidental lock stealing

3. **Cache Keys**
   - Namespace keys to prevent collisions
   - Sanitize user input in cache keys
   - Set maximum key length

## Additional Resources

- [Redlock Algorithm](https://redis.io/topics/distlock)
- [BullMQ Documentation](https://docs.bullmq.io/)
- [Redis Best Practices](https://redis.io/topics/admin)
- [Distributed Systems Patterns](https://www.microsoft.com/en-us/research/uploads/prod/2016/12/Distributed-System-Patterns.pdf)
