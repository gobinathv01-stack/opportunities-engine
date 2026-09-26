import { Injectable } from '@nestjs/common';
import { Queryable } from '../interfaces/queryable';
import { DatabaseService } from '../services/database.service';

export interface NewTransition {
  workspaceId: string;
  opportunityId: string;
  fromStageSk: number;
  toStageSk: number;
  source: 'manual' | 'bulk';
}

@Injectable()
export class TransitionsRepository {
  constructor(private readonly db: DatabaseService) {}

  async record(t: NewTransition, q: Queryable = this.db): Promise<void> {
    await q.query(
      `INSERT INTO transitions (workspace_id, opportunity_id, from_stage_sk, to_stage_sk, source)
       VALUES ($1, $2, $3, $4, $5)`,
      [t.workspaceId, t.opportunityId, t.fromStageSk, t.toStageSk, t.source],
    );
  }
}
