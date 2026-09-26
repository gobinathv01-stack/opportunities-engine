import { Transform } from 'class-transformer';
import { IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { SLUG, SLUG_MESSAGE } from '../common/slug';
import { OpportunityStatus } from '../entities/opportunity.entity';

export const STATUSES: OpportunityStatus[] = ['open', 'won', 'lost', 'abandoned'];

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateOpportunityDto {
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(200)
  name: string;

  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(999_999_999_999)
  value: number;

  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(100)
  owner_id: string;

  @Matches(SLUG, { message: `stage ${SLUG_MESSAGE}` })
  stage: string;

  @IsOptional() @IsIn(STATUSES)
  status?: OpportunityStatus;
}
