import { Module } from '@nestjs/common';
import { StockModule } from '../stock/stock.module';
import { OrController, OrService } from './or';
import { OrAnesthesiaController, OrAnesthesiaService } from './or-anesthesia';
import { OrMaterialsController, OrMaterialsService } from './or-materials';
import { OrNoteController, OrNoteService } from './or-note';
import { OrRosterController, OrRosterService } from './or-roster';

/** საოპერაციო ბლოკი: დაგეგმვა (0048) + ოპერაციის მსვლელობა (0049) — ოთახის გუნდი, ანესთეზიის რუკა, ოქმი, მასალები / იმპლანტები / დათვლა, CSSD */
@Module({
  imports: [StockModule],
  providers: [OrService, OrRosterService, OrAnesthesiaService, OrNoteService, OrMaterialsService],
  controllers: [OrController, OrRosterController, OrAnesthesiaController, OrNoteController, OrMaterialsController],
  exports: [OrService],
})
export class OrModule {}
