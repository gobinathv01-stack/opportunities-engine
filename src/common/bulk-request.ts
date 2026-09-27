import { createHash } from 'crypto';
import { BadRequestException } from '@nestjs/common';
import { BulkMoveDto } from '../dto/bulk-move.dto';

export interface CanonicalRequest {
  filter: {
    stage?: string;
    owner?: string;
    status?: string[];
    value?: { min?: number; max?: number };
    created?: { from?: string; to?: string };
  };
  target_stage: string;
}

/**
 * The request in one fixed shape: absent/empty fields dropped, statuses de-duplicated
 * and sorted, keys in a fixed order. Two requests that ask for the same thing always
 * canonicalize identically, so their hash is a reliable "same request" test.
 */
export function canonicalize(dto: BulkMoveDto): CanonicalRequest {
  const f = dto.filter;
  const filter: CanonicalRequest['filter'] = {};
  if (f.stage) filter.stage = f.stage;
  if (f.owner) filter.owner = f.owner;
  if (f.status?.length) filter.status = [...new Set(f.status)].sort();
  if (f.value && (f.value.min !== undefined || f.value.max !== undefined)) {
    filter.value = {};
    if (f.value.min !== undefined) filter.value.min = f.value.min;
    if (f.value.max !== undefined) filter.value.max = f.value.max;
    if (filter.value.min !== undefined && filter.value.max !== undefined && filter.value.min > filter.value.max) {
      throw new BadRequestException('filter.value.min must not be greater than filter.value.max');
    }
  }
  if (f.created && (f.created.from || f.created.to)) {
    filter.created = {};
    if (f.created.from) filter.created.from = f.created.from;
    if (f.created.to) filter.created.to = f.created.to;
  }
  return { filter, target_stage: dto.target_stage };
}

export const hashRequest = (c: CanonicalRequest) => createHash('sha256').update(JSON.stringify(c)).digest('hex');

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** [from, toExclusive) in UTC; both ends of the user's range are inclusive. */
export function createdBounds(created?: { from?: string; to?: string }): { from: Date | null; toExclusive: Date | null } {
  const from = created?.from ? new Date(created.from) : null;
  let toExclusive: Date | null = null;
  if (created?.to) {
    const to = new Date(created.to);
    toExclusive = new Date(to.getTime() + (DATE_ONLY.test(created.to) ? 86_400_000 : 1));
  }
  if (from && toExclusive && from >= toExclusive) throw new BadRequestException('filter.created.from must not be after filter.created.to');
  return { from, toExclusive };
}
