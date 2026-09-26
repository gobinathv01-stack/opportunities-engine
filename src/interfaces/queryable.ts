import { QueryResult, QueryResultRow } from 'pg';

/**
 * Anything that can run a query: the pool, or a client inside a transaction.
 * Repositories accept one, so a service decides which statements share a transaction.
 */
export interface Queryable {
  query<T extends QueryResultRow = any>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}
