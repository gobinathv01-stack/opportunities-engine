import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pacer, sleep } from '../common/utils';
import { config } from '../config/configuration';
import { Queryable } from '../interfaces/queryable';
import { criteriaFrom } from '../repositories/bulk-filter';
import { BulkWorkerRepository, Claim, JobProgress, SnapshotOutcome } from '../repositories/bulk-worker.repository';
import { StagesRepository } from '../repositories/stages.repository';
import { DatabaseService } from './database.service';

/** The lease is no longer ours (taken over) — stop without committing. */
export class LeaseLostError extends Error {}

/** What one transaction of the worker did. end: none = keep going, phase = phase over, job = job over. */
export interface StepResult {
  end: 'none' | 'phase' | 'job';
  found: number; // snapshot batch: rows added
  moved: number;
  skipped: number;
}

/** Claims a job, snapshots it batch by batch, then moves it chunk by chunk. Holds no state of its own. */
@Injectable()
export class BulkWorkerService implements OnModuleDestroy {
  private readonly logger = new Logger(BulkWorkerService.name);
  /** Public so tests can shrink chunks and timings. */
  readonly options = { ...config.bulk };
  private running = false;
  private loops: Promise<void>[] = [];

  constructor(
    private readonly db: DatabaseService,
    private readonly repo: BulkWorkerRepository,
    private readonly stages: StagesRepository,
  ) {}

  /** Starts `workerConcurrency` polling loops. */
  start() {
    this.running = true;
    for (let i = 0; i < this.options.workerConcurrency; i++) this.loops.push(this.loop());
    this.logger.log(`bulk worker started (concurrency ${this.options.workerConcurrency}, chunk ${this.options.chunkSize})`);
  }

  async stop() {
    this.running = false;
    await Promise.all(this.loops);
    this.loops = [];
  }

  async onModuleDestroy() {
    await this.stop();
  }

  private async loop() {
    while (this.running) {
      try {
        if (!(await this.runOnce())) await sleep(this.options.pollIntervalMs);
      } catch (err) {
        this.logger.error(`worker loop error: ${(err as Error).message}`);
        await sleep(this.options.pollIntervalMs);
      }
    }
  }

  /** Takes the next runnable job, or null. `only` restricts the claim to one job. */
  claim(only?: { workspaceId: string; jobId: string }): Promise<Claim | null> {
    return this.repo.claimNext(this.options.leaseTtlMs, only);
  }

  /** Claims one job and runs it to the end. Returns false if there was nothing to claim. */
  async runOnce(): Promise<boolean> {
    const claim = await this.claim();
    if (!claim) return false;
    this.logger.log(`job ${claim.jobId}: claimed`);
    await this.runJob(claim);
    return true;
  }

  /** Runs the job phase by phase (snapshot, then move) until it ends or this worker must stop. */
  async runJob(claim: Claim): Promise<void> {
    const sliceStart = Date.now();
    let goOnToNextPhase = true;
    while (goOnToNextPhase) {
      goOnToNextPhase = await this.runPhase(claim, sliceStart);
    }
  }

  /** Runs steps, pacing between them, until the job leaves this phase (true) or ends / must stop (false). */
  private async runPhase(claim: Claim, sliceStart: number): Promise<boolean> {
    const pacer = new Pacer({ duty: this.options.dutyCycle, maxPauseMs: this.options.maxPauseMs });
    const errors = { failures: 0, contention: 0 };
    while (true) {
      try {
        const startedAt = Date.now();
        const { end } = await this.processChunk(claim);
        errors.failures = errors.contention = 0;
        if (end !== 'none') return end === 'phase';
        const pause = pacer.next(Date.now() - startedAt);
        if (pause > 0) await sleep(pause);
        if (await this.shouldYield(claim, sliceStart)) return false;
      } catch (err) {
        if (!(await this.recover(claim, err, errors))) return false;
      }
    }
  }

  /** Hands the job back to the queue if the worker is stopping, or its slice is over and another job waits. */
  private async shouldYield(claim: Claim, sliceStart: number): Promise<boolean> {
    const stopping = !this.running && this.loops.length > 0;
    const fairness = Date.now() - sliceStart >= this.options.sliceMs && (await this.repo.otherJobWaiting(claim));
    if (!stopping && !fairness) return false;
    await this.repo.yieldJob(claim);
    return true;
  }

