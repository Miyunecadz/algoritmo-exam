import { Controller, Get } from '@nestjs/common';

/** Exempt from `TenantMiddleware` — it is the first thing the README asks a reader to curl. */
@Controller('health')
export class HealthController {
  @Get()
  check(): { status: string } {
    return { status: 'ok' };
  }
}
