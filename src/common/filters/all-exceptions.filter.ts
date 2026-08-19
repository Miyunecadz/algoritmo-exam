import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { QueryFailedError } from 'typeorm';
import { ErrorCode } from '../errors/error-code';

interface ErrorBody {
  statusCode: number;
  code: string;
  message: string;
}

/**
 * One error shape for the entire API: `{ statusCode, code, message }`.
 *
 * Driver errors are logged in full server-side and never echoed to the client — a Postgres error
 * message can disclose table names, constraint names and even row values.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const body = this.toErrorBody(exception);

    if (body.statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `Unhandled error: ${exception instanceof Error ? exception.stack : String(exception)}`,
      );
    }

    response.status(body.statusCode).json(body);
  }

  private toErrorBody(exception: unknown): ErrorBody {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();

      if (typeof payload === 'object' && payload !== null) {
        const record = payload as Record<string, unknown>;
        const message = Array.isArray(record.message)
          ? record.message.join('; ')
          : typeof record.message === 'string'
            ? record.message
            : exception.message;
        const code =
          typeof record.code === 'string' ? record.code : this.defaultCodeForStatus(status);
        return { statusCode: status, code, message };
      }

      return {
        statusCode: status,
        code: this.defaultCodeForStatus(status),
        message: typeof payload === 'string' ? payload : exception.message,
      };
    }

    if (exception instanceof QueryFailedError) {
      const driverCode = (exception as QueryFailedError & { code?: string }).code;
      // Connection-class failures: the request never wrote anything, so tell the caller to retry.
      if (driverCode && ['08000', '08003', '08006', '57P03'].includes(driverCode)) {
        return {
          statusCode: HttpStatus.SERVICE_UNAVAILABLE,
          code: ErrorCode.DATABASE_UNAVAILABLE,
          message: 'Database is unavailable, please retry',
        };
      }
    }

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ErrorCode.INTERNAL_ERROR,
      message: 'Internal server error',
    };
  }

  private defaultCodeForStatus(status: number): string {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return ErrorCode.VALIDATION_FAILED;
      case HttpStatus.NOT_FOUND:
        return ErrorCode.NOT_FOUND;
      default:
        return ErrorCode.INTERNAL_ERROR;
    }
  }
}
