import { Module } from '@nestjs/common';
import { AuditModule } from './audit/audit.service';
import { AuthModule } from './auth/auth.module';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { PatientsModule } from './patients/patients.module';

@Module({
  imports: [DatabaseModule, AuditModule, AuthModule, PatientsModule],
  controllers: [HealthController],
})
export class AppModule {}
