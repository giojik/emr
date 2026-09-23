import { IsIn, IsOptional, IsString, Length, MaxLength } from 'class-validator';

/** ექიმის მიერ შევსებული/შესწორებული ველები; გამოტოვებული — EMR-იდან ავტომატურად (draft) */
export class IssueForm100Dto {
  @IsOptional() @IsString() @MaxLength(500) recipient?: string;              // პ.2
  @IsOptional() @IsString() @MaxLength(500) workplace?: string;              // პ.7
  @IsOptional() @IsIn(['healthy', 'practically_healthy']) conclusion?: 'healthy' | 'practically_healthy';  // პ.9
  @IsOptional() @IsString() @MaxLength(2000) diagnosis_note?: string;        // პ.9 დამატებითი ფორმულირება
  @IsOptional() @IsString() @MaxLength(5000) past_diseases?: string;         // პ.10
  @IsOptional() @IsString() @MaxLength(10000) anamnesis?: string;            // პ.11
  @IsOptional() @IsString() @MaxLength(10000) investigations?: string;       // პ.12
  @IsOptional() @IsIn(['acute', 'subacute', 'chronic', 'recurrent']) course?: 'acute' | 'subacute' | 'chronic' | 'recurrent'; // პ.13
  @IsOptional() @IsString() @MaxLength(10000) treatment?: string;            // პ.14
  @IsOptional() @IsString() @MaxLength(5000) recommendations?: string;       // პ.17
}

export class RevokeDocumentDto {
  @IsString() @Length(5, 1000) reason: string;
}
