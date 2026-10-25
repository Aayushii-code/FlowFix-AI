/**
 * Job queue with a pluggable driver.
 *
 * Everything asynchronous in FlowFix (execution runs, scheduled monitoring,
 * regression sweeps) goes through this queue so the delivery mechanism can be
 * swapped later without touching callers:
 *
 *   driver contract: { name, dispatch(job, execute), size(), stop() }
 *
 * The bundled `in-process` driver runs jobs on this process's event loop with
 * a bounded worker count. A future Redis/BullMQ driver implements the same
 * three methods and is registered below — no call-site changes required.
 */

class InProcessDriver {
  constructor({ concurrency = 5 } = {}) {
    this.name = 'in-process';
    this.concurrency = Math.max(1, concurrency);
    this.pending = [];
    this.active = 0;
    this.stopped = false;
  }

  dispatch(job, execute) {
    if (this.stopped) {
      job.done?.(new Error('queue is closed'));
      return;
    }
    this.pending.push({ job, execute });
    this.#pump();
  }

  #pump() {
    while (!this.stopped && this.active < this.concurrency && this.pending.length > 0) {
      const item = this.pending.shift();
      this.active += 1;
      Promise.resolve()
        .then(() => item.execute(item.job))
        .then(
          (result) => item.job.done?.(null, result),
          (err) => item.job.done?.(err),
        )
        .finally(() => {
          this.active -= 1;
          this.#pump();
        });
    }
  }

  size() {
    return this.pending.length;
  }

  stop() {
    this.stopped = true;
    this.pending.length = 0;
  }
}

const DRIVERS = {
  'in-process': InProcessDriver,
  // 'redis-bullmq': BullMqDriver,  ← drop-in later: same dispatch/size/stop
};

/**
 * @param {{ driver?: string, concurrency?: number }} options
 */
export function createJobQueue({ driver = 'in-process', concurrency = 5 } = {}) {
  const Driver = DRIVERS[driver];
  if (!Driver) {
    throw new Error(`Unknown queue driver "${driver}" (known: ${Object.keys(DRIVERS).join(', ')})`);
  }
  const impl = new Driver({ concurrency });
  /** @type {Map<string, (payload: any) => Promise<any>>} */
  const handlers = new Map();
  let enqueued = 0;
  let completed = 0;
  let failed = 0;

  async function run(job) {
    const handler = handlers.get(job.type);
    if (!handler) throw new Error(`No handler registered for job type "${job.type}"`);
    try {
      const result = await handler(job.payload, job);
      completed += 1;
      return result;
    } catch (err) {
      failed += 1;
      throw err;
    }
  }

  return {
    /** @param {string} type @param {(payload: any, job: any) => Promise<any>} handler */
    register(type, handler) {
      handlers.set(type, handler);
    },

    enqueue(type, payload = {}) {
      enqueued += 1;
      const job = { id: `${type}:${enqueued}`, type, payload };
      impl.dispatch(job, run);
      return job;
    },

    stats() {
      return {
        driver: impl.name,
        enqueued,
        completed,
        failed,
        pending: impl.size(),
        handlers: [...handlers.keys()],
      };
    },

    async close() {
      impl.stop();
    },
  };
}
