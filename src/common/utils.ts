/** Ids/cursors are bigint; capped at 18 digits so they never lose precision as a JS number. */
export const ID_PATTERN = /^\d{1,18}$/;
export const ID_MESSAGE = 'must be a non-negative integer of at most 18 digits';

/** Short lowercase key: used for workspace ids ("acme") and stage keys ("contacted"). */
export const SLUG = /^[a-z0-9][a-z0-9-]{1,31}$/;
export const SLUG_MESSAGE = 'must be a short lowercase key such as "contacted" (2-32 chars: a-z, 0-9, "-")';

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface PacerOptions {
  /** Fraction of wall time the job may spend inside chunk transactions (0..1]. 1 = no pacing. */
  duty: number;
  maxPauseMs: number;
}

/**
 * Decides how long the worker sleeps after each chunk.
 */
export class Pacer {
  constructor(private readonly opts: PacerOptions) {}

  /**
   * Calculates the next pause time based on the chunk duration and the duty cycle.
   */
  next(chunkMs: number): number {
    if (this.opts.duty >= 1) return 0;
    return Math.min(this.opts.maxPauseMs, Math.round(chunkMs * (1 / this.opts.duty - 1)));
  }
}
