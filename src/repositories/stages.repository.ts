import { Injectable } from '@nestjs/common';
import { Queryable } from '../interfaces/queryable';
import { DatabaseService } from '../services/database.service';

@Injectable()
export class StagesRepository {
  constructor(private readonly db: DatabaseService) {}

  /** Resolves a readable stage key to its surrogate key, or null if the workspace has no such stage. */
  async findSk(workspaceId: string, key: string, q: Queryable = this.db): Promise<number | null> {
    const { rows } = await q.query<{ sk: number }>(`SELECT sk FROM stages WHERE workspace_id = $1 AND key = $2`, [workspaceId, key]);
    return rows[0]?.sk ?? null;
  }
}
