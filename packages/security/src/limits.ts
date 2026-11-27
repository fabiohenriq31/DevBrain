import { DevBrainError } from '@devbrain/contracts';

/**
 * Counting semaphore used to cap concurrent executions (global and per agent).
 * FIFO; supports abort while waiting and an optional maximum queue length.
 */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly waiters: { resolve: () => void; reject: (e: unknown) => void }[] = [];

  constructor(
    private readonly limit: number,
    private readonly maxQueue = Number.POSITIVE_INFINITY,
  ) {
    if (!Number.isInteger(limit) || limit < 1)
      throw new RangeError('limit must be a positive integer');
  }

  get running(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiters.length;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new DevBrainError('CANCELLED', 'Aborted before acquiring a slot');
    if (this.active < this.limit) {
      this.active += 1;
      return this.releaser();
    }
    if (this.waiters.length >= this.maxQueue) {
      throw new DevBrainError('CONCURRENCY_LIMIT', 'Execution queue is full');
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
        reject,
      };
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new DevBrainError('CANCELLED', 'Aborted while waiting for a slot'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
    });
    return this.releaser();
  }

  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await task();
    } finally {
      release();
    }
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        next.resolve(); // slot handed over; `active` unchanged
      } else {
        this.active -= 1;
      }
    };
  }
}
