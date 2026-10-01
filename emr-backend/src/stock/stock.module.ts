import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications';
import { StockTransfersController, StockTransfersService } from './stock-transfers';
import { PharmacyCatalogController, PharmacyCatalogService } from './pharmacy-catalog';
import { StockDocsController, StockDocsService } from './stock-docs';
import { StockCatalogController, StockCatalogService } from './stock-catalog';

/** საწყობი + შიდა აფთიაქი: ნომენკლატურა, ლოკაციები, მომწოდებლები (0030); მოძრაობების ჟურნალი, ნაშთები, მიღება (0031); მოთხოვნა, გაცემა, გადაცემა, დაბრუნება (0032) */
@Module({
  imports: [NotificationsModule],
  controllers: [StockCatalogController, PharmacyCatalogController, StockDocsController, StockTransfersController],
  providers: [StockCatalogService, PharmacyCatalogService, StockDocsService, StockTransfersService],
  exports: [StockCatalogService, PharmacyCatalogService, StockDocsService],
})
export class StockModule {}
