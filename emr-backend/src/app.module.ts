import { Module } from '@nestjs/common';
import { AuditModule } from './audit/audit.service';
import { AuthModule } from './auth/auth.module';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { DepartmentsModule } from './departments/departments.module';
import { PatientsModule } from './patients/patients.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [DatabaseModule, AuditModule, AuthModule, DepartmentsModule, UsersModule, PatientsModule],
  controllers: [HealthController],
})
export class AppModule {}
