import { ExceptionFilter, Catch, ArgumentsHost, HttpException, Logger } from '@nestjs/common';
import { Request, Response } from 'express';

@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: HttpException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const status = exception.getStatus();
    const exceptionResponse = exception.getResponse() as any;

    // Determine error severity based on status code
    if (status >= 500) {
      this.logger.error(
        `Internal Server Error [${status}]: ${exception.message}`,
        exception.stack,
        {
          path: request.url,
          method: request.method,
          timestamp: new Date().toISOString(),
          correlationId: request.headers['x-correlation-id'],
        }
      );
    } else if (status >= 400) {
      this.logger.warn(
        `Client Error [${status}]: ${exception.message}`,
        {
          path: request.url,
          method: request.method,
        }
      );
    }

    // Format the error response consistently
    const errorResponse = {
      success: false,
      statusCode: status,
      error: {
        type: this.getErrorType(status),
        code: this.getErrorCode(status, exception),
        message: this.getErrorMessage(exceptionResponse),
        details: this.getErrorDetails(exceptionResponse, status),
      },
      timestamp: new Date().toISOString(),
      path: request.url,
      // Include request ID if available for tracking
      requestId: request.headers['x-request-id'],
    };

    response.status(status).json(errorResponse);
  }

  private getErrorType(status: number): string {
    if (status >= 500) return 'ServerError';
    if (status === 404) return 'NotFound';
    if (status === 403) return 'Forbidden';
    if (status === 401) return 'Unauthorized';
    if (status === 400) return 'BadRequest';
    return 'ClientError';
  }

  private getErrorCode(status: number, exception: HttpException): string {
    return `ERR_${status}`;
  }

  private getErrorMessage(exceptionResponse: any): string {
    if (typeof exceptionResponse === 'string') {
      return exceptionResponse;
    }
    
    if (typeof exceptionResponse === 'object') {
      // Handle class-validator errors
      if (Array.isArray(exceptionResponse.message)) {
        return exceptionResponse.message[0];
      }
      return exceptionResponse.message || exceptionResponse.error || 'An error occurred';
    }

    return 'An error occurred';
  }

  private getErrorDetails(exceptionResponse: any, status: number): any {
    // Don't expose error details in production for 500 errors
    if (status >= 500 && process.env.NODE_ENV === 'production') {
      return undefined;
    }

    if (typeof exceptionResponse === 'object') {
      // Handle validation errors
      if (Array.isArray(exceptionResponse.message)) {
        return {
          validationErrors: exceptionResponse.message
        };
      }

      // Remove sensitive info
      const { password, ...safeDetails } = exceptionResponse;
      return safeDetails;
    }

    return undefined;
  }
} 