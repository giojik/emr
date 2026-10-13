import { Module } from '@nestjs/common';
import { DrgConfigController, DrgConfigService } from './drg-config';
import { DrgStaysController, DrgStaysService } from './drg-stays';

/** DRG (0055): კონფიგურაცია (სქემები, ვერსიები, ჯგუფები, სიები, CC, წესები) + შემთხვევის დაჯგუფება / დადასტურება */
@Module({ providers: [DrgConfigService, DrgStaysService], controllers: [DrgConfigController, DrgStaysController] })
export class DrgModule {}
