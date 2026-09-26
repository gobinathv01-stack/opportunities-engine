import { Matches } from 'class-validator';
import { SLUG, SLUG_MESSAGE } from '../common/slug';

export class MoveOpportunityDto {
  @Matches(SLUG, { message: `stage ${SLUG_MESSAGE}` })
  stage: string;
}
