export type BulkHealth = 'queued' | 'waiting' | 'progressing' | 'slow' | 'stuck' | 'stalled' | 'completed' | 'failed';

export interface HealthInput {
  state: string;
  processed: number;
  lease_expired: boolean;
  secs_since_progress: number | null;
  active_secs: number | null;
}

/**
 * Health is computed at read time from committed timestamps and counters only, so it cannot lie after a restart.
 * @param row - The job's row from the database.
 * @param opts - The configuration for the health computation.
 * @returns The health of the job.
 * 
 */
export function computeHealth(row: HealthInput, opts: { stuckAfterMs: number; slowRowsPerSec: number }): BulkHealth {
  if (row.state === 'completed') return 'completed';
  if (row.state === 'failed') return 'failed';
  if (row.state === 'queued') return row.processed > 0 ? 'waiting' : 'queued';
  if (row.lease_expired) return 'stalled';
  if ((row.secs_since_progress ?? 0) * 1000 > opts.stuckAfterMs) return 'stuck';
  if (row.processed > 0 && (row.active_secs ?? 0) > 1 && row.processed / (row.active_secs as number) < opts.slowRowsPerSec) return 'slow';
  return 'progressing';
}
