import { Module } from '@nestjs/common';
import { PharmacyCatalogController, PharmacyCatalogService } from './pharmacy-catalog';
import { StockCatalogController, StockCatalogService } from './stock-catalog';

/** საწყობი + შიდა აფთიაქი (0030-დან): ნომენკლატურა, ლოკაციები, მომწოდებლები; შემდეგ — ნაშთები და მოძრაობები */
@Module({
  controllers: [StockCatalogController, PharmacyCatalogController],
  providers: [StockCatalogService, PharmacyCatalogService],
  exports: [StockCatalogService, PharmacyCatalogService],
})
export class StockModule {}
