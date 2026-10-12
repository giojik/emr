import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications';
import { StockModule } from '../stock/stock.module';
import { ProcCommon } from './procurement-common';
import { ProcOrdersController, ProcOrdersService, ProcPricesService } from './procurement-po';
import { ProcRequisitionsController, ProcRequisitionsService } from './procurement-pr';

/** შესყიდვები (0051): მომწოდებლის ფასთა ნუსხა, შესყიდვის მოთხოვნა (PR) + დამტკიცება, შეკვეთა მომწოდებელთან (PO), მიღება შეკვეთიდან */
@Module({
  imports: [NotificationsModule, AuthModule, StockModule],
  controllers: [ProcRequisitionsController, ProcOrdersController],
  providers: [ProcCommon, ProcRequisitionsService, ProcOrdersService, ProcPricesService],
  exports: [ProcCommon],
})
export class ProcurementModule {}
