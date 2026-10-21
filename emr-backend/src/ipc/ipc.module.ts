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
import { IpcAbxController, IpcAbxService } from './ipc-abx';
import { IpcAbgController, IpcAbgService } from './ipc-abg';
import { IpcMaterialsController, IpcMaterialsService } from './ipc-materials';

/** ინფექციის კონტროლი (0067–): იზოლაციის ეპიზოდები, კარის ნიშანი, MDRO წესები / ფლაგები, ცნობარები, worker; 0068: სიგნალები, HAI რეესტრი, device-days; 0069: SSI; 0070: ანტიბიოტიკები; 0071: ანტიბიოგრამა, მასალები */
@Module({
  imports: [NotificationsModule],
  controllers: [IpcIsolationController, IpcFlagsController, IpcCatalogController, IpcSignalsController, IpcHaiController, IpcDeviceDaysController, IpcSsiController, IpcAbxController, IpcAbgController, IpcMaterialsController],
  providers: [IpcCommon, IpcIsolationService, IpcMdroService, IpcCatalogService, IpcJobsService, IpcSignalsService, IpcHaiService, IpcDeviceDaysService, IpcSsiService, IpcAbxService, IpcAbgService, IpcMaterialsService],
  exports: [IpcCommon, IpcMdroService, IpcJobsService],
})
export class IpcModule {}
