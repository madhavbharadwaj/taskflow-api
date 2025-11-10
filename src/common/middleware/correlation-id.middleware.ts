import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';

export const CORRELATION_ID_HEADER = 'x-correlation-id';
export const REQUEST_ID_HEADER = 'x-request-id';

// Extend Express Request to include correlation context
declare global {
  namespace Express {
    interface Request {
      correlationId?: string;
      requestId?: string;
    }
  }
}

/**
 * Middleware to generate and attach correlation IDs to requests
 * Enables distributed tracing across services
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    // Check if correlation ID exists in headers (from upstream service)
    const correlationId = 
      req.headers[CORRELATION_ID_HEADER] as string || 
      this.generateId();

    // Generate unique request ID for this specific request
    const requestId = this.generateId();

    // Attach to request object for use in handlers
    req.correlationId = correlationId;
    req.requestId = requestId;

    // Add to response headers for debugging
    res.setHeader(CORRELATION_ID_HEADER, correlationId);
    res.setHeader(REQUEST_ID_HEADER, requestId);

    next();
  }

  private generateId(): string {
    return crypto.randomUUID();
  }
}
