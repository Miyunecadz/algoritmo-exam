import { BadRequestException, Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { ErrorCode } from '../errors/error-code';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ORG_ID_HEADER = 'x-org-id';

declare module 'express' {
  interface Request {
    orgId?: string;
  }
}

/**
 * Establishes the tenant context for the request.
 *
 * ASSUMPTION, stated by the assignment: `X-Org-Id` is set by an upstream authenticated gateway and
 * is therefore trusted here. In a real system, accepting a caller-supplied tenant id would be a
 * critical vulnerability — the org must be derived from a verified credential (JWT claim, session,
 * mTLS identity), never from a plain header. This middleware is the seam where that verification
 * would live.
 *
 * Note what this middleware deliberately does NOT do: it does not check that the organization
 * exists. A well-formed UUID for a non-existent org must produce the same 404 from every resource
 * lookup as another tenant's resource does — that equivalence is the anti-enumeration property.
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    const raw = req.headers[ORG_ID_HEADER];
    const value = Array.isArray(raw) ? raw[0] : raw;

    if (value === undefined || value.trim() === '') {
      throw new BadRequestException({
        code: ErrorCode.MISSING_ORG_CONTEXT,
        message: 'X-Org-Id header is required',
      });
    }
    if (!UUID_PATTERN.test(value.trim())) {
      throw new BadRequestException({
        code: ErrorCode.INVALID_ORG_CONTEXT,
        message: 'X-Org-Id header must be a valid UUID',
      });
    }

    req.orgId = value.trim().toLowerCase();
    next();
  }
}
