import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.service';
import { OrModule } from '../or/or.module';
import { RosterModule } from '../roster/roster.module';
import { StockModule } from '../stock/stock.module';
import { WorklistController, WorklistService } from './worklist';
import { WorklistJobsService } from './worklist-jobs';
import { WorklistSources } from './worklist-sources';
import { WorklistAdminSources } from './worklist-sources-admin';
import { WorklistClinicalSources } from './worklist-sources-clinical';
import { WorklistTasksService } from './worklist-tasks';

/**
 * სამუშაო სიები (D5): 0081 — საფუძველი: „ჩემი დავალებები“ (სისტემური წყაროები: ხარისხი / IPC / BME / ცვლები + ხელით შექმნილი),
 * ხელით დავალება (პირი / როლი / განყოფილება / მორიგე, „ავიღებ“, ვადა, ესკალაცია), კატეგორიები, ხელმძღვანელის ხედი.
 * 0082 — ადმინისტრაცია / ლოჯისტიკა (worklist-sources-admin: მარაგი, შესყიდვები, ფინანსები, ტარიფები, CSSD, ინვენტარი, რეგისტრატურა); 0083 — კლინიკური (worklist-sources-clinical: დოკუმენტაცია, დანიშნულებები / MAR, კონსულტაცია / გადაყვანა, საექთნო / NEWS2, ICU, საოპერაციო); 0084 — დიაგნოსტიკა + განმეორებადი + ანგარიშები.
 */
@Module({
  imports: [AuditModule, RosterModule, StockModule, OrModule],
  controllers: [WorklistController],
  providers: [WorklistService, WorklistSources, WorklistAdminSources, WorklistClinicalSources, WorklistTasksService, WorklistJobsService],
  exports: [WorklistJobsService, WorklistTasksService],
})
export class WorklistModule {}
