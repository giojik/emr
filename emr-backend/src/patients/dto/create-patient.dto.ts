import { PartialType } from '@nestjs/mapped-types';
import { IsIn, IsISO8601, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import type { GenderType } from '../../database/db';

export class CreatePatientDto {
  @IsOptional() @Matches(/^\d{11}$/, { message: 'პირადი ნომერი უნდა იყოს 11 ციფრი' })
  personal_number?: string;

  @IsOptional() @IsString() @Length(3, 50)
  passport_number?: string;

  @IsOptional() @Matches(/^[A-Z]{3}$/, { message: 'მოქალაქეობა: ISO 3166-1 alpha-3 (მაგ. GEO)' })
  citizenship?: string;

  @IsString() @Length(1, 100) first_name: string;
  @IsString() @Length(1, 100) last_name: string;

  @IsISO8601({ strict: true }) @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'თარიღი: YYYY-MM-DD' })
  birth_date: string;

  @IsIn(['male', 'female', 'other']) gender: GenderType;

  @IsString() @Length(5, 50) phone_number: string;

  @IsOptional() @IsString() @MaxLength(5) blood_group?: string;
  @IsOptional() @IsString() @MaxLength(150) emergency_contact_name?: string;
  @IsOptional() @IsString() @MaxLength(50) emergency_contact_phone?: string;
  @IsOptional() @IsString() @MaxLength(500) address?: string;          // აეწყობა ავტომატურად, თუ სტრუქტურირებულია

  // სტრუქტურირებული მისამართი
  @IsOptional() @IsString() @MaxLength(40) address_unit_code?: string;      // ქალაქი / მუნიციპალიტეტი
  @IsOptional() @IsString() @MaxLength(40) address_district_code?: string;  // თბილისის რაიონი
  @IsOptional() @IsString() @MaxLength(150) address_village?: string;
  @IsOptional() @IsString() @MaxLength(300) address_line?: string;
  @IsOptional() @Matches(/^[A-Z]{3}$/) address_country?: string;
}

/** დემოგრაფიის განახლება — პირადი ნომერი და დაბადების თარიღი რეგისტრაციის შემდეგაც შეიძლება გასწორდეს (აუდიტით) */
export class UpdatePatientDto extends PartialType(CreatePatientDto) {}
