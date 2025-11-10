import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { Counter, Histogram, register } from 'prom-client';

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  private readonly httpRequestDuration: Histogram<string>;
  private readonly httpRequestTotal: Counter<string>;

  constructor() {
    // HTTP request duration histogram
    this.httpRequestDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'Duration of HTTP requests in seconds',
      labelNames: ['method', 'route', 'status_code'],
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
      registers: [register],
    });

    // HTTP request counter
    this.httpRequestTotal = new Counter({
      name: 'http_requests_total',
      help: 'Total number of HTTP requests',
      labelNames: ['method', 'route', 'status_code'],
      registers: [register],
    });
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();
    
    const startTime = Date.now();
    const { method, route } = request;
    const routePath = route?.path || request.url;

    return next.handle().pipe(
      tap({
        next: () => {
          const duration = (Date.now() - startTime) / 1000;
          const statusCode = response.statusCode || 200;

          this.httpRequestDuration.observe(
            { method, route: routePath, status_code: statusCode },
            duration
          );

          this.httpRequestTotal.inc({
            method,
            route: routePath,
            status_code: statusCode,
          });
        },
        error: (error) => {
          const duration = (Date.now() - startTime) / 1000;
          const statusCode = error?.status || response.statusCode || 500;

          this.httpRequestDuration.observe(
            { method, route: routePath, status_code: statusCode },
            duration
          );

          this.httpRequestTotal.inc({
            method,
            route: routePath,
            status_code: statusCode,
          });
        },
      }),
    );
  }
}
