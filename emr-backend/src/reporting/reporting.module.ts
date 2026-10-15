import { Module } from '@nestjs/common';
import { ReportingAdminService, ReportingController, ReportingService } from './reporting';
import { ReportingDashController, ReportingDashService } from './reporting-dash';
import { ReportingFinController, ReportingFinService } from './reporting-fin';
import { RptJobsController, RptJobsService } from './reporting-jobs';
import { RptKpiService } from './reporting-kpi';
import { ReportingOpsController, ReportingOpsService } from './reporting-ops';
import { RptRefreshService } from './reporting-refresh';
import { RptReportController, RptReportService } from './reporting-report';

/** მენეჯერული რეპორტინგი: 0060 — KPI / ჩაღრმავება / ექსპორტი / ადმინისტრირება; 0061 — თემატური დაფები (headline, trend, live, attention); 0062 — ოპერაციული (ops/*);
 *  0063 — ფინანსები (fin/*), მენეჯერული ანგარიში (report), განრიგი / მიწოდება / „ყურადღების“ შეტყობინებები (worker-იც იყენებს — exports) */
@Module({
  providers: [ReportingService, ReportingAdminService, RptKpiService, RptRefreshService, ReportingDashService, ReportingOpsService, ReportingFinService, RptReportService, RptJobsService],
  controllers: [ReportingController, ReportingDashController, ReportingOpsController, ReportingFinController, RptReportController, RptJobsController],
  exports: [RptRefreshService, RptJobsService],
})
export class ReportingModule {}
