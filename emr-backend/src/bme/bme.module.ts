import { Module } from '@nestjs/common';
import { NotifyModule } from '../notify/notify.service';
import { BmeController, BmeService } from './bme';
import { PmController, PmService } from './bme-pm';
import { BmePmJobsService } from './bme-pm-jobs';

/** ბიომედ-აპარატურა: 0073 — რეესტრი / სტატუსი / გადაადგილება; 0074 — PM / კალიბრაცია / ელ. უსაფრთხოება (PmService იყენებს BmeService-ის სტატუსის ცვლილებას) */
@Module({ imports: [NotifyModule], controllers: [BmeController, PmController], providers: [BmeService, PmService, BmePmJobsService] })
export class BmeModule {}
