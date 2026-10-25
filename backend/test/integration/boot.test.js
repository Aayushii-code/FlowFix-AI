/**
 * Boot-without-keys behavior: the API must start without TINYFISH_API_KEY,
 * report honestly on /health, and reject executions with a typed 503 instead
 * of pretending to run anything.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApp } from '../../src/app.js';

const apps = [];

after(async () => {
  for (const a of apps) await a.close();
});

function startApp(env = {}) {
  const { app, close: closeApp } = createApp({
    DATABASE_PATH: path.join(os.tmpdir(), `flowfix-boot-${crypto.randomUUID()}.db`),
    ...env,
  });
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const handle = {
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () =>
          new Promise((r) => {
            server.close(r);
            server.closeAllConnections?.(); // don't let idle sockets stall close()
            closeApp?.(); // release this test's SQLite handle
          }),
      };
      apps.push(handle);
      resolve(handle);
    });
  });
}

/** Poll until the execution reaches a terminal status (or fail loudly). */
async function waitForTerminal(baseUrl, executionId, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const exec = await (await fetch(`${baseUrl}/api/executions/${executionId}`)).json();
    if (['COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'INCOMPLETE'].includes(exec.status)) {
      return exec;
    }
    if (Date.now() > deadline) {
      throw new Error(`execution ${executionId} did not finish within ${timeoutMs}ms (status ${exec.status})`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
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

test('verification engine absent → local verifier proves the requirement from fetched page evidence', async () => {
  // No VERIFICATION_ENGINE_URL: FlowFix's own independent verifier must
  // produce a real verdict by re-fetching the page itself — and that verdict
  // must be backed by evidence references, not by the agent's self-report.
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
    assert.equal(res.status, 202);
    const { execution_id } = await res.json();

    const exec = await waitForTerminal(appH.baseUrl, execution_id);
    assert.equal(exec.status, 'COMPLETED');

    const v = exec.verification;
    assert.equal(v.status, 'COMPLETED');
    assert.equal(v.details.engine, 'flowfix-local-verification/1');
    assert.equal(v.details.independent_verification, true);

    // The fixture page genuinely contains both conditions, so PASS is the
    // evidence-backed outcome — and it must cite the page FlowFix fetched.
    assert.equal(v.verdict, 'PASS');
    assert.deepEqual(v.details.failed_checks, []);
    assert.ok(v.details.reason_codes.includes('ALL_CHECKS_PASSED'));
    assert.ok(
      v.details.evidence_references.some((ref) => ref.startsWith('page:http')),
      `expected an independently fetched page reference, got ${JSON.stringify(v.details.evidence_references)}`,
    );
    for (const check of v.details.checks) {
      assert.equal(check.status, 'pass');
      assert.equal(check.independent, true);
      assert.ok(check.observed, `check ${check.key} must record what was observed`);
    }
  } finally {
    await appH.close();
    await mockTf.close();
  }
});

test('no checks defined → UNAVAILABLE with null verdict, never a fabricated verdict', async () => {
  // An ad-hoc journey without machine-verifiable checks has nothing to prove:
  // the verifier must refuse to guess rather than invent PASS/FAIL.
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
      body: JSON.stringify({ url: 'https://example.com', goal: 'Report the h1 headline' }),
    });
    assert.equal(res.status, 202);
    const { execution_id } = await res.json();

    const exec = await waitForTerminal(appH.baseUrl, execution_id);
    assert.equal(exec.status, 'COMPLETED');
    assert.equal(exec.verification.status, 'UNAVAILABLE');
    assert.equal(exec.verification.verdict, null);
    assert.match(exec.verification.details.reason, /NOT yet verified/i);
    assert.ok(exec.verification.details.reason_codes.includes('NO_CHECKS_DEFINED'));
  } finally {
    await appH.close();
    await mockTf.close();
  }
});
