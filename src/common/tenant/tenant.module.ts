import { Module } from '@nestjs/common';
import { TenantScope } from './tenant-scope.service';

@Module({
  providers: [TenantScope],
  exports: [TenantScope],
})
export class TenantModule {}
