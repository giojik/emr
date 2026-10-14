import { Module } from '@nestjs/common';
import { ReportingAdminService, ReportingController, ReportingService } from './reporting';
import { ReportingDashController, ReportingDashService } from './reporting-dash';
import { RptKpiService } from './reporting-kpi';
import { RptRefreshService } from './reporting-refresh';

/** მენეჯერული რეპორტინგი: 0060 — KPI / ჩაღრმავება / ექსპორტი / ადმინისტრირება; 0061 — თემატური დაფები (headline, trend, live, attention) */
@Module({
  providers: [ReportingService, ReportingAdminService, RptKpiService, RptRefreshService, ReportingDashService],
  controllers: [ReportingController, ReportingDashController],
})
export class ReportingModule {}
