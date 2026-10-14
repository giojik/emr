import { Module } from '@nestjs/common';
import { DrgConfigController, DrgConfigService } from './drg-config';
import { DrgReportsController, DrgReportsService } from './drg-reports';
import { DrgSimulateController, DrgSimulateService } from './drg-simulate';
import { DrgStaysController, DrgStaysService } from './drg-stays';

/** DRG (0055): კონფიგურაცია (სქემები, ვერსიები, ჯგუფები, სიები, CC, წესები) + შემთხვევის დაჯგუფება / დადასტურება; 0058 — CMI ანგარიში; 0059 — სიმულაცია */
@Module({
  providers: [DrgConfigService, DrgStaysService, DrgReportsService, DrgSimulateService],
  controllers: [DrgConfigController, DrgStaysController, DrgReportsController, DrgSimulateController],
  exports: [DrgConfigService],
})
export class DrgModule {}
