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

/** Postgres `foreign_key_violation`. */
const FOREIGN_KEY_VIOLATION = '23503';

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

      // A write carrying a well-formed org id that no organization owns. Reads already answer 404
      // for that case — `TenantMiddleware` deliberately does not check the org exists, because a
      // missing org and another tenant's org must be indistinguishable. Letting this surface as a
      // 500 would hand back exactly the signal that equivalence exists to deny.
      //
      // Narrowed to the `org_id` foreign keys by constraint name, the same discrimination
      // `PaymentsService` applies to `23505`: any OTHER foreign-key violation is an invariant
      // breach and must stay a loud 500.
      if (driverCode === FOREIGN_KEY_VIOLATION && this.isOrgForeignKey(exception)) {
        return {
          statusCode: HttpStatus.NOT_FOUND,
          code: ErrorCode.NOT_FOUND,
          message: 'Organization not found',
        };
      }
    }

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ErrorCode.INTERNAL_ERROR,
      message: 'Internal server error',
    };
  }

  /** True for the `<table>_org_id_fkey` constraints — a row pointing at a non-existent organization. */
  private isOrgForeignKey(exception: unknown): boolean {
    const driverError = (exception as { driverError?: unknown }).driverError;
    const details = (driverError ?? exception) as { constraint?: string };
    return details.constraint?.endsWith('_org_id_fkey') ?? false;
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
