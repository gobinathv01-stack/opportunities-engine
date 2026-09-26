import { Type } from 'class-transformer';
import { IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { ID_MESSAGE, ID_PATTERN } from '../common/id';
import { SLUG, SLUG_MESSAGE } from '../common/slug';

export class ListOpportunitiesQuery {
  @Matches(SLUG, { message: `stage ${SLUG_MESSAGE}` })
  stage: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  limit?: number;

  /** Keyset cursor: the id of the last item of the previous page. */
  @IsOptional() @Matches(ID_PATTERN, { message: `cursor ${ID_MESSAGE}` })
  cursor?: string;
}
