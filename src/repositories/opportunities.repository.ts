import { Injectable } from '@nestjs/common';
import { Opportunity } from '../entities/opportunity.entity';
import { Queryable } from '../interfaces/queryable';
import { DatabaseService } from '../services/database.service';


const COLUMNS = `o.id::text AS id, o.workspace_id, s.key AS stage, o.name, o.value::float8 AS value,
                 o.status, o.owner_id, o.version, o.created_at, o.updated_at`;
const WITH_STAGE_KEY = (source: string) => `SELECT ${COLUMNS} FROM ${source} o JOIN stages s ON s.sk = o.stage_sk`;

export interface NewOpportunity {
  workspaceId: string;
  stageSk: number;
  name: string;
  value: number;
  status: string;
  ownerId: string;
}

/** All SQL for opportunities lives here */
@Injectable()
export class OpportunitiesRepository {
  constructor(private readonly db: DatabaseService) {}

  async create(o: NewOpportunity, q: Queryable = this.db): Promise<Opportunity> {
    const { rows } = await q.query<Opportunity>(
      `WITH ins AS (
         INSERT INTO opportunities (workspace_id, stage_sk, name, value, status, owner_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
       ) ${WITH_STAGE_KEY('ins')}`,
      [o.workspaceId, o.stageSk, o.name, o.value, o.status, o.ownerId],
    );
    return rows[0];
  }

  /** Locks the row (FOR UPDATE) so concurrent writers, serialise on it. Returns its stage_sk. */
  async lockCurrentStageSk(workspaceId: string, id: string, q: Queryable = this.db): Promise<number | null> {
    const { rows } = await q.query<{ stage_sk: number }>(
      `SELECT stage_sk FROM opportunities WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
      [id, workspaceId],
    );
    return rows[0]?.stage_sk ?? null;
  }

  async updateStage(workspaceId: string, id: string, stageSk: number, q: Queryable = this.db): Promise<Opportunity> {
    const { rows } = await q.query<Opportunity>(
      `WITH upd AS (
         UPDATE opportunities SET stage_sk = $3, version = version + 1, updated_at = now()
          WHERE id = $1 AND workspace_id = $2 RETURNING *
       ) ${WITH_STAGE_KEY('upd')}`,
      [id, workspaceId, stageSk],
    );
    return rows[0];
  }

  async listByStage(workspaceId: string, stageSk: number, afterId: string, limit: number, q: Queryable = this.db): Promise<Opportunity[]> {
    const { rows } = await q.query<Opportunity>(
      `${WITH_STAGE_KEY('opportunities')}
        WHERE o.workspace_id = $1 AND o.stage_sk = $2 AND o.id > $3
        ORDER BY o.id LIMIT $4`,
      [workspaceId, stageSk, afterId, limit],
    );
    return rows;
  }
}
