import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications';
import { QmAnalysisController, QmAnalysisService } from './quality-analysis';
import { QmCapaController, QmCapaService } from './quality-capa';
import { QmCatalogController, QmCatalogService } from './quality-catalog';
import { QmCommon } from './quality-common';
import { QmIncidentsController, QmIncidentsService } from './quality-incidents';
import { QmJobsService } from './quality-jobs';
import { QmSources } from './quality-sources';

/** ხარისხი და ინციდენტები (0064–0065): შეტყობინება, რეესტრი, ტრიაჟი, ცნობარები, შეთავაზებები; გამოძიება, ანალიზი / RCA, CAPA, ინფორმირება, დახურვა; ვადები (worker) */
@Module({
  imports: [NotificationsModule],
  controllers: [QmIncidentsController, QmCatalogController, QmAnalysisController, QmCapaController],
  providers: [QmCommon, QmSources, QmIncidentsService, QmCatalogService, QmAnalysisService, QmCapaService, QmJobsService],
  exports: [QmCommon, QmJobsService],
})
export class QualityModule {}
