/**
 * Contract Library — CRUD, multi-check contracts, revision history, audit
 * trail, contract-driven execution and *durable* storage.
 *
 * The restart test is the important one: it proves contracts survive the
 * process (SQLite file), not just an in-memory map.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createApp } from '../../src/app.js';
import { startMockTinyFish } from '../helpers/mock-tinyfish.js';

const cleanup = [];
after(async () => {
  for (const fn of cleanup) {
    try {
      await fn();
    } catch {
      /* best effort */
    }
  }
});

function tempDb() {
  return path.join(os.tmpdir(), `flowfix-contracts-${crypto.randomUUID()}.db`);
}

/** Start an app on an ephemeral port; register teardown for server + DB. */
function startApp(env = {}) {
  const dbPath = env.DATABASE_PATH ?? tempDb();
  const handle = createApp({ DATABASE_PATH: dbPath, ...env });
  const { app, close: closeApp } = handle;
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      let closed = false;
      const h = {
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        dbPath,
        engine: handle.engine,
        close: async () => {
          if (closed) return;
          closed = true;
          await new Promise((r) => {
            server.close(r);
            server.closeAllConnections?.();
          });
          await closeApp();
        },
      };
      cleanup.push(async () => {
        await h.close().catch(() => {});
        for (const suffix of ['', '-wal', '-shm']) {
          fs.rmSync(`${dbPath}${suffix}`, { force: true });
        }
      });
      resolve(h);
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

const VALID_CONTRACT = {
  name: 'Landing page headline',
  description: 'Marketing page must keep its headline',
  requirement: 'The landing page displays the headline "Example Domain".',
  url: 'https://example.com',
  goal: 'Report the h1 headline of the page and quote it exactly.',
  risk_level: 'high',
  preconditions: ['Visitor is anonymous'],
  steps: ['Open the landing page', 'Read the h1'],
  expected_results: ['Headline equals Example Domain'],
  evidence_requirements: ['Page snapshot fetched independently'],
  checks: [
    { key: 'headline', description: 'h1 shows Example Domain', operator: 'contains', expected: 'Example Domain', severity: 'high' },
    { key: 'illustrative', operator: 'contains', expected: 'illustrative', severity: 'medium' },
  ],
};

describe('Contract Library — create & validate', () => {
  test('POST /api/contracts creates a multi-check contract → 201', async () => {
    const app = await startApp();
    const { status, body } = await json('POST', `${app.baseUrl}/api/contracts`, VALID_CONTRACT);
    assert.equal(status, 201);
    assert.equal(body.contract.name, VALID_CONTRACT.name);
    assert.equal(body.contract.requirement, VALID_CONTRACT.requirement);
    assert.equal(body.contract.version, 1);
    assert.equal(body.contract.status, 'active');
    assert.equal(body.contract.risk_level, 'high');
    assert.equal(body.contract.checks.length, 2);
    assert.equal(body.contract.checks[0].source, 'page', 'default evidence source');
    assert.equal(body.contract.steps.length, 2);
    assert.ok(body.contract.id);
    assert.ok(body.contract.created_at);
  });

  test('rejects a contract with no checks — it could never be verified', async () => {
    const app = await startApp();
    const { status, body } = await json('POST', `${app.baseUrl}/api/contracts`, {
      name: 'Unverifiable',
      requirement: 'Something vague',
    });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'VALIDATION_ERROR');
    assert.match(body.error.message, /at least one check/i);
    assert.ok(body.error.details.hint, 'error tells the caller how to fix it');
  });

  test('rejects an unknown operator and lists the valid ones', async () => {
    const app = await startApp();
    const { status, body } = await json('POST', `${app.baseUrl}/api/contracts`, {
      name: 'Bad operator',
      requirement: 'r',
      checks: [{ key: 'a', operator: 'sort_of', expected: 1 }],
    });
    assert.equal(status, 400);
    assert.match(body.error.message, /checks\[0\]\.operator/);
    assert.ok(Array.isArray(body.error.details.operators));
    assert.ok(body.error.details.operators.includes('equals'));
  });

  test('rejects missing name/requirement, bad url and bad risk level', async () => {
    const app = await startApp();
    const base = { ...VALID_CONTRACT };

    assert.equal((await json('POST', `${app.baseUrl}/api/contracts`, { ...base, name: '' })).status, 400);
    assert.equal((await json('POST', `${app.baseUrl}/api/contracts`, { ...base, requirement: '  ' })).status, 400);
    assert.equal((await json('POST', `${app.baseUrl}/api/contracts`, { ...base, url: 'ftp://x' })).status, 400);
    assert.equal((await json('POST', `${app.baseUrl}/api/contracts`, { ...base, risk_level: 'catastrophic' })).status, 400);
    assert.equal((await json('POST', `${app.baseUrl}/api/contracts`, { ...base, checks: 'nope' })).status, 400);
  });
});

