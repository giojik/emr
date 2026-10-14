import { Module } from '@nestjs/common';
import { ReportingAdminService, ReportingController, ReportingService } from './reporting';
import { ReportingDashController, ReportingDashService } from './reporting-dash';
import { RptKpiService } from './reporting-kpi';
import { ReportingOpsController, ReportingOpsService } from './reporting-ops';
import { RptRefreshService } from './reporting-refresh';

/** მენეჯერული რეპორტინგი: 0060 — KPI / ჩაღრმავება / ექსპორტი / ადმინისტრირება; 0061 — თემატური დაფები (headline, trend, live, attention); 0062 — ოპერაციული (ops/*) */
@Module({
  providers: [ReportingService, ReportingAdminService, RptKpiService, RptRefreshService, ReportingDashService, ReportingOpsService],
  controllers: [ReportingController, ReportingDashController, ReportingOpsController],
})
export class ReportingModule {}
