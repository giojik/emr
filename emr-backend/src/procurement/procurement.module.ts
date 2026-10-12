import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications';
import { StockModule } from '../stock/stock.module';
import { ProcCommon } from './procurement-common';
import { ProcOrdersController, ProcOrdersService, ProcPricesService } from './procurement-po';
import { ProcRequisitionsController, ProcRequisitionsService } from './procurement-pr';
import { PayablesController, PayablesService } from './payables';

/** შესყიდვები (0051) + მომწოდებლის ინვოისი / გადახდა (0052): მომწოდებლის ფასთა ნუსხა, შესყიდვის მოთხოვნა (PR) + დამტკიცება, შეკვეთა მომწოდებელთან (PO), მიღება შეკვეთიდან */
@Module({
  imports: [NotificationsModule, AuthModule, StockModule],
  controllers: [ProcRequisitionsController, ProcOrdersController, PayablesController],
  providers: [ProcCommon, ProcRequisitionsService, ProcOrdersService, ProcPricesService, PayablesService],
  exports: [ProcCommon],
})
export class ProcurementModule {}
