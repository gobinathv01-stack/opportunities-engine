import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { CreateOpportunityDto } from '../dto/create-opportunity.dto';
import { Opportunity } from '../entities/opportunity.entity';
import { OpportunitiesRepository } from '../repositories/opportunities.repository';
import { StagesRepository } from '../repositories/stages.repository';
import { TransitionsRepository } from '../repositories/transitions.repository';
import { DatabaseService } from './database.service';

const DEFAULT_PAGE_SIZE = 50;
const NO_SUCH_STAGE = 'stage does not exist in this workspace';

/** Business rules and transaction boundaries; no SQL here. Clients speak stage keys, storage speaks stage_sk. */
@Injectable()
export class OpportunitiesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly opportunities: OpportunitiesRepository,
    private readonly stages: StagesRepository,
    private readonly transitions: TransitionsRepository,
  ) {}

  async create(workspaceId: string, dto: CreateOpportunityDto): Promise<Opportunity> {
    const stageSk = await this.stages.findSk(workspaceId, dto.stage);
    if (stageSk === null) throw new UnprocessableEntityException(NO_SUCH_STAGE);
    return this.opportunities.create({
      workspaceId,
      stageSk,
      name: dto.name,
      value: dto.value,
      status: dto.status ?? 'open',
      ownerId: dto.owner_id,
    });
  }

  /** Moves one opportunity and records the transition, atomically. */
  move(workspaceId: string, id: string, toStage: string): Promise<Opportunity> {
    return this.db.tx(async (tx) => {
      const fromStageSk = await this.opportunities.lockCurrentStageSk(workspaceId, id, tx);
      if (fromStageSk === null) throw new NotFoundException('opportunity not found');
      const toStageSk = await this.stages.findSk(workspaceId, toStage, tx);
      if (toStageSk === null) throw new UnprocessableEntityException(NO_SUCH_STAGE);
      if (fromStageSk === toStageSk) throw new ConflictException('opportunity is already in that stage');

      const moved = await this.opportunities.updateStage(workspaceId, id, toStageSk, tx);
      await this.transitions.record({ workspaceId, opportunityId: id, fromStageSk, toStageSk, source: 'manual' }, tx);
      return moved;
    });
  }

  async listByStage(workspaceId: string, stage: string, limit = DEFAULT_PAGE_SIZE, cursor = '0') {
    const stageSk = await this.stages.findSk(workspaceId, stage);
    if (stageSk === null) return { items: [], next_cursor: null };
    // Fetch one extra row: it tells us whether another page exists without a second query.
    const rows = await this.opportunities.listByStage(workspaceId, stageSk, cursor, limit + 1);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return { items, next_cursor: hasMore ? items[items.length - 1].id : null };
  }
}
