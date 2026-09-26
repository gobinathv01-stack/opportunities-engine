import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { config } from '../config/configuration';
import { Queryable } from '../interfaces/queryable';

@Injectable()
export class DatabaseService implements Queryable, OnModuleDestroy {
  private readonly pool = new Pool({ connectionString: config.databaseUrl, max: config.dbPoolMax });
  private readonly logger = new Logger(DatabaseService.name);

  constructor() {
    // An error on an idle pooled client would otherwise be an unhandled 'error' event and kill the process.
    this.pool.on('error', (err) => this.logger.error(`idle client error: ${err.message}`));
  }

  query<T extends QueryResultRow = any>(text: string, params: unknown[] = []): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, params);
  }

  /** Runs fn inside one transaction; rolls back if fn throws. */
  async tx<T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  onModuleDestroy() {
    return this.pool.end();
  }
}
