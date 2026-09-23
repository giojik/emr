import { IsBoolean, IsIn, IsOptional, IsString, Length, Matches } from 'class-validator';

export const DEPARTMENT_TYPES = ['inpatient', 'outpatient', 'diagnostic', 'administrative'] as const;
export type DepartmentType = (typeof DEPARTMENT_TYPES)[number];

export class CreateDepartmentDto {
  @IsString() @Length(2, 150) name: string;
  @Matches(/^[A-Z0-9_]{2,50}$/, { message: 'კოდი: დიდი ლათინური ასოები, ციფრები, _ (მაგ. CARDIO)' }) code: string;
  @IsIn(DEPARTMENT_TYPES) type: DepartmentType;
}

export class UpdateDepartmentDto {
  @IsOptional() @IsString() @Length(2, 150) name?: string;
  @IsOptional() @IsIn(DEPARTMENT_TYPES) type?: DepartmentType;
  @IsOptional() @IsBoolean() is_active?: boolean;
  // code განზრახ არ იცვლება — გარე სისტემები (SSA, რეპორტები) მასზე შეიძლება იყოს მიბმული
}
