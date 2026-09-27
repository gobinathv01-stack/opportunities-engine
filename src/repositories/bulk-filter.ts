import { CanonicalRequest, createdBounds } from '../common/bulk-request';

export interface FilterCriteria {
  stageSk?: number;
  owner?: string;
  status?: string[];
  valueMin?: number;
  valueMax?: number;
  createdFrom?: Date | null;
  createdToExclusive?: Date | null;
}

/** The stored canonical filter, with its stage key already resolved to `stageSk`, as SQL criteria. */
export function criteriaFrom(filter: CanonicalRequest['filter'], stageSk?: number): FilterCriteria {
  const bounds = createdBounds(filter.created);
  return {
    stageSk,
    owner: filter.owner,
    status: filter.status,
    valueMin: filter.value?.min,
    valueMax: filter.value?.max,
    createdFrom: bounds.from,
    createdToExclusive: bounds.toExclusive,
  };
}

/** Turns the (already validated) filter into a parameterised WHERE fragment on alias `o`. */
export function buildFilterSql(c: FilterCriteria, firstParam: number): { sql: string; params: unknown[] } {
  const conds: string[] = [];
  const params: unknown[] = [];
  const add = (cond: (n: number) => string, value: unknown) => {
    params.push(value);
    conds.push(cond(firstParam + params.length - 1));
  };
  if (c.stageSk !== undefined) add((n) => `o.stage_sk = $${n}`, c.stageSk);
  if (c.owner !== undefined) add((n) => `o.owner_id = $${n}`, c.owner);
  if (c.status?.length) add((n) => `o.status = ANY($${n}::text[])`, c.status);
  if (c.valueMin !== undefined) add((n) => `o.value >= $${n}`, c.valueMin);
  if (c.valueMax !== undefined) add((n) => `o.value <= $${n}`, c.valueMax);
  if (c.createdFrom) add((n) => `o.created_at >= $${n}`, c.createdFrom);
  if (c.createdToExclusive) add((n) => `o.created_at < $${n}`, c.createdToExclusive);
  return { sql: conds.length ? conds.join(' AND ') : 'TRUE', params };
}
