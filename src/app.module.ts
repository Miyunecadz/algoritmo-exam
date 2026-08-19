import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { buildDataSourceOptions } from './database/data-source';
import { HealthController } from './common/health/health.controller';
import { TenantMiddleware } from './common/tenant/tenant.middleware';
import { TenantModule } from './common/tenant/tenant.module';
import { BillsModule } from './bills/bills.module';
import { LedgerModule } from './ledger/ledger.module';
import { PaymentsModule } from './payments/payments.module';
import { ReconciliationModule } from './reconciliation/reconciliation.module';

@Module({
  imports: [
    TypeOrmModule.forRoot(buildDataSourceOptions()),
    TenantModule,
    LedgerModule,
    BillsModule,
    PaymentsModule,
    ReconciliationModule,
  ],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Every route carries a tenant context except the health probe.
    consumer
      .apply(TenantMiddleware)
      .exclude({ path: 'health', method: RequestMethod.ALL })
      .forRoutes('*path');
  }
}
