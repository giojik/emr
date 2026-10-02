import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications';
import { StockOpsController, StockOpsService } from './stock-ops';
import { StockTransfersController, StockTransfersService } from './stock-transfers';
import { PharmacyCatalogController, PharmacyCatalogService } from './pharmacy-catalog';
import { StockDocsController, StockDocsService } from './stock-docs';
import { StockCatalogController, StockCatalogService } from './stock-catalog';

/** საწყობი + შიდა აფთიაქი: ნომენკლატურა, ლოკაციები, მომწოდებლები (0030); მოძრაობების ჟურნალი, ნაშთები, მიღება (0031); მოთხოვნა, გაცემა, გადაცემა, დაბრუნება (0032); ჩამოწერა, ინვენტარიზაცია, ხარჯი პაციენტზე (0033) */
@Module({
  imports: [NotificationsModule],
  controllers: [StockCatalogController, PharmacyCatalogController, StockDocsController, StockTransfersController, StockOpsController],
  providers: [StockCatalogService, PharmacyCatalogService, StockDocsService, StockTransfersService, StockOpsService],
  exports: [StockCatalogService, PharmacyCatalogService, StockDocsService],
})
export class StockModule {}
