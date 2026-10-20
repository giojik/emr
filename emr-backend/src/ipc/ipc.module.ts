import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications';
import { IpcCatalogController, IpcCatalogService } from './ipc-catalog';
import { IpcCommon } from './ipc-common';
import { IpcIsolationController, IpcIsolationService } from './ipc-isolation';
import { IpcJobsService } from './ipc-jobs';
import { IpcFlagsController, IpcMdroService } from './ipc-mdro';

/** ინფექციის კონტროლი (0067–): იზოლაციის ეპიზოდები, კარის ნიშანი, MDRO წესები / ფლაგები, ცნობარები, worker */
@Module({
  imports: [NotificationsModule],
  controllers: [IpcIsolationController, IpcFlagsController, IpcCatalogController],
  providers: [IpcCommon, IpcIsolationService, IpcMdroService, IpcCatalogService, IpcJobsService],
  exports: [IpcCommon, IpcMdroService, IpcJobsService],
})
export class IpcModule {}