describe('Contract Library — read, search, revise', () => {
  test('list supports search, pagination and risk filter', async () => {
    const app = await startApp();
    for (const i of [1, 2, 3]) {
      await json('POST', `${app.baseUrl}/api/contracts`, {
        ...VALID_CONTRACT,
        name: `Contract number ${i}`,
        risk_level: i === 3 ? 'critical' : 'low',
      });
    }

    const all = await json('GET', `${app.baseUrl}/api/contracts?limit=2`);
    assert.equal(all.status, 200);
    assert.equal(all.body.contracts.length, 2);
    assert.equal(all.body.total, 3);
    assert.equal(all.body.limit, 2);
    assert.equal(all.body.offset, 0);

    const page2 = await json('GET', `${app.baseUrl}/api/contracts?limit=2&offset=2`);
    assert.equal(page2.body.contracts.length, 1);

    const search = await json('GET', `${app.baseUrl}/api/contracts?q=number%202`);
    assert.equal(search.body.total, 1);
    assert.match(search.body.contracts[0].name, /number 2/);

    const filtered = await json('GET', `${app.baseUrl}/api/contracts?risk_level=critical`);
    assert.equal(filtered.body.total, 1);
  });

  test('GET by id returns the contract; unknown id 404s', async () => {
    const app = await startApp();
    const created = await json('POST', `${app.baseUrl}/api/contracts`, VALID_CONTRACT);
    const ok = await json('GET', `${app.baseUrl}/api/contracts/${created.body.contract.id}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.contract.checks.length, 2);

    const missing = await json('GET', `${app.baseUrl}/api/contracts/nope`);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'NOT_FOUND');
  });

  test('PUT bumps the version and stores the previous snapshot as a revision', async () => {
    const app = await startApp();
    const created = await json('POST', `${app.baseUrl}/api/contracts`, VALID_CONTRACT);
    const id = created.body.contract.id;

    const updated = await json('PUT', `${app.baseUrl}/api/contracts/${id}`, {
      risk_level: 'critical',
      change_note: 'Security review raised the risk',
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.contract.version, 2);
    assert.equal(updated.body.contract.risk_level, 'critical');

    const revisions = await json('GET', `${app.baseUrl}/api/contracts/${id}/revisions`);
    assert.equal(revisions.status, 200);
    assert.equal(revisions.body.revisions.length, 1);
    assert.equal(revisions.body.revisions[0].version, 1, 'snapshot of the state BEFORE the edit');
    assert.equal(revisions.body.revisions[0].snapshot.risk_level, 'high');
    assert.match(revisions.body.revisions[0].change_note, /Security review/);
  });

  test('PUT with no fields, or with an empty checks array, is rejected', async () => {
    const app = await startApp();
    const created = await json('POST', `${app.baseUrl}/api/contracts`, VALID_CONTRACT);
    const id = created.body.contract.id;

    assert.equal((await json('PUT', `${app.baseUrl}/api/contracts/${id}`, {})).status, 400);
    const clear = await json('PUT', `${app.baseUrl}/api/contracts/${id}`, { checks: [] });
    assert.equal(clear.status, 400);
    assert.match(clear.body.error.message, /unverifiable/i);
  });

  test('DELETE archives instead of destroying the audit trail', async () => {
    const app = await startApp();
    const created = await json('POST', `${app.baseUrl}/api/contracts`, VALID_CONTRACT);
    const id = created.body.contract.id;

    const removed = await json('DELETE', `${app.baseUrl}/api/contracts/${id}`);
    assert.equal(removed.status, 200);
    assert.equal(removed.body.status, 'archived');

    const list = await json('GET', `${app.baseUrl}/api/contracts`);
    assert.equal(list.body.total, 0, 'archived contracts leave the default list');

    const withArchived = await json('GET', `${app.baseUrl}/api/contracts?status=all`);
    assert.equal(withArchived.body.total, 1);

    const exec = await json('POST', `${app.baseUrl}/api/contracts/${id}/executions`, {});
    assert.equal(exec.status, 409);
    assert.equal(exec.body.error.code, 'CONTRACT_ARCHIVED');
  });
});

describe('Contract Library — execution + audit', () => {
  test('executing a contract runs the journey and tags the execution', async () => {
    const mockTf = await startMockTinyFish({ defaultDelayMs: 5 });
    const app = await startApp({ TINYFISH_API_KEY: 'test-key', TINYFISH_BASE_URL: mockTf.baseUrl });
    try {
      const created = await json('POST', `${app.baseUrl}/api/contracts`, VALID_CONTRACT);
      const id = created.body.contract.id;

      const exec = await json('POST', `${app.baseUrl}/api/contracts/${id}/executions`, {});
      assert.equal(exec.status, 202);
      assert.equal(exec.body.contract_id, id, 'execution carries its contract id');
      assert.equal(exec.body.checks.length, 2, 'contract checks travel with the execution');
      assert.equal(exec.body.requirement, VALID_CONTRACT.requirement);

      let view = exec.body;
      const deadline = Date.now() + 8000;
      while (!['COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED'].includes(view.status)) {
        assert.ok(Date.now() < deadline, 'execution should finish');
        await new Promise((r) => setTimeout(r, 40));
        view = (await json('GET', `${app.baseUrl}/api/executions/${exec.body.execution_id}`)).body;
      }
      assert.equal(view.status, 'COMPLETED');
      assert.equal(view.contract_id, id);

      // Run history filtered by contract
      const history = await json('GET', `${app.baseUrl}/api/executions?contract_id=${id}`);
      assert.equal(history.body.total, 1);
      assert.equal(history.body.executions[0].execution_id, exec.body.execution_id);
    } finally {
      await app.close();
      await mockTf.close();
    }
  });

  test('contract with no url/goal is not executable → 422', async () => {
    const app = await startApp();
    const created = await json('POST', `${app.baseUrl}/api/contracts`, {
      name: 'Pure policy rule',
      requirement: 'Orders must never be discounted below cost.',
      checks: [{ key: 'margin', operator: 'exists', expected: true }],
    });
    assert.equal(created.status, 201);

    const exec = await json('POST', `${app.baseUrl}/api/contracts/${created.body.contract.id}/executions`, {});
    assert.equal(exec.status, 422);
    assert.equal(exec.body.error.code, 'CONTRACT_NOT_EXECUTABLE');
  });

  test('every contract mutation lands in the audit log', async () => {
    const app = await startApp();
    const created = await json('POST', `${app.baseUrl}/api/contracts`, VALID_CONTRACT);
    const id = created.body.contract.id;
    await json('PUT', `${app.baseUrl}/api/contracts/${id}`, { risk_level: 'low' });
    await json('DELETE', `${app.baseUrl}/api/contracts/${id}`);

    const audit = await json('GET', `${app.baseUrl}/api/audit?entity_id=${id}`);
    assert.equal(audit.status, 200);
    const actions = audit.body.entries.map((e) => e.action);
    assert.ok(actions.includes('contract.created'));
    assert.ok(actions.includes('contract.updated'));
    assert.ok(actions.includes('contract.archived'));

    const createdEntry = audit.body.entries.find((e) => e.action === 'contract.created');
    assert.equal(createdEntry.entity_type, 'contract');
    assert.equal(createdEntry.entity_id, id);
    assert.ok(createdEntry.ts);
    assert.ok(createdEntry.details, 'audit carries the payload details');
  });
});

describe('Contract Library — durability', () => {
  test('contracts survive a full process restart (SQLite file, not memory)', async () => {
    const dbPath = tempDb();

    const first = await startApp({ DATABASE_PATH: dbPath });
    const created = await json('POST', `${first.baseUrl}/api/contracts`, VALID_CONTRACT);
    assert.equal(created.status, 201);
    const id = created.body.contract.id;
    await first.close(); // process teardown: server + DB handle both closed

    const second = await startApp({ DATABASE_PATH: dbPath });
    try {
      const fetched = await json('GET', `${second.baseUrl}/api/contracts/${id}`);
      assert.equal(fetched.status, 200, 'contract must still exist after restart');
      assert.equal(fetched.body.contract.name, VALID_CONTRACT.name);
      assert.equal(fetched.body.contract.checks.length, 2);

      const list = await json('GET', `${second.baseUrl}/api/contracts`);
      assert.equal(list.body.total, 1);
    } finally {
      await second.close();
    }
  });

  test('run history survives a restart (executions are durable records)', async () => {
    const mockTf = await startMockTinyFish({ defaultDelayMs: 5 });
    const dbPath = tempDb();
    const first = await startApp({
      DATABASE_PATH: dbPath,
      TINYFISH_API_KEY: 'test-key',
      TINYFISH_BASE_URL: mockTf.baseUrl,
    });
    try {
      let executionId;
      const created = await json('POST', `${first.baseUrl}/api/executions`, { scenario_id: 'content-freshness' });
      assert.equal(created.status, 202);
      executionId = created.body.execution_id;

      let view = created.body;
      const deadline = Date.now() + 8000;
      while (!['COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED'].includes(view.status)) {
        assert.ok(Date.now() < deadline, 'execution should finish');
        await new Promise((r) => setTimeout(r, 40));
        view = (await json('GET', `${first.baseUrl}/api/executions/${executionId}`)).body;
      }
      assert.equal(view.status, 'COMPLETED');
      await first.close();

      const second = await startApp({ DATABASE_PATH: dbPath, TINYFISH_API_KEY: 'test-key' });
      try {
        const fetched = await json('GET', `${second.baseUrl}/api/executions/${executionId}`);
        assert.equal(fetched.status, 200, 'execution retrievable after restart');
        assert.equal(fetched.body.status, 'COMPLETED');
        assert.ok(fetched.body.from_history, 'served from durable history');
        assert.ok(fetched.body.record.observations.length > 0, 'record persisted with observations');
        assert.ok(fetched.body.verification.verdict, 'verdict persisted alongside the record');

        const history = await json('GET', `${second.baseUrl}/api/executions?q=content`);
        assert.ok(history.body.total >= 1);
      } finally {
        await second.close();
      }
    } finally {
      // Never leave the mock server holding the event loop open.
      await mockTf.close().catch(() => {});
    }
  });
});
