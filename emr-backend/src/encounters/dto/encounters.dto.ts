import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min } from 'class-validator';

const num = ({ value }: { value: unknown }) => (typeof value === 'string' && value !== '' ? Number(value) : value);

export class WalkInDto {
  @IsUUID() patient_id: string;
  @IsUUID() doctor_id: string;
  @IsOptional() @IsUUID() department_id?: string;
  @IsOptional() @IsString() @MaxLength(2000) chief_complaint?: string;
}

export class UpdateClinicalDto {
  @IsOptional() @IsString() @MaxLength(10_000) chief_complaint?: string;
  @IsOptional() @IsString() @MaxLength(20_000) history_of_present_illness?: string;
  @IsOptional() @IsString() @MaxLength(20_000) objective_status?: string;
}

export class PaymentDto {
  @Transform(num) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(9_999_999) amount: number;
  @IsIn(['cash', 'card_terminal', 'bank_transfer']) method: 'cash' | 'card_terminal' | 'bank_transfer';
  @IsOptional() @IsString() @MaxLength(100) terminal_ref?: string;
}

export class OverrideDto {
  @IsString() @Length(5, 1000) reason: string;
}

export class VitalsDto {
  @IsOptional() @Type(() => Number) @IsInt() systolic_bp?: number;
  @IsOptional() @Type(() => Number) @IsInt() diastolic_bp?: number;
  @IsOptional() @Type(() => Number) @IsInt() heart_rate?: number;
  @IsOptional() @Type(() => Number) @IsInt() respiratory_rate?: number;
  @IsOptional() @Transform(num) @IsNumber({ maxDecimalPlaces: 1 }) temperature?: number;
  @IsOptional() @Type(() => Number) @IsInt() spo2?: number;
  @IsOptional() @Transform(num) @IsNumber({ maxDecimalPlaces: 2 }) weight_kg?: number;
  @IsOptional() @Transform(num) @IsNumber({ maxDecimalPlaces: 1 }) height_cm?: number;
}

export class DiagnosisDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase().replace(',', '.') : value))
  @Matches(/^[A-Z]\d{2}(\.\d{1,2})?$/, { message: 'ICD-10 კოდის ფორმატი: I21.0' }) icd10_code: string;
  @IsIn(['primary', 'secondary', 'complication', 'admission']) diagnosis_type: 'primary' | 'secondary' | 'complication' | 'admission';
  @IsOptional() @IsString() @MaxLength(2000) comment?: string;
}

export class PrescriptionDto {
  @IsString() @Length(2, 255) medication_name: string;
  @IsString() @Length(1, 100) dosage: string;
  @IsString() @Length(1, 50) route: string;
  @IsString() @Length(1, 50) frequency: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(365) duration_days?: number;
  @IsOptional() @IsString() @MaxLength(2000) instructions?: string;
}

export class ReferralDto {
  @IsIn(['lab', 'imaging', 'hospitalization', 'specialist_consult']) type: 'lab' | 'imaging' | 'hospitalization' | 'specialist_consult';
  @IsOptional() @IsUUID() target_department_id?: string;
  @IsString() @Length(3, 2000) reason: string;
}

export class UpdateReferralDto {
  @IsIn(['in_progress', 'completed', 'cancelled']) status: 'in_progress' | 'completed' | 'cancelled';
  @IsOptional() @IsString() @MaxLength(20_000) result_text?: string;
}

export class AdjustLineDto {
  @Transform(num) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(9_999_999) unit_price: number;
  @IsOptional() @IsString() @Length(3, 1000) discount_reason?: string;
}

/** საწყისი გადახდა: თუ პაციენტის წილი 0-ია (უფასო კონსულტაცია) — body შეიძლება ცარიელი იყოს */
export class PayInitialDto {
  @IsOptional() @Transform(num) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(9_999_999) amount?: number;
  @IsOptional() @IsIn(['cash', 'card_terminal', 'bank_transfer']) method?: 'cash' | 'card_terminal' | 'bank_transfer';
  @IsOptional() @IsString() @MaxLength(100) terminal_ref?: string;
}
