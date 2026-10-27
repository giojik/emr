import { Module } from '@nestjs/common';
import { RosterController, RosterService } from './roster';
import { AbsenceController, AbsenceService } from './roster-absence';
import { RosterFlowsController, RosterFlowsService } from './roster-flows';
import { RosterSetupController, RosterSetupService } from './roster-setup';
import { TimesheetController, TimesheetService } from './roster-timesheet';

/**
 * ცვლები და მორიგეობა: 0077 — თანამშრომლები / პოზიციები, ცვლის შაბლონები, დღესასწაულები, მორიგის როლები, განრიგი (მონახაზი → გამოქვეყნება),
 * წესები, შევსების ნორმა, როტაცია / კოპირება, „ვინ არის მორიგე“. RosterLookup (roster-common) — სხვა მოდულებისთვის (გლობალური).
 * 0078 — არყოფნა / ბალანსი (AbsenceService), დასაფარი / გაცვლა / ჩანაცვლება / სურვილები / „დასადასტურებელი“ (RosterFlowsService).
 * 0079 — ფაქტი / ტაბელი / ზეგანაკვეთი / თვის დახურვა / HR ექსპორტი / კავშირების lookup (TimesheetService).
 */
@Module({
  controllers: [RosterSetupController, RosterController, AbsenceController, RosterFlowsController, TimesheetController],
  providers: [RosterSetupService, RosterService, AbsenceService, RosterFlowsService, TimesheetService],
})
export class RosterModule {}
