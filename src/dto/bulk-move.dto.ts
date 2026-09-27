import { Type } from 'class-transformer';
import {
  ArrayNotEmpty, ArrayUnique, IsArray, IsDefined, IsIn, IsISO8601, IsNotEmpty, IsNumber, IsObject,
  IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { SLUG, SLUG_MESSAGE } from '../common/utils';
import { STATUSES } from './create-opportunity.dto';

class ValueRangeDto {
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(999_999_999_999)
  min?: number;

  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(999_999_999_999)
  max?: number;
}

/** Both ends inclusive. A date-only `to` ("2026-03-31") includes that whole day (UTC). */
class CreatedRangeDto {
  @IsOptional() @IsISO8601({ strict: true })
  from?: string;

  @IsOptional() @IsISO8601({ strict: true })
  to?: string;
}

/** Every field is optional; the fields that are given are ANDed together. */
class BulkFilterDto {
  @IsOptional() @Matches(SLUG, { message: `stage ${SLUG_MESSAGE}` })
  stage?: string;

  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(100)
  owner?: string;

  @IsOptional() @IsArray() @ArrayNotEmpty() @ArrayUnique() @IsIn(STATUSES, { each: true })
  status?: string[];

  @IsOptional() @ValidateNested() @Type(() => ValueRangeDto)
  value?: ValueRangeDto;

  @IsOptional() @ValidateNested() @Type(() => CreatedRangeDto)
  created?: CreatedRangeDto;
}

export class BulkMoveDto {
  @IsDefined() @IsObject() @ValidateNested() @Type(() => BulkFilterDto)
  filter: BulkFilterDto;

  @Matches(SLUG, { message: `target_stage ${SLUG_MESSAGE}` })
  target_stage: string;
}
