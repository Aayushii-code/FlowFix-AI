/**
 * Execution engine retention: the in-memory store keeps the newest N
 * executions (default 500, overridable for tests) and never evicts a running
 * execution. Evicted ids behave exactly like unknown ids (404).
 *
 * Uses a fake TinyFish client so lifecycle transitions happen without network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionEngine } from '../../src/execution/engine.js';
import { VerificationAdapter } from '../../src/verification/adapter.js';
import { NotFoundError } from '../../src/errors.js';

function makeEngine({ maxRetained, maxConcurrent = 10 }) {
  let counter = 0;
  const tinyfish = {
    async runSse(_params, { onEvent } = {}) {
      const runId = `run_fake_${++counter}`;
      onEvent?.({ type: 'STARTED', run_id: runId, timestamp: new Date().toISOString() });
      const result = { ok: true, seq: counter };
      onEvent?.({ type: 'COMPLETE', run_id: runId, status: 'COMPLETED', result, timestamp: new Date().toISOString() });
      return { type: 'COMPLETE', run_id: runId, status: 'COMPLETED', result };
    },
    async getRun(runId) {
      return { run_id: runId, status: 'COMPLETED', num_of_steps: 0, steps: [] };
    },
    async cancelRun() {
      return { status: 'CANCELLED' };
    },
  };
  const verifier = new VerificationAdapter({ baseUrl: '' }); // verdict stays null — irrelevant here
  return new ExecutionEngine({ tinyfish, verifier, maxRetained, maxConcurrent });
}

const spec = (goal) => ({
  scenarioId: null,
  requirement: 'test requirement',
  url: 'https://example.com',
  goal,
});

async function waitForTerminal(engine, id, deadlineMs = 2000) {
  const start = Date.now();
  for (;;) {
    const view = engine.get(id);
    if (['COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'INCOMPLETE'].includes(view.status)) return view;
    if (Date.now() - start > deadlineMs) throw new Error(`execution ${id} did not settle`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('retains only the latest N completed executions', async () => {
  const engine = makeEngine({ maxRetained: 3 });
  const ids = [];

  for (let i = 0; i < 5; i += 1) {
    const created = engine.createExecution(spec(`goal ${i}`));
    ids.push(created.execution_id);
    await waitForTerminal(engine, created.execution_id);
  }

  assert.equal(engine.executions.size, 3, 'store is bounded by maxRetained');
  assert.throws(() => engine.get(ids[0]), (err) => err instanceof NotFoundError, 'oldest evicted → 404');
  assert.throws(() => engine.get(ids[1]), (err) => err instanceof NotFoundError);
  for (const id of ids.slice(2)) {
    assert.equal(engine.get(id).execution_id, id, 'newest executions retained');
  }
  assert.deepEqual(
    engine.list().map((e) => e.execution_id),
    [...ids.slice(2)].reverse(),
    'list() still returns newest first',
  );
});

test('retention default is 500', () => {
  const engine = makeEngine({ maxRetained: undefined });
  assert.equal(engine.maxRetained, 500);
});

test('never evicts a running execution', async () => {
  const engine = makeEngine({ maxRetained: 2 });

  // Make the next run never finish, so it stays non-terminal while others
  // complete and force eviction pressure.
  const hanging = new Promise(() => {});
  engine.tinyfish.runSse = async () => hanging;

  const running = engine.createExecution(spec('hang forever'));
  assert.equal(engine.get(running.execution_id).status, 'RUNNING');

  engine.tinyfish.runSse = async (_params, { onEvent } = {}) => {
    onEvent?.({ type: 'STARTED', run_id: 'run_fake_q', timestamp: new Date().toISOString() });
    onEvent?.({
      type: 'COMPLETE',
      run_id: 'run_fake_q',
      status: 'COMPLETED',
      result: { ok: true },
      timestamp: new Date().toISOString(),
    });
    return { type: 'COMPLETE', status: 'COMPLETED', result: { ok: true } };
  };

  const quickIds = [];
  for (let i = 0; i < 3; i += 1) {
    const created = engine.createExecution(spec(`quick ${i}`));
    quickIds.push(created.execution_id);
    await waitForTerminal(engine, created.execution_id);
  }

  assert.ok(engine.get(running.execution_id), 'running execution was not evicted');
  assert.equal(engine.executions.size, 2, 'running + newest completed retained');
  assert.ok(engine.get(quickIds.at(-1)), 'newest completed retained');
  assert.throws(() => engine.get(quickIds[0]), (err) => err instanceof NotFoundError);

  engine.cancel(running.execution_id); // cleanup: settle the hanging run
});
