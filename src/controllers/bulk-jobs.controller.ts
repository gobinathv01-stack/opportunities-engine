import { Body, Controller, Get, HttpCode, Logger, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { IdempotencyKey } from '../common/decorators/idempotency-key.decorator';
import { WorkspaceId } from '../common/decorators/workspace-id.decorator';
import { BulkMoveDto } from '../dto/bulk-move.dto';
import { BulkJobsService } from '../services/bulk-jobs.service';

/** HTTP only: submit returns immediately with a job handle; the work happens in the worker process. */
@Controller('bulk-moves')
export class BulkJobsController {
  private readonly logger = new Logger(BulkJobsController.name);

  constructor(private readonly service: BulkJobsService) {}

  @Post()
  @HttpCode(202)
  async submit(
    @WorkspaceId() workspaceId: string,
    @IdempotencyKey() key: string,
    @Body() dto: BulkMoveDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { job, replayed } = await this.service.submit(workspaceId, key, dto);
    if (replayed) res.setHeader('Idempotent-Replayed', 'true');
    this.logger.log(`bulk move ${job.id} ${replayed ? 'replayed' : 'submitted'} (workspace : ${workspaceId}, target : ${dto.target_stage})`);
    return job;
  }

  @Get(':id')
  get(@WorkspaceId() workspaceId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(workspaceId, id);
  }
}
