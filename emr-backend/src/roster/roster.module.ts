import { Module } from '@nestjs/common';
import { RosterController, RosterService } from './roster';
import { AbsenceController, AbsenceService } from './roster-absence';
import { RosterFlowsController, RosterFlowsService } from './roster-flows';
import { RosterSetupController, RosterSetupService } from './roster-setup';

/**
 * ცვლები და მორიგეობა: 0077 — თანამშრომლები / პოზიციები, ცვლის შაბლონები, დღესასწაულები, მორიგის როლები, განრიგი (მონახაზი → გამოქვეყნება),
 * წესები, შევსების ნორმა, როტაცია / კოპირება, „ვინ არის მორიგე“. RosterLookup (roster-common) — სხვა მოდულებისთვის (გლობალური).
 * 0078 — არყოფნა / ბალანსი (AbsenceService), დასაფარი / გაცვლა / ჩანაცვლება / სურვილები / „დასადასტურებელი“ (RosterFlowsService).
 */
@Module({
  controllers: [RosterSetupController, RosterController, AbsenceController, RosterFlowsController],
  providers: [RosterSetupService, RosterService, AbsenceService, RosterFlowsService],
})
export class RosterModule {}
