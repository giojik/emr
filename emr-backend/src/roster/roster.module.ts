import { Module } from '@nestjs/common';
import { RosterController, RosterService } from './roster';
import { RosterSetupController, RosterSetupService } from './roster-setup';

/**
 * ცვლები და მორიგეობა: 0077 — თანამშრომლები / პოზიციები, ცვლის შაბლონები, დღესასწაულები, მორიგის როლები, განრიგი (მონახაზი → გამოქვეყნება),
 * წესები, შევსების ნორმა, როტაცია / კოპირება, „ვინ არის მორიგე“. RosterLookup (roster-common) — სხვა მოდულებისთვის (გლობალური).
 */
@Module({ controllers: [RosterSetupController, RosterController], providers: [RosterSetupService, RosterService] })
export class RosterModule {}
