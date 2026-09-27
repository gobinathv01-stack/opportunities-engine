/** A bulk job as read from the database, with the timing facts the progress view needs. */
export interface BulkJobRow {
  id: string;
  workspace_id: string;
  state: 'queued' | 'running' | 'completed' | 'failed';
  /** snapshot: still building the list of deals to move (`total` counts them so far). move: the list is complete. */
  phase: 'snapshot' | 'move';
  request_hash: string;
  total: number;
  moved: number;
  skipped_conflict: number;
  attempt: number;
  error: string | null;
  filter: unknown;
  target_stage: string;
  created_at: Date;
  started_at: Date | null;
  last_progress_at: Date | null;
  finished_at: Date | null;
  lease_expires_at: Date | null;
  secs_since_progress: number | null;
  active_secs: number | null;
  lease_expired: boolean;
}
