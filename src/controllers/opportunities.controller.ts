import { Body, Controller, Get, HttpCode, Logger, Param, Post, Query } from '@nestjs/common';
import { WorkspaceId } from '../common/decorators/workspace-id.decorator';
import { ParseIdPipe } from '../common/pipes/parse-id.pipe';
import { CreateOpportunityDto } from '../dto/create-opportunity.dto';
import { ListOpportunitiesQuery } from '../dto/list-opportunities.query';
import { MoveOpportunityDto } from '../dto/move-opportunity.dto';
import { OpportunitiesService } from '../services/opportunities.service';

@Controller('opportunities')
export class OpportunitiesController {
  private readonly logger = new Logger(OpportunitiesController.name);

  constructor(private readonly service: OpportunitiesService) {}

  @Post()
  async create(@WorkspaceId() workspaceId: string, @Body() dto: CreateOpportunityDto) {
    const opp = await this.service.create(workspaceId, dto);
    this.logger.log(`opportunity ${opp.id} created in ${dto.stage} (workspace ${workspaceId})`);
    return opp;
  }

  @Post(':id/move')
  @HttpCode(200)
  async move(@WorkspaceId() workspaceId: string, @Param('id', ParseIdPipe) id: string, @Body() dto: MoveOpportunityDto) {
    const opp = await this.service.move(workspaceId, id, dto.stage);
    this.logger.log(`opportunity ${id} moved to ${dto.stage} (workspace ${workspaceId})`);
    return opp;
  }

  @Get()
  list(@WorkspaceId() workspaceId: string, @Query() query: ListOpportunitiesQuery) {
    return this.service.listByStage(workspaceId, query.stage, query.limit, query.cursor);
  }
}
