import { Module } from '@nestjs/common';
import { StockModule } from '../stock/stock.module';
import { TransfersModule } from '../inpatient/transfers';
import { OrController, OrService } from './or';
import { OrAnesthesiaController, OrAnesthesiaService } from './or-anesthesia';
import { OrBillingController, OrBillingService } from './or-billing';
import { OrMaterialsController, OrMaterialsService } from './or-materials';
import { OrNoteController, OrNoteService } from './or-note';
import { OrPacuController, OrPacuService } from './or-pacu';
import { OrRosterController, OrRosterService } from './or-roster';
import { OrStatsController, OrStatsService } from './or-stats';

/** საოპერაციო ბლოკი: დაგეგმვა (0048) + ოპერაციის მსვლელობა (0049) — ოთახის გუნდი, ანესთეზიის რუკა, ოქმი, მასალები / იმპლანტები / დათვლა, CSSD;
 *  0050 — PACU, ბილინგი, სტატისტიკა */
@Module({
  imports: [StockModule, TransfersModule],
  providers: [OrService, OrRosterService, OrAnesthesiaService, OrNoteService, OrMaterialsService, OrPacuService, OrBillingService, OrStatsService],
  controllers: [OrController, OrRosterController, OrAnesthesiaController, OrNoteController, OrMaterialsController, OrPacuController, OrBillingController, OrStatsController],
  exports: [OrService],
})
export class OrModule {}
