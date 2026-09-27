/** The only place that reads environment variables. */
export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL ?? '',
  dbPoolMax: Number(process.env.DB_POOL_MAX ?? 10),
  bulk: {
    /** Safety valve: a filter matching more than this fails during its snapshot (the brief's size is 50,000). */
    maxItems: Number(process.env.BULK_MAX_ITEMS ?? 1_000_000),
    snapshotBatchSize: Number(process.env.BULK_SNAPSHOT_BATCH ?? 10_000),
    chunkSize: Number(process.env.BULK_CHUNK_SIZE ?? 500),
    /** A crashed worker's job is taken over once its lease passes this. */
    leaseTtlMs: Number(process.env.BULK_LEASE_TTL_MS ?? 30_000),
    pollIntervalMs: Number(process.env.BULK_POLL_INTERVAL_MS ?? 1_000),
    workerConcurrency: Number(process.env.BULK_WORKER_CONCURRENCY ?? 4),
    /** Consecutive failures of one step before the job is marked failed. */
    maxChunkAttempts: Number(process.env.BULK_MAX_CHUNK_ATTEMPTS ?? 5),
    /** A step gives up waiting for a row lock after this instead of blocking a person. */
    lockTimeoutMs: Number(process.env.BULK_LOCK_TIMEOUT_MS ?? 2_000),
    statementTimeoutMs: Number(process.env.BULK_STATEMENT_TIMEOUT_MS ?? 20_000),
    /** Fraction of wall time the job may spend inside step transactions (1 = unpaced). */
    dutyCycle: Number(process.env.BULK_DUTY_CYCLE ?? 0.5),
    maxPauseMs: Number(process.env.BULK_MAX_PAUSE_MS ?? 2_000),
    /** After this long on one job, yield if another workspace's job is waiting. */
    sliceMs: Number(process.env.BULK_SLICE_MS ?? 3_000),
    /** Progress endpoint: no committed progress for this long means "stuck". Kept above statementTimeoutMs. */
    stuckAfterMs: Number(process.env.BULK_STUCK_AFTER_MS ?? 60_000),
    /** Progress endpoint: below this many rows/second the job is reported "slow". */
    slowRowsPerSec: Number(process.env.BULK_SLOW_ROWS_PER_SEC ?? 1_000),
  },
};
