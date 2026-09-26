import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { WorkspaceId } from '../common/decorators/workspace-id.decorator';
import { ParseIdPipe } from '../common/pipes/parse-id.pipe';
import { CreateOpportunityDto } from '../dto/create-opportunity.dto';
import { ListOpportunitiesQuery } from '../dto/list-opportunities.query';
import { MoveOpportunityDto } from '../dto/move-opportunity.dto';
import { OpportunitiesService } from '../services/opportunities.service';

@Controller('opportunities')
export class OpportunitiesController {
  constructor(private readonly service: OpportunitiesService) {}

  @Post()
  create(@WorkspaceId() workspaceId: string, @Body() dto: CreateOpportunityDto) {
    return this.service.create(workspaceId, dto);
  }

  @Post(':id/move')
  @HttpCode(200)
  move(@WorkspaceId() workspaceId: string, @Param('id', ParseIdPipe) id: string, @Body() dto: MoveOpportunityDto) {
    return this.service.move(workspaceId, id, dto.stage);
  }

  @Get()
  list(@WorkspaceId() workspaceId: string, @Query() query: ListOpportunitiesQuery) {
    return this.service.listByStage(workspaceId, query.stage, query.limit, query.cursor);
  }
}
