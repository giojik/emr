import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications';
import { QmCatalogController, QmCatalogService } from './quality-catalog';
import { QmCommon } from './quality-common';
import { QmIncidentsController, QmIncidentsService } from './quality-incidents';
import { QmJobsService } from './quality-jobs';
import { QmSources } from './quality-sources';

/** ხარისხი და ინციდენტები (0064): შეტყობინება, რეესტრი, ტრიაჟი, ცნობარები, შეთავაზებები, ვადის შეხსენება (worker) */
@Module({
  imports: [NotificationsModule],
  controllers: [QmIncidentsController, QmCatalogController],
  providers: [QmCommon, QmSources, QmIncidentsService, QmCatalogService, QmJobsService],
  exports: [QmCommon, QmJobsService],
})
export class QualityModule {}
