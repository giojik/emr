import { Module } from '@nestjs/common';
import { NotifyModule } from '../notify/notify.service';
import { BmeController, BmeService } from './bme';
import { ContractController, ContractService } from './bme-contracts';
import { PmController, PmService } from './bme-pm';
import { BmePmJobsService } from './bme-pm-jobs';
import { RepairController, RepairService } from './bme-repair';
import { BmeRepairJobsService } from './bme-repair-jobs';

/**
 * ბიომედ-აპარატურა: 0073 — რეესტრი / სტატუსი / გადაადგილება; 0074 — PM / კალიბრაცია / ელ. უსაფრთხოება (PmService იყენებს BmeService-ის სტატუსის ცვლილებას);
 * 0075 — შეკეთების ორდერი (RepairService → BmeService, PmService), სერვისის კონტრაქტები / SLA / გარანტია.
 */
@Module({ imports: [NotifyModule], controllers: [BmeController, PmController, RepairController, ContractController],
  providers: [BmeService, PmService, BmePmJobsService, RepairService, ContractService, BmeRepairJobsService] })
export class BmeModule {}
