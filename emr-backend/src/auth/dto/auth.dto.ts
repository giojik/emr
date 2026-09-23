import { IsString, Length } from 'class-validator';

export class LoginDto {
  /** ელ-ფოსტა (ლოკალური ანგარიში) ან დომენის სახელი (მაგ. giojik) */
  @IsString() @Length(1, 150) username: string;
  @IsString() @Length(1, 256) password: string;
}

export class ChangePasswordDto {
  @IsString() @Length(1, 256) currentPassword: string;
  @IsString() @Length(1, 256) newPassword: string;
}
