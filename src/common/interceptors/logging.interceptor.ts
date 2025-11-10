import { Injectable, NestInterceptor, ExecutionContext, CallHandler, Logger, Inject } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  constructor(
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();
    const { method, url, headers, params, query, body } = req;
    const now = Date.now();

    // Extract correlation and request IDs
    const correlationId = req.correlationId || headers['x-correlation-id'] || 'unknown';
    const requestId = req.requestId || headers['x-request-id'] || 'unknown';
    const userId = req.user?.id || req.user?.sub || 'anonymous';
    const userAgent = headers['user-agent'] || 'unknown';
    const ip = req.ip || headers['x-forwarded-for'] || req.connection?.remoteAddress || 'unknown';

    // Build structured log context
    const logContext = {
      correlationId,
      requestId,
      userId,
      method,
      url,
      userAgent,
      ip,
    };

    // Sanitize sensitive data from body
    const safeBody = this.sanitize(body);

    // Log incoming request with structured data
    this.logger.log({
      message: 'Incoming HTTP request',
      ...logContext,
      params: params || {},
      query: query || {},
      body: safeBody,
    });

    return next.handle().pipe(
      tap({
        next: () => {
          const elapsed = Date.now() - now;
          const statusCode = res?.statusCode ?? 200;
          
          const logData = {
            message: 'HTTP request completed',
            ...logContext,
            statusCode,
            duration: elapsed,
          };

          if (statusCode >= 500) {
            this.logger.error(logData);
          } else if (statusCode >= 400) {
            this.logger.warn(logData);
          } else {
            this.logger.log(logData);
          }
        },
        error: (err) => {
          const elapsed = Date.now() - now;
          const statusCode = err?.status || res?.statusCode || 500;
          
          this.logger.error({
            message: 'HTTP request failed',
            ...logContext,
            statusCode,
            duration: elapsed,
            error: {
              message: err?.message,
              name: err?.name,
              stack: err?.stack,
            },
          });
        },
      }),
    );
  }

  private sanitize(obj: any): any {
    if (!obj || typeof obj !== 'object') return obj;
    const sensitive = new Set([
      'password',
      'passwordConfirmation',
      'currentPassword',
      'newPassword',
      'token',
      'accessToken',
      'refreshToken',
      'secret',
      'ssn',
    ]);

    if (Array.isArray(obj)) {
      return obj.map((v) => this.sanitize(v));
    }

    const copy: Record<string, any> = {};
    for (const key of Object.keys(obj)) {
      try {
        if (sensitive.has(key)) {
          copy[key] = '[REDACTED]';
        } else if (typeof obj[key] === 'object') {
          copy[key] = this.sanitize(obj[key]);
        } else {
          copy[key] = obj[key];
        }
      } catch {
        // If any property throws during access, skip it
        copy[key] = '[UNAVAILABLE]';
      }
    }

    return copy;
  }
} 