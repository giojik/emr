import { Module } from '@nestjs/common';
import { ClinicSettingsModule } from '../settings/clinic-settings';
import { DocumentsController, PublicVerifyController } from './documents.controller';
import { DocumentsService } from './documents.service';

@Module({ imports: [ClinicSettingsModule], controllers: [DocumentsController, PublicVerifyController], providers: [DocumentsService] })
export class DocumentsModule {}
