import { Module } from '@nestjs/common';
import { AuditModule } from './audit/audit.service';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { PatientsModule } from './patients/patients.module';

@Module({
  imports: [DatabaseModule, AuditModule, PatientsModule],
  controllers: [HealthController],
})
export class AppModule {}
