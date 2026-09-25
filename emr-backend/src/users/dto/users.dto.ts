import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min } from 'class-validator';
const ROLE_CODE = /^[a-z][a-z0-9_]{1,39}$/;

const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);
const LDAP_USER = /^[A-Za-z0-9._-]{1,64}$/;

export class CreateUserDto {
  @Transform(lower) @IsEmail() @MaxLength(150) email: string;
  @IsString() @Length(1, 100) first_name: string;
  @IsString() @Length(1, 100) last_name: string;
  @Matches(/^\d{11}$/, { message: 'პირადი ნომერი უნდა იყოს 11 ციფრი' }) personal_number: string;
  /** ძირითადი როლი (კოდი). თუ roles არ არის მითითებული — ერთადერთი როლი */
  @IsOptional() @Matches(ROLE_CODE) role?: string;
  /** ყველა როლი (კოდები); პირველი = ძირითადი, თუ role არ არის მითითებული */
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(10) @Matches(ROLE_CODE, { each: true }) roles?: string[];
  @IsOptional() @IsUUID() department_id?: string;
  @IsOptional() @IsString() @MaxLength(50) phone?: string;
  @IsOptional() @IsString() @MaxLength(100) specialty?: string;
  @IsOptional() @IsString() @MaxLength(50) license_number?: string;
  @IsOptional() @IsUUID() consultation_tariff_id?: string;
  @IsOptional() @IsBoolean() is_section_head?: boolean;
  @IsOptional() @IsIn(['local', 'ldap']) auth_provider?: 'local' | 'ldap';
  @IsOptional() @Transform(lower) @Matches(LDAP_USER, { message: 'დომენის სახელი: ლათინური ასოები, ციფრები, . _ -' }) ldap_username?: string;
}

export class UpdateUserDto {
  @IsOptional() @Transform(lower) @IsEmail() @MaxLength(150) email?: string;
  @IsOptional() @IsString() @Length(1, 100) first_name?: string;
  @IsOptional() @IsString() @Length(1, 100) last_name?: string;
  @IsOptional() @Matches(/^\d{11}$/) personal_number?: string;
  @IsOptional() @Matches(ROLE_CODE) role?: string;
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(10) @Matches(ROLE_CODE, { each: true }) roles?: string[];
  @IsOptional() @IsUUID() department_id?: string | null;
  @IsOptional() @IsString() @MaxLength(50) phone?: string | null;
  @IsOptional() @IsString() @MaxLength(100) specialty?: string | null;
  @IsOptional() @IsString() @MaxLength(50) license_number?: string | null;
  @IsOptional() @IsUUID() consultation_tariff_id?: string | null;
  @IsOptional() @IsBoolean() is_section_head?: boolean;
  @IsOptional() @Transform(lower) @Matches(LDAP_USER) ldap_username?: string;
}

export class ListUsersQuery {
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  /** როლის კოდი — მომხმარებლები, ვისაც ეს როლი აქვს (ნებისმიერი, არა მხოლოდ ძირითადი) */
  @IsOptional() @Matches(ROLE_CODE) role?: string;
  @IsOptional() @IsUUID() department_id?: string;
  @IsOptional() @Transform(({ value }) => value === 'true' ? true : value === 'false' ? false : value) @IsBoolean() active?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number = 50;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number = 0;
}
