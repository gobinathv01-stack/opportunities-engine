import { Pacer } from '../src/common/utils';

describe('Pacer (how long the worker sleeps after each chunk)', () => {
  const make = (duty: number, maxPauseMs = 2_000) => new Pacer({ duty, maxPauseMs });

  it('holds the job to its duty cycle: at 0.5 it sleeps as long as the chunk took', () => {
    expect(make(0.5).next(100)).toBe(100);
    expect(make(0.25).next(100)).toBe(300); // 25% busy => 3 parts idle per 1 part working
    expect(make(0.8).next(100)).toBe(25);
  });

  it('duty 1 disables pacing entirely', () => {
    const p = make(1);
    expect(p.next(500)).toBe(0);
    expect(p.next(9_999)).toBe(0);
  });

  it('never sleeps longer than maxPauseMs', () => {
    expect(make(0.5, 800).next(10_000)).toBe(800);
  });
});
