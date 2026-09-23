import { Module } from '@nestjs/common';
import { AllergiesModule } from '../allergies/allergies';
import { ClinicalService } from './clinical.service';
import { EncounterCoreService } from './encounter-core.service';
import { EncountersController, ReferralsController } from './encounters.controller';
import { EncountersService } from './encounters.service';

@Module({
  imports: [AllergiesModule],
  controllers: [EncountersController, ReferralsController],
  providers: [EncounterCoreService, EncountersService, ClinicalService],
  exports: [EncounterCoreService, EncountersService],
})
export class EncountersModule {}
