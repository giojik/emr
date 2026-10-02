import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications';
import { StockAlertsService } from './stock-alerts';
import { StockControlController, StockControlService } from './stock-control';
import { StockControlledController, StockControlledService, StockWitnessService } from './stock-controlled';
import { StockOpsController, StockOpsService } from './stock-ops';
import { StockTransfersController, StockTransfersService } from './stock-transfers';
import { PharmacyCatalogController, PharmacyCatalogService } from './pharmacy-catalog';
import { StockDocsController, StockDocsService } from './stock-docs';
import { StockCatalogController, StockCatalogService } from './stock-catalog';

/** საწყობი + შიდა აფთიაქი: ნომენკლატურა, ლოკაციები, მომწოდებლები (0030); მოძრაობების ჟურნალი, ნაშთები, მიღება (0031); მოთხოვნა, გაცემა, გადაცემა, დაბრუნება (0032); ჩამოწერა, ინვენტარიზაცია, ხარჯი პაციენტზე (0033); ვადები, გაწვევა, მინ/მაქს, რეპორტები (0034); ნარკოტიკული / ფსიქოტროპული (0035) */
@Module({
  imports: [NotificationsModule, AuthModule],
  controllers: [StockCatalogController, PharmacyCatalogController, StockDocsController, StockTransfersController, StockOpsController, StockControlController, StockControlledController],
  providers: [StockCatalogService, PharmacyCatalogService, StockDocsService, StockTransfersService, StockOpsService, StockControlService, StockAlertsService, StockControlledService, StockWitnessService],
  exports: [StockCatalogService, PharmacyCatalogService, StockDocsService],
})
export class StockModule {}
