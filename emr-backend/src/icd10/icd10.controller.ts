import { Controller, DefaultValuePipe, Get, Param, ParseBoolPipe, ParseIntPipe, Query } from '@nestjs/common';
import { Icd10Service } from './icd10.service';

/** კლასიფიკატორი — ხელმისაწვდომია ყველა ავტორიზებული მომხმარებლისთვის, მხოლოდ წაკითხვა */
@Controller('icd10')
export class Icd10Controller {
  constructor(private readonly icd: Icd10Service) {}

  @Get()
  search(@Query('search') search = '',
         @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
         @Query('primary', new DefaultValuePipe(false), ParseBoolPipe) primary: boolean) {
    return this.icd.search(search, Math.min(Math.max(limit, 1), 50), primary);
  }

  @Get('chapters') chapters() { return this.icd.chapters(); }

  @Get(':code') get(@Param('code') code: string) { return this.icd.get(code); }
}
