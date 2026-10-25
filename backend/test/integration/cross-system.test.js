/**
 * Cross-application verification, end-to-end over HTTP:
 * REST connector + SQL connector + one contract evaluated across systems via
 * POST /api/cross-system/verify — evidence collection, expected-vs-observed,
 * and honest PASS / FAIL / INCONCLUSIVE semantics for missing records,
 * mismatched data, unreachable connectors and auth failures.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApp } from '../../src/app.js';
import { startMockTinyFish } from '../helpers/mock-tinyfish.js';
import { startMockApi, createFixtureDb } from '../helpers/fixtures.js';

const apps = [];
const mocks = [];
const dbs = [];
after(async () => {
  for (const a of apps) await a.close().catch(() => {});
  for (const m of mocks) await m.close().catch(() => {});
  for (const d of dbs) d.cleanup();
});

function startApp(env = {}) {
  const handle = createApp({
    DATABASE_PATH: path.join(os.tmpdir(), `flowfix-cross-${crypto.randomUUID()}.db`),
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

async function withApi() {
  const api = await startMockApi();
  dbs.push({ cleanup: () => api.close() });
  return api;
}

function withDb(options = {}) {
  const db = createFixtureDb(options);
  dbs.push(db);
  return db;
}

async function appWithMock(env = {}) {
  const mockTf = await startMockTinyFish({ defaultDelayMs: 5 });
  mocks.push(mockTf);
  return startApp({ TINYFISH_API_KEY: 'test-key', TINYFISH_BASE_URL: mockTf.baseUrl, ...env });
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

const orderSql =
  'SELECT id, status, total, product_sku FROM orders WHERE id = ?';
const restOrderStep = (api, id = 'ORD-1001', key = 'order') => ({
  key,
  url: `${api.baseUrl}/orders/${id}`,
});
const sqlOrderStep = (db, id = 'ORD-1001', key = 'order') => ({
  key,
  sql: orderSql,
  params: [id],
});

describe('cross-system verification', () => {
  test('one contract verifies REST and SQL together → PASS with per-system expected vs observed', async () => {
    const app = await startApp();
    const api = await withApi();
    const db = withDb();

    const { status, body } = await json('POST', `${app.baseUrl}/api/cross-system/verify`, {
      requirement: 'Order ORD-1001 must be CONFIRMED with an identical total in the API and the database',
      checks: [
        { key: 'api_status', source: 'api', via: 'order', path: 'status', operator: 'equals', expected: 'CONFIRMED' },
        { key: 'db_total', source: 'database', via: 'order', path: 'first.total', operator: 'equals', expected: 115999 },
      ],
      comparisons: [
        {
          key: 'total_agrees',
          description: 'API total equals database total',
          left: { source: 'api', key: 'order', path: 'total' },
          right: { source: 'database', key: 'order', path: 'first.total' },
          operator: 'equals',
        },
      ],
      steps: { rest: [restOrderStep(api)], sql: [sqlOrderStep(db)] },
      connectors: { rest: { allow_private: true }, sql: { path: db.path } },
    });

    assert.equal(status, 200, JSON.stringify(body));
    const v = body.verification;
    assert.equal(v.status, 'COMPLETED');
    assert.equal(v.verdict, 'PASS');
    assert.equal(v.details.cross_system, true);
    assert.deepEqual(v.details.failed_checks ?? [], []);
    for (const check of v.details.checks) {
      assert.equal(check.status, 'pass', `${check.key} should pass`);
      assert.equal(check.independent, true, `${check.key} is backed by an independent source`);
      assert.ok(check.evidence_ref, `${check.key} references its evidence`);
    }

    // Expected vs observed is exposed for every check and comparison.
    const expected = Object.fromEntries(v.details.expected_result.map((e) => [e.key, e.expected]));
    const observed = Object.fromEntries(v.details.observed_result.map((e) => [e.key, e.observed]));
    assert.equal(expected.api_status, 'CONFIRMED');
    assert.equal(observed.api_status, 'CONFIRMED');
    assert.equal(expected.db_total, 115999);
    assert.equal(observed.db_total, 115999);
    assert.equal(observed.total_agrees, 115999);
    assert.equal(expected.total_agrees, 115999);

    // Per-system roll-up: which system proved what.
    const byId = Object.fromEntries(body.systems.map((s) => [s.id, s]));
    assert.deepEqual(
      Object.keys(byId).sort(),
      ['cross', 'database', 'rest'],
      'one bucket per participating system',
    );
    assert.equal(byId.rest.pass, 1);
    assert.equal(byId.database.pass, 1);
    assert.equal(byId.cross.pass, 1);
    const restCheck = byId.rest.checks.find((c) => c.key === 'api_status');
    assert.equal(restCheck.expected, 'CONFIRMED');
    assert.equal(restCheck.observed, 'CONFIRMED');
    const comparisonCheck = byId.cross.checks.find((c) => c.key === 'total_agrees');
    assert.equal(comparisonCheck.kind, 'comparison');
    assert.equal(comparisonCheck.left.source, 'api');
    assert.equal(comparisonCheck.right.source, 'database');

    // Evidence: sanitized, provenance-tagged artifacts from both connectors.
    assert.deepEqual(body.connector_errors, []);
    assert.equal(body.evidence.api_responses.length, 1);
    assert.equal(body.evidence.database_results.length, 1);
    const apiEv = body.evidence.api_responses[0];
    assert.equal(apiEv.kind, 'api_response');
    assert.equal(apiEv.status, 200);
    assert.ok(apiEv.body_sha256, 'response body is hash-attested');
    assert.ok(apiEv.source.startsWith('rest_connector:'));
    const sqlEv = body.evidence.database_results[0];
    assert.equal(sqlEv.kind, 'database_result');
    assert.equal(sqlEv.driver, 'sqlite');
    assert.ok(sqlEv.statement_sha256);
    assert.equal(sqlEv.params_redacted, true, 'bound parameters are not stored');
  });

  test('mismatched totals across REST and SQL → FAIL with expected vs observed', async () => {
    const app = await startApp();
    const api = await withApi();
    const db = withDb({ divergentOrder: true }); // DB says 99999, API says 115999

    const { status, body } = await json('POST', `${app.baseUrl}/api/cross-system/verify`, {
      requirement: 'API and database must agree on the order total',
      checks: [
        { key: 'db_total', source: 'database', via: 'order', path: 'first.total', operator: 'equals', expected: 115999 },
      ],
      comparisons: [
        {
          key: 'total_agrees',
          left: { source: 'api', key: 'order', path: 'total' },
          right: { source: 'database', key: 'order', path: 'first.total' },
          operator: 'equals',
        },
      ],
      steps: { rest: [restOrderStep(api)], sql: [sqlOrderStep(db)] },
      connectors: { rest: { allow_private: true }, sql: { path: db.path } },
    });

    assert.equal(status, 200, JSON.stringify(body));
    const v = body.verification;
    assert.equal(v.verdict, 'FAIL', 'a real mismatch must never be reported as PASS');
    assert.ok(v.details.failed_checks.includes('total_agrees'));
    assert.ok(v.details.failed_checks.includes('db_total'));
    assert.ok(v.details.reason_codes.includes('CROSS_SYSTEM_MISMATCH'));

    const observed = Object.fromEntries(v.details.observed_result.map((e) => [e.key, e.observed]));
    const expected = Object.fromEntries(v.details.expected_result.map((e) => [e.key, e.expected]));
    assert.equal(observed.total_agrees, 115999, 'left side (API)');
    assert.equal(expected.total_agrees, 99999, 'right side (database)');
    assert.equal(observed.db_total, 99999);
    assert.equal(expected.db_total, 115999);

    // Diagnosis never rewrites the verdict: evidence still comes back intact.
    assert.equal(body.evidence.api_responses.length, 1);
    assert.equal(body.evidence.database_results.length, 1);
  });

  test('missing records are detected as FAIL, not papered over', async () => {
    const app = await startApp();
    const api = await withApi();
    const db = withDb();

    const { status, body } = await json('POST', `${app.baseUrl}/api/cross-system/verify`, {
      requirement: 'Order ORD-404 must exist in both the API and the database',
      checks: [
        { key: 'api_order', source: 'api', via: 'rest_order', path: 'status', operator: 'exists', expected: true },
        { key: 'db_order', source: 'database', via: 'sql_order', path: 'first', operator: 'exists', expected: true },
      ],
      steps: {
        rest: [restOrderStep(api, 'ORD-404', 'rest_order')],
        sql: [sqlOrderStep(db, 'ORD-404', 'sql_order')],
      },
      connectors: { rest: { allow_private: true }, sql: { path: db.path } },
    });

    assert.equal(status, 200, JSON.stringify(body));
    const v = body.verification;
    assert.equal(v.verdict, 'FAIL');
    assert.deepEqual(v.details.failed_checks.sort(), ['api_order', 'db_order']);
    const observed = Object.fromEntries(v.details.observed_result.map((e) => [e.key, e.observed]));
    assert.equal(observed.api_order, null, 'API 404 has no status to observe');
    assert.equal(observed.db_order, null, 'SQL returned no row');
    // The REST 404 is still captured as evidence — a result, not a crash.
    assert.equal(body.evidence.api_responses[0].status, 404);
  });

  test('unreachable and auth-failed connectors → INCONCLUSIVE, never PASS', async () => {
    const app = await startApp();
    const api = await withApi();
    const db = withDb();

    const { status, body } = await json('POST', `${app.baseUrl}/api/cross-system/verify`, {
      requirement: 'Order must be confirmed in the API (secure) and reachable API and database',
      checks: [
        { key: 'api_order', source: 'api', via: 'api_order', path: 'status', operator: 'equals', expected: 'CONFIRMED' },
        { key: 'secure_order', source: 'api', via: 'secure_order', path: 'status', operator: 'equals', expected: 'CONFIRMED' },
        { key: 'db_total', source: 'database', via: 'order', path: 'first.total', operator: 'equals', expected: 115999 },
      ],
      steps: {
        rest: [
          { key: 'api_order', url: 'http://127.0.0.1:1/orders/ORD-1001' }, // unreachable
          { key: 'secure_order', url: `${api.baseUrl}/secure/orders/ORD-1001` }, // 401, no token
        ],
        sql: [sqlOrderStep(db)],
      },
      connectors: { rest: { allow_private: true }, sql: { path: db.path } },
    });

    assert.equal(status, 200, JSON.stringify(body));
    const v = body.verification;
    assert.equal(v.verdict, 'INCONCLUSIVE', 'unknown stays unknown — no guessed verdict');
    assert.ok(!body.systems.some((s) => s.fail > 0 && s.id === 'rest'), 'connector outage is not a product failure');
    assert.ok(v.details.failed_checks.length === 0);

    const byKey = Object.fromEntries(v.details.checks.map((c) => [c.key, c]));
    assert.equal(byKey.api_order.status, 'inconclusive');
    assert.ok(byKey.api_order.reason_codes.includes('CONNECTOR_UNAVAILABLE'));
    assert.equal(byKey.secure_order.status, 'inconclusive');
    assert.ok(byKey.secure_order.reason_codes.includes('CONNECTOR_AUTH_FAILED'));
    assert.equal(byKey.db_total.status, 'pass', 'healthy systems still verify');

    const codes = new Set(body.connector_errors.map((e) => e.code));
    assert.ok(codes.has('CONNECTOR_UNAVAILABLE'), 'unreachable endpoint recorded');
    assert.ok(codes.has('CONNECTOR_AUTH_FAILED'), 'auth failure recorded');
    for (const err of body.connector_errors) {
      assert.ok(!JSON.stringify(err).includes('Bearer'), 'no credential material in connector errors');
    }
  });

  test('dependency ordering: an unmet precondition is INCONCLUSIVE, not a failure', async () => {
    const app = await startApp();
    const api = await withApi();
    const db = withDb();

    const { status, body } = await json('POST', `${app.baseUrl}/api/cross-system/verify`, {
      requirement: 'Order must be shipped in the API before its database row is judged',
      checks: [
        { key: 'pre', source: 'api', via: 'order', path: 'status', operator: 'equals', expected: 'SHIPPED' },
        {
          key: 'dep',
          source: 'database',
          via: 'order',
          path: 'first.status',
          operator: 'equals',
          expected: 'CONFIRMED',
          depends_on: ['pre'],
        },
      ],
      steps: { rest: [restOrderStep(api)], sql: [sqlOrderStep(db)] },
      connectors: { rest: { allow_private: true }, sql: { path: db.path } },
    });

    assert.equal(status, 200, JSON.stringify(body));
    const v = body.verification;
    assert.equal(v.verdict, 'FAIL', 'the precondition genuinely failed (CONFIRMED ≠ SHIPPED)');
    assert.deepEqual(v.details.failed_checks, ['pre']);
    assert.deepEqual(v.details.inconclusive_checks, ['dep'], 'the dependent check never ran');

    const byKey = Object.fromEntries(v.details.checks.map((c) => [c.key, c]));
    assert.equal(byKey.dep.status, 'inconclusive');
    // The reason lives on the blocked check itself — the overall verdict is
    // FAIL because the precondition failed, not because the dependent did.
    assert.ok(byKey.dep.reason_codes.includes('DEPENDENCY_NOT_MET'));
    assert.deepEqual(byKey.dep.unmet_dependencies, ['pre']);
    assert.deepEqual(byKey.dep.depends_on, ['pre']);
    assert.equal(byKey.dep.observed, null, 'blocked checks observe nothing');
  });

  test('a cross-system verdict attaches to its execution and shows in the Evidence Viewer', async () => {
    const app = await appWithMock();
    const api = await withApi();
    const db = withDb();
    const exec = await runToTerminal(app.baseUrl, { scenario_id: 'content-freshness' });
    assert.equal(exec.status, 'COMPLETED');

    const { status, body } = await json('POST', `${app.baseUrl}/api/cross-system/verify`, {
      execution_id: exec.execution_id,
      requirement: 'Browser run plus API and database agree on the order',
      checks: [
        { key: 'api_status', source: 'api', via: 'order', path: 'status', operator: 'equals', expected: 'CONFIRMED' },
        { key: 'db_total', source: 'database', via: 'order', path: 'first.total', operator: 'equals', expected: 115999 },
      ],
      steps: { rest: [restOrderStep(api)], sql: [sqlOrderStep(db)] },
      connectors: { rest: { allow_private: true }, sql: { path: db.path } },
    });

    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.verification.verdict, 'PASS');
    assert.equal(body.verification.details.execution_id, exec.execution_id, 'linked to the run');

    // The execution now carries the cross-system verification.
    const { body: view } = await json('GET', `${app.baseUrl}/api/executions/${exec.execution_id}`);
    assert.equal(view.verification.verdict, 'PASS');
    assert.equal(view.verification.details.cross_system, true);

    // Evidence Viewer exposes REST and SQL evidence with provenance.
    const { status: evStatus, body: ev } = await json(
      'GET',
      `${app.baseUrl}/api/executions/${exec.execution_id}/evidence`,
    );
    assert.equal(evStatus, 200);
    assert.equal(ev.artifacts.api_responses.length, 1, 'REST evidence visible in the viewer');
    assert.equal(ev.artifacts.database_results.length, 1, 'SQL evidence visible in the viewer');
    assert.equal(ev.artifacts.api_responses[0].kind, 'api_response');
    assert.equal(ev.artifacts.database_results[0].kind, 'database_result');
    const provenanceKeys = Object.keys(ev.provenance);
    assert.ok(provenanceKeys.some((k) => k.startsWith('rest_connector:')), 'REST provenance recorded');
    assert.ok(provenanceKeys.some((k) => k.startsWith('sql_connector:')), 'SQL provenance recorded');
    assert.equal(ev.verification.verdict, 'PASS');
  });
});
