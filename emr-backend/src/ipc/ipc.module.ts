import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications';
import { IpcCatalogController, IpcCatalogService } from './ipc-catalog';
import { IpcCommon } from './ipc-common';
import { IpcIsolationController, IpcIsolationService } from './ipc-isolation';
import { IpcJobsService } from './ipc-jobs';
import { IpcFlagsController, IpcMdroService } from './ipc-mdro';
import { IpcDeviceDaysController, IpcDeviceDaysService } from './ipc-device-days';
import { IpcHaiController, IpcHaiService } from './ipc-hai';
import { IpcSignalsController, IpcSignalsService } from './ipc-signals';
import { IpcSsiController, IpcSsiService } from './ipc-ssi';

/** ინფექციის კონტროლი (0067–): იზოლაციის ეპიზოდები, კარის ნიშანი, MDRO წესები / ფლაგები, ცნობარები, worker; 0068: სიგნალები, HAI რეესტრი, device-days; 0069: SSI */
@Module({
  imports: [NotificationsModule],
  controllers: [IpcIsolationController, IpcFlagsController, IpcCatalogController, IpcSignalsController, IpcHaiController, IpcDeviceDaysController, IpcSsiController],
  providers: [IpcCommon, IpcIsolationService, IpcMdroService, IpcCatalogService, IpcJobsService, IpcSignalsService, IpcHaiService, IpcDeviceDaysService, IpcSsiService],
  exports: [IpcCommon, IpcMdroService, IpcJobsService],
})
export class IpcModule {}
