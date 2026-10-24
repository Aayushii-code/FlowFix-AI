/**
 * Integration tests: the real Express app wired to a protocol-faithful
 * TinyFish mock and a mock verification engine (Meenu's contract).
 *
 * Covers:
 *  - every documented endpoint
 *  - the three built-in scenarios end to end
 *  - execution status machine incl. timeout and cancel
 *  - error mapping (bad input, upstream 4xx, unknown execution)
 *  - the core invariant: browser COMPLETED ≠ requirement PASS without the engine
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../../src/app.js';
import { startMockTinyFish, startMockVerificationEngine } from '../helpers/mock-tinyfish.js';

/** Start the app on an ephemeral port against the mocks. */
function startApp(env) {
  const { app, config, engine } = createApp(env);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        config,
        engine,
        close: () =>
          new Promise((r) => {
            server.close(r);
            // Keep-alive sockets from fetch would otherwise hold the listener
            // open until their idle timeout, stalling the whole test run.
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

async function json(method, url, body, headers = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed = null;
  try {
    parsed = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body: parsed };
}

/** Wait until predicate() is truthy or the deadline passes. */
async function waitUntil(predicate, deadlineMs = 2_000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > deadlineMs) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
  return true;
}

/** Poll an execution until terminal (or deadline). */
async function waitForTerminal(baseUrl, executionId, deadlineMs = 10_000) {
  const start = Date.now();
  for (;;) {
    const { status, body } = await json('GET', `${baseUrl}/api/executions/${executionId}`);
    assert.equal(status, 200);
    if (['COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'INCOMPLETE'].includes(body.status)) {
      return body;
    }
    if (Date.now() - start > deadlineMs) {
      throw new Error(`Execution ${executionId} did not reach a terminal state; last status ${body.status}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

let mockTf;
let mockVerify;
let app;

before(async () => {
  mockTf = await startMockTinyFish({ defaultDelayMs: 10 });
  mockVerify = await startMockVerificationEngine({ verdict: 'PASS' });
  app = await startApp({
    TINYFISH_API_KEY: 'test-key',
    TINYFISH_BASE_URL: mockTf.baseUrl,
    VERIFICATION_ENGINE_URL: mockVerify.baseUrl,
    EXECUTION_TIMEOUT_MS: '60000',
    MAX_CONCURRENT_EXECUTIONS: '3',
  });
});

after(async () => {
  await app?.close();
  await mockTf?.close();
  await mockVerify?.close();
});

// ── Health & scenarios ────────────────────────────────────────────────────────

test('GET /api/health reports configured integrations', async () => {
  const { status, body } = await json('GET', `${app.baseUrl}/api/health`);
  assert.equal(status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.tinyfish_configured, true);
  assert.equal(body.verification_configured, true);
});

test('GET /api/scenarios lists exactly the three built-in scenarios', async () => {
  const { status, body } = await json('GET', `${app.baseUrl}/api/scenarios`);
  assert.equal(status, 200);
  const ids = body.scenarios.map((s) => s.id).sort();
  assert.deepEqual(ids, ['contact-form', 'content-freshness', 'product-search']);
  for (const s of body.scenarios) {
    assert.ok(s.requirement, 'scenario exposes its requirement');
    assert.ok(s.expected_outcome, 'scenario exposes its expectation for the engine');
  }
});

// ── Scenario 1: product-search ───────────────────────────────────────────────

test('scenario product-search: full journey → COMPLETED record + PASS verdict from engine', async () => {
  const created = await json('POST', `${app.baseUrl}/api/executions`, { scenario_id: 'product-search' });
  assert.equal(created.status, 202);
  assert.ok(created.body.execution_id);

  const exec = await waitForTerminal(app.baseUrl, created.body.execution_id);
  assert.equal(exec.status, 'COMPLETED');

  // Observations: two agent steps + the agent's actual result payload
  const kinds = exec.record.observations.map((o) => o.kind);
  assert.ok(kinds.includes('agent_step'));
  assert.ok(kinds.includes('agent_result'));
  const result = exec.record.observations.find((o) => o.kind === 'agent_result');
  assert.ok(result.result.value.products.some((p) => /table/i.test(p.name)));

  // Evidence: real screenshot URL from the run object + raw event log
  const shots = exec.record.evidence.filter((e) => e.kind === 'step_screenshot');
  assert.ok(shots.length >= 1);
  assert.match(shots[0].url, /^https:\/\//);
  assert.ok(exec.record.evidence.some((e) => e.kind === 'raw_event_log'));

  // Verdict came from the mock engine (Meenu's side), not from execution
  assert.equal(exec.verification.status, 'COMPLETED');
  assert.equal(exec.verification.verdict, 'PASS');

  // Mock received the full evidence package
  const lastVerify = mockVerify.requests.at(-1).body;
  assert.equal(lastVerify.execution_id, exec.execution_id);
  assert.equal(lastVerify.execution_status, 'COMPLETED');
  assert.ok(lastVerify.observations.length >= 3);
  assert.ok(lastVerify.evidence.length >= 2);
  assert.equal(lastVerify.expected_outcome.condition, 'at least one product whose name contains "table" (case-insensitive)');
});

// ── Scenario 2: contact-form ─────────────────────────────────────────────────

test('scenario contact-form: form journey completes and echoes values', async () => {
  const created = await json('POST', `${app.baseUrl}/api/executions`, { scenario_id: 'contact-form' });
  assert.equal(created.status, 202);
  const exec = await waitForTerminal(app.baseUrl, created.body.execution_id);
  assert.equal(exec.status, 'COMPLETED');
  const result = exec.record.observations.find((o) => o.kind === 'agent_result');
  assert.equal(result.result.value.echoed.customername, 'FlowFix Tester');
});

// ── Scenario 3: content-freshness ────────────────────────────────────────────

test('scenario content-freshness: headline extracted from the live page', async () => {
  const created = await json('POST', `${app.baseUrl}/api/executions`, { scenario_id: 'content-freshness' });
  assert.equal(created.status, 202);
  const exec = await waitForTerminal(app.baseUrl, created.body.execution_id);
  assert.equal(exec.status, 'COMPLETED');
  const result = exec.record.observations.find((o) => o.kind === 'agent_result');
  assert.equal(result.result.value.headline, 'Example Domain');
});

// ── Ad-hoc executions & validation ───────────────────────────────────────────

test('POST /api/executions ad-hoc journey works and forwards requirement to engine', async () => {
  const { status, body } = await json('POST', `${app.baseUrl}/api/executions`, {
    url: 'https://example.com',
    goal: 'Report the headline',
    requirement: 'Landing page must show the Example Domain headline',
    expected_outcome: { type: 'text_present', headline: 'Example Domain' },
  });
  assert.equal(status, 202);
  const exec = await waitForTerminal(app.baseUrl, body.execution_id);
  assert.equal(exec.status, 'COMPLETED');
  const sent = mockVerify.requests.at(-1).body;
  assert.equal(sent.requirement, 'Landing page must show the Example Domain headline');
});

test('POST /api/executions rejects scenario_id + ad-hoc mix', async () => {
  const { status, body } = await json('POST', `${app.baseUrl}/api/executions`, {
    scenario_id: 'product-search',
    url: 'https://example.com',
  });
  assert.equal(status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
});

test('POST /api/executions rejects unknown scenario', async () => {
  const { status, body } = await json('POST', `${app.baseUrl}/api/executions`, { scenario_id: 'nope' });
  assert.equal(status, 400);
  assert.ok(body.error.details.known_scenarios.includes('product-search'));
});

test('POST /api/executions rejects non-http URL and empty goal', async () => {
  const bad1 = await json('POST', `${app.baseUrl}/api/executions`, { url: 'ftp://x', goal: 'g' });
  assert.equal(bad1.status, 400);
  const bad2 = await json('POST', `${app.baseUrl}/api/executions`, { url: 'https://x.com', goal: '' });
  assert.equal(bad2.status, 400);
  assert.equal(bad2.body.error.code, 'VALIDATION_ERROR');
});

// ── Listing & fetching ───────────────────────────────────────────────────────

test('GET /api/executions lists newest first', async () => {
  const { status, body } = await json('GET', `${app.baseUrl}/api/executions`);
  assert.equal(status, 200);
  assert.ok(body.executions.length >= 3);
  const times = body.executions.map((e) => e.created_at);
  const sorted = [...times].sort().reverse();
  assert.deepEqual(times, sorted);
});

test('GET /api/executions/:id 404s for unknown id', async () => {
  const { status, body } = await json('GET', `${app.baseUrl}/api/executions/does-not-exist`);
  assert.equal(status, 404);
  assert.equal(body.error.code, 'NOT_FOUND');
});

// ── Upstream error mapping ───────────────────────────────────────────────────

test('upstream 402 INSUFFICIENT_CREDITS → execution FAILED with mapped error, verdict stays null', async () => {
  const { body } = await json('POST', `${app.baseUrl}/api/executions`, {
    url: 'https://example.com',
    goal: 'BEHAVIOR:billing_reject anything',
  });
  const exec = await waitForTerminal(app.baseUrl, body.execution_id);
  assert.equal(exec.status, 'FAILED');
  assert.equal(exec.error.code, 'TINYFISH_INSUFFICIENT_CREDITS');
  assert.equal(exec.error.retryable, false);
  assert.equal(exec.verification.status, 'SKIPPED');
  assert.equal(exec.verification.verdict, null);
});

test('goal-level failure (COMPLETED + result.status=failure) surfaces honestly, no PASS', async () => {
  const { body } = await json('POST', `${app.baseUrl}/api/executions`, {
    url: 'https://scrapeme.live/shop',
    goal: 'BEHAVIOR:goal_failure search for something impossible',
  });
  const exec = await waitForTerminal(app.baseUrl, body.execution_id);
  // Browser execution itself succeeded — FlowFix must not report FAILED
  // execution for a goal miss, and must not report a PASS verdict either.
  assert.equal(exec.status, 'COMPLETED');
  const result = exec.record.observations.find((o) => o.kind === 'agent_result');
  assert.equal(result.result.value.status, 'failure');
});

// ── Timeout & cancel ─────────────────────────────────────────────────────────

test('watchdog timeout: hanging stream → TIMED_OUT, upstream cancel called, verdict null', async () => {
  const localApp = await startApp({
    TINYFISH_API_KEY: 'test-key',
    TINYFISH_BASE_URL: mockTf.baseUrl,
    EXECUTION_TIMEOUT_MS: '700',
  });
  try {
    const { body } = await json('POST', `${localApp.baseUrl}/api/executions`, {
      url: 'https://example.com',
      goal: 'BEHAVIOR:hang do something slow',
    });
    const exec = await waitForTerminal(localApp.baseUrl, body.execution_id, 5000);
    assert.equal(exec.status, 'TIMED_OUT');
    assert.equal(exec.error.code, 'EXECUTION_TIMEOUT');
    assert.equal(exec.verification.status, 'SKIPPED');
    assert.equal(exec.verification.verdict, null);
    // The upstream cancel is fired asynchronously by design (the terminal
    // status must not block on the network), so wait briefly for the mock to
    // observe it instead of racing the request.
    await waitUntil(() => mockTf.requests.cancel.length >= 1);
    assert.ok(mockTf.requests.cancel.length >= 1);
  } finally {
    await localApp.close();
  }
});

test('POST /api/executions/:id/cancel stops a run and is idempotent', async () => {
  const localApp = await startApp({
    TINYFISH_API_KEY: 'test-key',
    TINYFISH_BASE_URL: mockTf.baseUrl,
    EXECUTION_TIMEOUT_MS: '30000',
  });
  try {
    const { body } = await json('POST', `${localApp.baseUrl}/api/executions`, {
      url: 'https://example.com',
      goal: 'BEHAVIOR:hang do something slow',
    });
    // Give the stream a moment to START so a run_id exists
    await new Promise((r) => setTimeout(r, 250));
    const cancel1 = await json('POST', `${localApp.baseUrl}/api/executions/${body.execution_id}/cancel`);
    assert.equal(cancel1.status, 200);
    assert.equal(cancel1.body.status, 'CANCELLED');

    const cancel2 = await json('POST', `${localApp.baseUrl}/api/executions/${body.execution_id}/cancel`);
    assert.equal(cancel2.body.already_finished, true);

    const exec = await json('GET', `${localApp.baseUrl}/api/executions/${body.execution_id}`);
    assert.equal(exec.body.status, 'CANCELLED');
    assert.equal(exec.body.verification.verdict, null);
  } finally {
    await localApp.close();
  }
});

// ── SSE stream endpoint ──────────────────────────────────────────────────────

test('GET /api/executions/:id/events streams snapshot → events → terminal for the frontend', async () => {
  const { body } = await json('POST', `${app.baseUrl}/api/executions`, { scenario_id: 'content-freshness' });
  const res = await fetch(`${app.baseUrl}/api/executions/${body.execution_id}/events`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);

  // Read the stream until terminal, collecting SSE frames.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const seen = new Set();
  const deadline = Date.now() + 10_000;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Register every frame kind present in the buffer BEFORE deciding to
      // stop: record/verification/status frames can arrive in the same TCP
      // chunk as `terminal`, and all of them are required by the assertions.
      for (const kind of ['snapshot', 'upstream_event', 'record', 'verification', 'status', 'terminal']) {
        if (buffer.includes(`event: ${kind}`)) seen.add(kind);
      }
      if (seen.has('terminal')) break;
      if (Date.now() > deadline) throw new Error('SSE stream did not reach terminal');
    }
  } finally {
    // Release the connection so the server can close cleanly in after().
    await reader.cancel().catch(() => {});
  }
  assert.ok(seen.has('snapshot'), 'snapshot frame received');
  assert.ok(seen.has('upstream_event'), 'upstream events relayed');
  assert.ok(seen.has('record'), 'normalized record delivered');
  assert.ok(seen.has('verification'), 'verification update delivered');
  assert.ok(seen.has('terminal'), 'terminal frame closes the stream');
});

test('SSE stream 404s for unknown execution', async () => {
  const res = await fetch(`${app.baseUrl}/api/executions/nope/events`);
  assert.equal(res.status, 404);
});

// ── Verify endpoint & report ─────────────────────────────────────────────────

test('POST /api/executions/:id/verify re-runs verification and updates the verdict', async () => {
  // Spin an app whose engine initially fails, then point a second app at a
  // healthy engine to prove re-verification flips the verdict honestly.
  const brokenEngine = await startMockVerificationEngine({ delayMs: 5 });
  await brokenEngine.close(); // now unreachable
  const localApp = await startApp({
    TINYFISH_API_KEY: 'test-key',
    TINYFISH_BASE_URL: mockTf.baseUrl,
    VERIFICATION_ENGINE_URL: brokenEngine.baseUrl,
    EXECUTION_TIMEOUT_MS: '30000',
  });
  try {
    const { body } = await json('POST', `${localApp.baseUrl}/api/executions`, { scenario_id: 'content-freshness' });
    const exec = await waitForTerminal(localApp.baseUrl, body.execution_id);
    assert.equal(exec.status, 'COMPLETED');
    // Engine unreachable → ERROR + null verdict — NOT PASS, NOT FAIL
    assert.equal(exec.verification.status, 'ERROR');
    assert.equal(exec.verification.verdict, null);

    // Now retry verification against the healthy shared mock by mutating the
    // adapter base URL (same process, simulates the engine coming back).
    localApp.engine.verifier.baseUrl = mockVerify.baseUrl;
    const retry = await json('POST', `${localApp.baseUrl}/api/executions/${body.execution_id}/verify`);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.verification.verdict, 'PASS');
    assert.equal(retry.body.verification.status, 'COMPLETED');
  } finally {
    await localApp.close();
  }
});

test('POST /api/executions/:id/verify 409s when execution is not COMPLETED', async () => {
  const localApp = await startApp({
    TINYFISH_API_KEY: 'test-key',
    TINYFISH_BASE_URL: mockTf.baseUrl,
    EXECUTION_TIMEOUT_MS: '600',
  });
  try {
    const { body } = await json('POST', `${localApp.baseUrl}/api/executions`, {
      url: 'https://example.com',
      goal: 'BEHAVIOR:hang do something slow',
    });
    await waitForTerminal(localApp.baseUrl, body.execution_id, 5000);
    const res = await json('POST', `${localApp.baseUrl}/api/executions/${body.execution_id}/verify`);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'EXECUTION_NOT_COMPLETED');
  } finally {
    await localApp.close();
  }
});

test('GET /api/executions/:id/report separates execution facts from verdict', async () => {
  const { body } = await json('POST', `${app.baseUrl}/api/executions`, { scenario_id: 'product-search' });
  const exec = await waitForTerminal(app.baseUrl, body.execution_id);
  const { status, body: report } = await json('GET', `${app.baseUrl}/api/executions/${exec.execution_id}/report`);
  assert.equal(status, 200);
  assert.equal(report.report_version, '1.0');
  assert.equal(report.execution.status, 'COMPLETED');
  assert.ok(report.requirement || report.execution.requirement);
  assert.ok(Array.isArray(report.observations));
  // Verdict section explicitly notes provenance
  assert.equal(report.verdict, 'PASS');
  assert.match(report.verdict_note, /verification engine/i);
  // Raw event log is summarized, not duplicated into the report payload
  assert.ok(!('events' in (report.evidence?.find((e) => e.kind === 'raw_event_log') ?? {})));
});

test('report for execution with no verdict says so explicitly', async () => {
  const { body } = await json('POST', `${app.baseUrl}/api/executions`, {
    url: 'https://example.com',
    goal: 'BEHAVIOR:billing_reject nope',
  });
  await waitForTerminal(app.baseUrl, body.execution_id);
  const { body: report } = await json('GET', `${app.baseUrl}/api/executions/${body.execution_id}/report`);
  assert.equal(report.verdict, null);
  assert.match(report.verdict_note, /does not verify/i);
});

// ── Malformed JSON ───────────────────────────────────────────────────────────

test('malformed JSON body → 400 INVALID_JSON', async () => {
  const res = await fetch(`${app.baseUrl}/api/executions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, 'INVALID_JSON');
});

test('unknown route → 404 envelope', async () => {
  const { status, body } = await json('GET', `${app.baseUrl}/definitely-not-a-route`);
  assert.equal(status, 404);
  assert.equal(body.error.code, 'ROUTE_NOT_FOUND');
});
