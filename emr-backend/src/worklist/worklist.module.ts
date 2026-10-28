import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.service';
import { RosterModule } from '../roster/roster.module';
import { StockModule } from '../stock/stock.module';
import { WorklistController, WorklistService } from './worklist';
import { WorklistJobsService } from './worklist-jobs';
import { WorklistSources } from './worklist-sources';
import { WorklistAdminSources } from './worklist-sources-admin';
import { WorklistTasksService } from './worklist-tasks';

/**
 * სამუშაო სიები (D5): 0081 — საფუძველი: „ჩემი დავალებები“ (სისტემური წყაროები: ხარისხი / IPC / BME / ცვლები + ხელით შექმნილი),
 * ხელით დავალება (პირი / როლი / განყოფილება / მორიგე, „ავიღებ“, ვადა, ესკალაცია), კატეგორიები, ხელმძღვანელის ხედი.
 * 0082 — ადმინისტრაცია / ლოჯისტიკა (worklist-sources-admin: მარაგი, შესყიდვები, ფინანსები, ტარიფები, CSSD, ინვენტარი, რეგისტრატურა); 0083 — კლინიკური; 0084 — დიაგნოსტიკა + განმეორებადი + ანგარიშები.
 */
@Module({
  imports: [AuditModule, RosterModule, StockModule],
  controllers: [WorklistController],
  providers: [WorklistService, WorklistSources, WorklistAdminSources, WorklistTasksService, WorklistJobsService],
  exports: [WorklistJobsService, WorklistTasksService],
})
export class WorklistModule {}
