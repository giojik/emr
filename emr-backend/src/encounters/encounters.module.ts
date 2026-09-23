import { Module } from '@nestjs/common';
import { ClinicalService } from './clinical.service';
import { EncounterCoreService } from './encounter-core.service';
import { EncountersController, ReferralsController } from './encounters.controller';
import { EncountersService } from './encounters.service';

@Module({
  controllers: [EncountersController, ReferralsController],
  providers: [EncounterCoreService, EncountersService, ClinicalService],
  exports: [EncounterCoreService, EncountersService],
})
export class EncountersModule {}
