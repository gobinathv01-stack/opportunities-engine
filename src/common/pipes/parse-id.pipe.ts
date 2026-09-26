import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { ID_MESSAGE, ID_PATTERN } from '../id';

/** Validates a path id and keeps it a string, so a huge or imprecise number can't reach the database. */
@Injectable()
export class ParseIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!ID_PATTERN.test(value)) throw new BadRequestException(`id ${ID_MESSAGE}`);
    return value;
  }
}
