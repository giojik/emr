import { Module } from '@nestjs/common';
import { PharmacyCatalogController, PharmacyCatalogService } from './pharmacy-catalog';
import { StockDocsController, StockDocsService } from './stock-docs';
import { StockCatalogController, StockCatalogService } from './stock-catalog';

/** საწყობი + შიდა აფთიაქი: ნომენკლატურა, ლოკაციები, მომწოდებლები (0030); მოძრაობების ჟურნალი, ნაშთები, მიღება (0031) */
@Module({
  controllers: [StockCatalogController, PharmacyCatalogController, StockDocsController],
  providers: [StockCatalogService, PharmacyCatalogService, StockDocsService],
  exports: [StockCatalogService, PharmacyCatalogService, StockDocsService],
})
export class StockModule {}
