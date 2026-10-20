import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications';
import { QmAnalysisController, QmAnalysisService } from './quality-analysis';
import { QmCapaController, QmCapaService } from './quality-capa';
import { QmCatalogController, QmCatalogService } from './quality-catalog';
import { QmCommon } from './quality-common';
import { QmIncidentsController, QmIncidentsService } from './quality-incidents';
import { QmIndicatorsController, QmIndicatorsService } from './quality-indicators';
import { QmJobsService } from './quality-jobs';
import { QmReportsController, QmReportsService } from './quality-reports';
import { QmSources } from './quality-sources';

/** ხარისხი და ინციდენტები (0064–0066): შეტყობინება, რეესტრი, ტრიაჟი, ცნობარები, შეთავაზებები; გამოძიება, ანალიზი / RCA, CAPA, ინფორმირება, დახურვა; ვადები (worker);
 *  ანგარიშები, ინდიკატორები, ექსპორტი (0066; QmReportsService — მენეჯერული ანგარიშის სექციაც) */
@Module({
  imports: [NotificationsModule],
  controllers: [QmIncidentsController, QmCatalogController, QmAnalysisController, QmCapaController, QmReportsController, QmIndicatorsController],
  providers: [QmCommon, QmSources, QmIncidentsService, QmCatalogService, QmAnalysisService, QmCapaService, QmJobsService, QmReportsService, QmIndicatorsService],
  exports: [QmCommon, QmJobsService, QmReportsService],
})
export class QualityModule {}