  /** Decides what a failed step means. Returns true to retry the same step, false to stop running the job. */
  private async recover(claim: Claim, err: unknown, errors: { failures: number; contention: number }): Promise<boolean> {
    if (err instanceof LeaseLostError) {
      this.logger.warn(`job ${claim.jobId}: lease lost, stopping`);
      return false;
    }
    let wait: number;
    if ((err as { code?: string }).code === '55P03') {
      // lock_timeout: back-pressure, not a failure. Wait and retry.
      errors.contention++;
      wait = Math.min(100 * 2 ** Math.min(errors.contention, 5), 3_000);
    } else {
      errors.failures++;
      this.logger.warn(`job ${claim.jobId}: step failed (${errors.failures}/${this.options.maxChunkAttempts}): ${(err as Error).message}`);
      if (errors.failures >= this.options.maxChunkAttempts) {
        await this.repo.fail(claim, (err as Error).message);
        return false;
      }
      wait = Math.min(250 * 2 ** (errors.failures - 1), 5_000);
    }
    if (!(await this.repo.extendLease(claim, this.options.leaseTtlMs))) return false;
    await sleep(wait);
    return true;
  }

  /** One step, one transaction: lock the job (checks the lease), then run whichever phase it's in. All or nothing. */
  async processChunk(claim: Claim): Promise<StepResult> {
    return this.db.tx(async (tx) => {
      // Don't make a person wait on a row we hold; give up fast instead.
      await tx.query(`SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)`, [
        `${this.options.lockTimeoutMs}ms`,
        `${this.options.statementTimeoutMs}ms`,
      ]);
      const job = await this.repo.lockJob(claim, tx);
      if (!job) throw new LeaseLostError();
      return job.phase === 'snapshot' ? this.snapshotBatch(claim, job, tx) : this.moveChunk(claim, job, tx);
    });
  }

  /** Adds the next batch of matching deals to the job's items, then records how far the scan got. */
  private async snapshotBatch(claim: Claim, job: JobProgress, tx: Queryable): Promise<StepResult> {
    const { maxItems, snapshotBatchSize, leaseTtlMs } = this.options;
    const limit = Math.min(snapshotBatchSize, maxItems + 1 - job.total); // one past the cap is enough to detect it
    const { found, lastId } = await this.repo.applySnapshotBatch(claim, await this.criteriaOf(claim, tx), job, limit, tx);
    const total = job.total + found;
    const cursorId = lastId ?? job.snapshotCursorId;
    let outcome: SnapshotOutcome;
    if (total > maxItems) {
      outcome = { cursorId, total, phase: 'snapshot', state: 'failed', error: `the filter matches more than ${maxItems} opportunities; narrow it` };
    } else if (found < limit) {
      outcome = { cursorId, total, phase: 'move', state: total === 0 ? 'completed' : 'running', error: null };
    } else {
      outcome = { cursorId, total, phase: 'snapshot', state: 'running', error: null };
    }
    if (!(await this.repo.recordSnapshot(claim, outcome, leaseTtlMs, tx))) throw new LeaseLostError();
    const end = outcome.state !== 'running' ? 'job' : outcome.phase === 'move' ? 'phase' : 'none';
    if (end === 'phase') this.logger.log(`job ${claim.jobId}: snapshot done (${total} matched), moving`);
    if (end === 'job') this.logger.log(`job ${claim.jobId}: ${outcome.state} (${total} matched)`);
    return { end, found, moved: 0, skipped: 0 };
  }

  /** Moves the next chunk of the snapshot, records the transitions and marks the items, then advances the cursor. */
  private async moveChunk(claim: Claim, job: JobProgress, tx: Queryable): Promise<StepResult> {
    const result = await this.repo.applyChunk(claim, job.cursorSeq, this.options.chunkSize, tx);
    const processed = result.moved + result.skipped;
    const finished = processed === 0 || job.done + processed >= job.total;
    if (!(await this.repo.recordProgress(claim, result, finished, this.options.leaseTtlMs, tx))) throw new LeaseLostError();
    if (finished) this.logger.log(`job ${claim.jobId}: completed (${job.done + processed}/${job.total} processed)`);
    return { end: finished ? 'job' : 'none', found: 0, moved: result.moved, skipped: result.skipped };
  }

  /** The job's filter as SQL criteria; the stage key is looked up once per claim. */
  private async criteriaOf(claim: Claim, q: Queryable) {
    if (!claim.criteria) {
      let stageSk: number | undefined;
      if (claim.filter.stage) {
        const sk = await this.stages.findSk(claim.workspaceId, claim.filter.stage, q);
        if (sk === null) throw new Error(`filter stage "${claim.filter.stage}" no longer exists`);
        stageSk = sk;
      }
      claim.criteria = criteriaFrom(claim.filter, stageSk);
    }
    return claim.criteria;
  }
}
