import { Matches } from 'class-validator';
import { SLUG, SLUG_MESSAGE } from '../common/utils';

export class MoveOpportunityDto {
  @Matches(SLUG, { message: `stage ${SLUG_MESSAGE}` })
  stage: string;
}
