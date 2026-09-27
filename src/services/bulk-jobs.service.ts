import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { canonicalize, createdBounds, hashRequest } from '../common/bulk-request';
import { computeHealth } from '../common/bulk-health';
import { config } from '../config/configuration';
import { BulkMoveDto } from '../dto/bulk-move.dto';
import { BulkJobRow } from '../entities/bulk-job.entity';
import { BulkJobsRepository } from '../repositories/bulk-jobs.repository';
import { StagesRepository } from '../repositories/stages.repository';

const ONE_ACTIVE_JOB = 'bulk_jobs_one_active_per_workspace';

/** Submitting a bulk move (idempotent) and reporting its progress. The worker does the snapshot and the moves. */
@Injectable()
export class BulkJobsService {
  constructor(
    private readonly jobs: BulkJobsRepository,
    private readonly stages: StagesRepository,
  ) {}

  /** Validates the request and records the job; the worker does the snapshot and the moves. */
  async submit(workspaceId: string, idempotencyKey: string, dto: BulkMoveDto) {
    const canonical = canonicalize(dto);
    const requestHash = hashRequest(canonical);

    const targetStageSk = await this.stages.findSk(workspaceId, dto.target_stage);
    if (targetStageSk === null) throw new UnprocessableEntityException('target_stage does not exist in this workspace');
    if (canonical.filter.stage && (await this.stages.findSk(workspaceId, canonical.filter.stage)) === null) {
      throw new UnprocessableEntityException('filter.stage does not exist in this workspace');
    }
    createdBounds(canonical.filter.created); // rejects an inverted or malformed date range now, not inside the worker

    // A retry: answer with the existing job, and do no work.
    const existing = await this.jobs.findByKey(workspaceId, idempotencyKey);
    if (existing) return { job: this.view(this.sameRequestOrThrow(existing, requestHash)), replayed: true };

    try {
      const id = await this.jobs.insert({ workspaceId, idempotencyKey, requestHash, filter: canonical, targetStageSk });
      if (!id) {
        // Lost a race with a concurrent submit of the same key; that one has committed by now.
        const raced = await this.jobs.findByKey(workspaceId, idempotencyKey);
        return { job: this.view(this.sameRequestOrThrow(raced as BulkJobRow, requestHash)), replayed: true };
      }
      return { job: this.view((await this.jobs.findById(workspaceId, id)) as BulkJobRow), replayed: false };
    } catch (err) {
      if ((err as { code?: string; constraint?: string }).code === '23505' && (err as { constraint?: string }).constraint === ONE_ACTIVE_JOB) {
        const activeId = await this.jobs.findActiveId(workspaceId);
        throw new ConflictException({ message: 'this workspace already has a bulk move in progress', active_job_id: activeId });
      }
      throw err;
    }
  }

  async get(workspaceId: string, id: string) {
    const row = await this.jobs.findById(workspaceId, id);
    if (!row) throw new NotFoundException('bulk move not found');
    return this.view(row);
  }

  private sameRequestOrThrow(row: BulkJobRow, requestHash: string): BulkJobRow {
    if (row.request_hash !== requestHash) {
      throw new UnprocessableEntityException('this Idempotency-Key was already used for a different request');
    }
    return row;
  }

  private view(row: BulkJobRow) {
    const processed = row.moved + row.skipped_conflict;
    // While the worker is still building the list of deals to move, the total is not known yet.
    const counting = row.phase === 'snapshot';
    return {
      id: row.id,
      state: row.state,
      phase: row.phase,
      health: computeHealth({ ...row, processed }, config.bulk),
      target_stage: row.target_stage,
      filter: (row.filter as { filter: unknown }).filter,
      snapshotted: row.total,
      total: counting ? null : row.total,
      processed,
      moved: row.moved,
      skipped_conflict: row.skipped_conflict,
      remaining: counting ? null : row.total - processed,
      percent: counting ? null : row.total === 0 ? 100 : Math.round((processed * 1000) / row.total) / 10,
      attempt: row.attempt,
      created_at: row.created_at,
      started_at: row.started_at,
      last_progress_at: row.last_progress_at,
      finished_at: row.finished_at,
      error: row.error,
    };
  }
}
