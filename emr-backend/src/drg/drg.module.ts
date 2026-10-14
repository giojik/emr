import { Module } from '@nestjs/common';
import { DrgConfigController, DrgConfigService } from './drg-config';
import { DrgReportsController, DrgReportsService } from './drg-reports';
import { DrgStaysController, DrgStaysService } from './drg-stays';

/** DRG (0055): კონფიგურაცია (სქემები, ვერსიები, ჯგუფები, სიები, CC, წესები) + შემთხვევის დაჯგუფება / დადასტურება; 0058 — CMI ანგარიში */
@Module({ providers: [DrgConfigService, DrgStaysService, DrgReportsService], controllers: [DrgConfigController, DrgStaysController, DrgReportsController] })
export class DrgModule {}
