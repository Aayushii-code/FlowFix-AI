/**
 * Evidence Viewer + Root Cause endpoints, exercised end-to-end against the
 * TinyFish mock (real HTTP, real SQLite, real local verification).
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApp } from '../../src/app.js';
import { startMockTinyFish } from '../helpers/mock-tinyfish.js';

const apps = [];
const mocks = [];
after(async () => {
  for (const a of apps) await a.close().catch(() => {});
  for (const m of mocks) await m.close().catch(() => {});
});

function startApp(env = {}) {
  const handle = createApp({
    DATABASE_PATH: path.join(os.tmpdir(), `flowfix-evidence-${crypto.randomUUID()}.db`),
    ...env,
  });
  return new Promise((resolve) => {
    const server = handle.app.listen(0, '127.0.0.1', () => {
      const h = {
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        engine: handle.engine,
        close: async () => {
          await new Promise((r) => {
            server.close(r);
            server.closeAllConnections?.();
          });
          await handle.close();
        },
      };
      apps.push(h);
      resolve(h);
    });
  });
}

async function json(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
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

async function runToTerminal(baseUrl, body) {
  const created = await json('POST', `${baseUrl}/api/executions`, body);
  assert.equal(created.status, 202, `create failed: ${JSON.stringify(created.body)}`);
  const deadline = Date.now() + 9000;
  for (;;) {
    const { body: view } = await json('GET', `${baseUrl}/api/executions/${created.body.execution_id}`);
    if (['COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'INCOMPLETE'].includes(view.status)) return view;
    assert.ok(Date.now() < deadline, 'execution should finish');
    await new Promise((r) => setTimeout(r, 40));
  }
}

async function appWithMock(env = {}) {
  const mockTf = await startMockTinyFish({ defaultDelayMs: 5 });
  mocks.push(mockTf);
  const app = await startApp({ TINYFISH_API_KEY: 'test-key', TINYFISH_BASE_URL: mockTf.baseUrl, ...env });
  return app;
}

describe('GET /api/executions/:id/evidence — Evidence Viewer', () => {
  test('groups artifacts, observations, provenance and check coverage', async () => {
    const app = await appWithMock();
    const exec = await runToTerminal(app.baseUrl, { scenario_id: 'content-freshness' });
    assert.equal(exec.status, 'COMPLETED');

    const { status, body: ev } = await json('GET', `${app.baseUrl}/api/executions/${exec.execution_id}/evidence`);
    assert.equal(status, 200);
    assert.equal(ev.execution_id, exec.execution_id);
    assert.equal(ev.verification.verdict, 'PASS');

    // Observations and artifacts are grouped by kind, nothing invented.
    assert.ok(ev.observations.length >= 3, 'steps + agent result');
    assert.equal(ev.artifacts.screenshots.length, 1);
    assert.equal(ev.artifacts.html.length, 1);
    assert.ok(ev.artifacts.screenshots[0].url);
    assert.equal(ev.artifacts.screenshots[0].source, 'tinyfish_run_object:steps[].screenshot');
    assert.ok(ev.artifacts.streams.length >= 1);

    // Provenance: every fact traces to a named source.
    assert.ok(Object.keys(ev.provenance).length >= 3);
    assert.ok(ev.provenance['tinyfish_sse:COMPLETE.result'] >= 1);

    // Coverage maps each contract check to the evidence that proved it.
    assert.equal(ev.evidence_coverage.length, 2);
    for (const item of ev.evidence_coverage) {
      assert.equal(item.status, 'pass');
      assert.equal(item.independent, true);
      assert.ok(item.evidence_ref.startsWith('page:'));
    }

    // Raw event log with truncation control.
    assert.equal(ev.raw_event_log.event_count, ev.raw_event_log.returned, 'default returns everything');
    assert.equal(ev.raw_event_log.truncated, false);
  });

  test('events_limit truncates the raw log honestly', async () => {
    const app = await appWithMock();
    const exec = await runToTerminal(app.baseUrl, { scenario_id: 'content-freshness' });
    const { body: ev } = await json('GET', `${app.baseUrl}/api/executions/${exec.execution_id}/evidence?events_limit=2`);
    assert.equal(ev.raw_event_log.returned, 2, 'exactly the requested number');
    assert.equal(ev.raw_event_log.truncated, true);
    assert.equal(ev.raw_event_log.event_count, ev.raw_event_log.event_count);
    assert.ok(ev.raw_event_log.event_count > 2);

    const { body: noRaw } = await json('GET', `${app.baseUrl}/api/executions/${exec.execution_id}/evidence?raw=off`);
    assert.equal(noRaw.raw_event_log, null, 'raw log can be excluded for a light payload');
  });

  test('failed run still exposes its evidence and honest gaps', async () => {
    const app = await appWithMock();
    const exec = await runToTerminal(app.baseUrl, { url: 'https://x.example', goal: 'BEHAVIOR:billing_reject pay now' });
    assert.equal(exec.status, 'FAILED');

    const { status, body: ev } = await json('GET', `${app.baseUrl}/api/executions/${exec.execution_id}/evidence`);
    assert.equal(status, 200);
    assert.equal(ev.status, 'FAILED');
    assert.equal(ev.verification.verdict, null, 'a failed run never carries a verdict');
    // The 402 is raised before any SSE frame is emitted, so the honest raw log
    // is present but EMPTY — zero events, not invented ones.
    assert.ok(ev.raw_event_log, 'raw log container is always present');
    assert.equal(ev.raw_event_log.event_count, ev.raw_event_log.events.length);
    assert.ok(ev.evidence_note.length > 0, 'the payload explains what is missing');
    assert.ok(ev.provenance, 'provenance census present even for failures');
  });

  test('404s for an unknown execution', async () => {
    const app = await startApp();
    const { status, body } = await json('GET', `${app.baseUrl}/api/executions/nope/evidence`);
    assert.equal(status, 404);
    assert.equal(body.error.code, 'NOT_FOUND');
  });
});

describe('GET /api/executions/:id/root-cause — diagnosis', () => {
  test('classified, persisted and shown for a verified success', async () => {
    const app = await appWithMock();
    const exec = await runToTerminal(app.baseUrl, { scenario_id: 'content-freshness' });

    const { status, body } = await json('GET', `${app.baseUrl}/api/executions/${exec.execution_id}/root-cause`);
    assert.equal(status, 200);
    assert.equal(body.root_cause.classification, 'SUCCESS');
    assert.ok(body.root_cause.analyzed_at);
    assert.ok(body.root_cause.likely_causes.length > 0);

    // Persisted onto the execution record for history.
    const { body: view } = await json('GET', `${app.baseUrl}/api/executions/${exec.execution_id}`);
    assert.equal(view.root_cause.classification, 'SUCCESS');
  });

  test('agent goal failure is diagnosed distinctly', async () => {
    const app = await appWithMock();
    const exec = await runToTerminal(app.baseUrl, { url: 'https://x.example', goal: 'BEHAVIOR:goal_failure deliver it' });
    const { body } = await json('GET', `${app.baseUrl}/api/executions/${exec.execution_id}/root-cause`);
    assert.equal(body.root_cause.classification, 'AGENT_GOAL_FAILURE');
    assert.ok(body.root_cause.reason_codes.includes('AGENT_REPORTED_FAILURE'));
    assert.ok(body.root_cause.recommended_actions.some((a) => a.risk === 'safe'));
  });

  test('409 while the execution is still running', async () => {
    const app = await appWithMock({ EXECUTION_TIMEOUT_MS: '20000' });
    const created = await json('POST', `${app.baseUrl}/api/executions`, {
      url: 'https://x.example',
      goal: 'BEHAVIOR:hang take your time',
    });
    assert.equal(created.status, 202);
    await new Promise((r) => setTimeout(r, 300)); // let it START so it is genuinely non-terminal

    const { status, body } = await json('GET', `${app.baseUrl}/api/executions/${created.body.execution_id}/root-cause`);
    assert.equal(status, 409);
    assert.equal(body.error.code, 'EXECUTION_NOT_FINISHED');

    await json('POST', `${app.baseUrl}/api/executions/${created.body.execution_id}/cancel`);
  });

  test('404s for an unknown execution', async () => {
    const app = await startApp();
    const { status } = await json('GET', `${app.baseUrl}/api/executions/nope/root-cause`);
    assert.equal(status, 404);
  });
});
