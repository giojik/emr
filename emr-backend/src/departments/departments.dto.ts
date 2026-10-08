import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, Length, Matches } from 'class-validator';

export const CARE_LEVELS = ['ward', 'intensive', 'icu'] as const;
export const ICU_FEATURES = ['sheet', 'ventilation', 'infusions', 'sofa', 'apache', 'abg', 'bundles', 'icu_note', 'board'] as const;
export const DEPARTMENT_TYPES = ['inpatient', 'outpatient', 'diagnostic', 'administrative', 'or'] as const;   // or — საოპერაციო ბლოკი (0048)
export type DepartmentType = (typeof DEPARTMENT_TYPES)[number];

export class CreateDepartmentDto {
  @IsString() @Length(2, 150) name: string;
  @Matches(/^[A-Z0-9_]{2,50}$/, { message: 'კოდი: დიდი ლათინური ასოები, ციფრები, _ (მაგ. CARDIO)' }) code: string;
  @IsIn(DEPARTMENT_TYPES) type: DepartmentType;
  // 0047: რეანიმაცია / ინტენსიური
  @IsOptional() @IsIn(CARE_LEVELS) care_level?: (typeof CARE_LEVELS)[number];
  @IsOptional() @IsArray() @ArrayMaxSize(9) @IsIn(ICU_FEATURES, { each: true }) icu_features?: string[] | null;
  @IsOptional() @IsIn([15, 30, 60, null]) monitor_interval_min?: 15 | 30 | 60 | null;
}

export class UpdateDepartmentDto {
  @IsOptional() @IsString() @Length(2, 150) name?: string;
  @IsOptional() @IsIn(DEPARTMENT_TYPES) type?: DepartmentType;
  @IsOptional() @IsBoolean() is_active?: boolean;
  // 0047: რეანიმაცია / ინტენსიური — დონე, ფუნქციები (null — დონის ნაგულისხმევი), ფურცლის ინტერვალი (null — მოდულის)
  @IsOptional() @IsIn(CARE_LEVELS) care_level?: (typeof CARE_LEVELS)[number];
  @IsOptional() @IsArray() @ArrayMaxSize(9) @IsIn(ICU_FEATURES, { each: true }) icu_features?: string[] | null;
  @IsOptional() @IsIn([15, 30, 60, null]) monitor_interval_min?: 15 | 30 | 60 | null;
  // code განზრახ არ იცვლება — გარე სისტემები (SSA, რეპორტები) მასზე შეიძლება იყოს მიბმული
}
