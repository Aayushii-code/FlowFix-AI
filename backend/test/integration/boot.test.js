/**
 * Boot-without-keys behavior: the API must start without TINYFISH_API_KEY,
 * report honestly on /health, and reject executions with a typed 503 instead
 * of pretending to run anything.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../src/app.js';

const apps = [];

after(async () => {
  for (const a of apps) await a.close();
});

function startApp(env) {
  const { app } = createApp(env);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const handle = {
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () =>
          new Promise((r) => {
            server.close(r);
            server.closeAllConnections?.(); // don't let idle sockets stall close()
          }),
      };
      apps.push(handle);
      resolve(handle);
    });
  });
}

test('boots without any keys and reports unconfigured integrations', async () => {
  const appH = await startApp({});
  const res = await fetch(`${appH.baseUrl}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.tinyfish_configured, false);
  assert.equal(body.verification_configured, false);
});

test('POST /executions without TinyFish key → 503 TINYFISH_NOT_CONFIGURED, no fake record', async () => {
  const appH = await startApp({});
  const res = await fetch(`${appH.baseUrl}/api/executions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario_id: 'product-search' }),
  });
  const body = await res.json();

  if (res.status === 202) {
    // The engine accepted the job asynchronously; poll and confirm the
    // execution FAILS with the typed error rather than producing a record.
    const deadline = Date.now() + 3000;
    for (;;) {
      const execRes = await fetch(`${appH.baseUrl}/api/executions/${body.execution_id}`);
      const exec = await execRes.json();
      if (['FAILED', 'TIMED_OUT', 'CANCELLED'].includes(exec.status)) {
        assert.equal(exec.status, 'FAILED');
        assert.equal(exec.error.code, 'TINYFISH_NOT_CONFIGURED');
        assert.equal(exec.verification.verdict, null);
        assert.equal(exec.record.observations.length, 0, 'no fabricated observations');
        break;
      }
      assert.ok(Date.now() < deadline, 'execution should fail fast without a key');
      await new Promise((r) => setTimeout(r, 50));
    }
  } else {
    // Synchronous rejection is also acceptable.
    assert.equal(res.status, 503);
    assert.equal(body.error.code, 'TINYFISH_NOT_CONFIGURED');
  }
});

test('verification engine absent → UNAVAILABLE with null verdict after a good run', async () => {
  // Uses the real TinyFish mock through env; start a dedicated app without
  // VERIFICATION_ENGINE_URL to prove verdicts stay null.
  const { startMockTinyFish } = await import('../helpers/mock-tinyfish.js');
  const mockTf = await startMockTinyFish({ defaultDelayMs: 5 });
  const appH = await startApp({
    TINYFISH_API_KEY: 'test-key',
    TINYFISH_BASE_URL: mockTf.baseUrl,
  });
  try {
    const res = await fetch(`${appH.baseUrl}/api/executions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario_id: 'content-freshness' }),
    });
    const { execution_id } = await res.json();

    const deadline = Date.now() + 8000;
    for (;;) {
      const exec = await (await fetch(`${appH.baseUrl}/api/executions/${execution_id}`)).json();
      if (['COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED'].includes(exec.status)) {
        assert.equal(exec.status, 'COMPLETED');
        assert.equal(exec.verification.status, 'UNAVAILABLE');
        assert.equal(exec.verification.verdict, null);
        assert.match(exec.verification.details.reason, /NOT yet verified/i);
        break;
      }
      assert.ok(Date.now() < deadline, 'execution should finish');
      await new Promise((r) => setTimeout(r, 50));
    }
  } finally {
    await appH.close();
    await mockTf.close();
  }
});
