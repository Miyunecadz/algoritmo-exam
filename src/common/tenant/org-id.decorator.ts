import {
  createParamDecorator,
  ExecutionContext,
  InternalServerErrorException,
} from '@nestjs/common';
import { Request } from 'express';

/**
 * Injects the tenant id established by `TenantMiddleware`.
 *
 * Used explicitly in every controller signature. The verbosity is the point: a handler that is
 * missing its tenant scope is visible in the diff, rather than hidden behind ambient context.
 */
export const OrgId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const request = ctx.switchToHttp().getRequest<Request>();
  if (!request.orgId) {
    // Unreachable while the middleware is bound to the route; loud if someone unbinds it.
    throw new InternalServerErrorException('Tenant context is missing');
  }
  return request.orgId;
});
