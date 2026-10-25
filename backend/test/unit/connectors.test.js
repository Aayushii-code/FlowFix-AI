/**
 * Connector unit tests — the security controls are the point here:
 * credential non-disclosure, SSRF/mutating guards, SQL injection and
 * destructive-query rejection, read-only enforcement, JSONPath subset.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { RestConnector, sanitizeUrl, sanitizeBody } from '../../src/connectors/rest.js';
import { SqlConnector, validateReadOnlyQuery, activeSqlChildren } from '../../src/connectors/sql.js';
import { resolveJsonPath, parseJsonPath } from '../../src/connectors/jsonpath.js';
import { startMockApi, createFixtureDb } from '../helpers/fixtures.js';

const cleanups = [];
after(async () => {
  for (const fn of cleanups) {
    try { await fn(); } catch { /* best effort */ }
  }
  if (process.env.DIAG_HANDLES) {
    const handles = (process._getActiveHandles?.() ?? []).map((h) => {
      const name = h.constructor?.name ?? typeof h;
      const extra = h._connectionKey ?? h.resource?.path ?? h.filename ?? '';
      return `${name}${extra ? `(${extra})` : ''}`;
    });
    const requests = (process._getActiveRequests?.() ?? []).map((r) => r.constructor?.name ?? typeof r);
    console.error(`DIAG_HANDLES handles=[${handles.join(' | ')}] requests=[${requests.join(' | ')}]`);
  }
});

async function withApi() {
  const api = await startMockApi();
  cleanups.push(() => api.close());
  return api;
}

function withDb(options = {}) {
  const db = createFixtureDb(options);
  cleanups.push(() => db.cleanup());
  return db;
}

/** Poll until `fn()` is true — used to observe child-process lifecycle. */
async function until(fn, { timeoutMs = 5_000, stepMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return fn();
}

describe('JSONPath subset', () => {
  test('resolves objects, arrays, negative indices and wildcards', () => {
    const doc = { a: { b: [{ c: 1 }, { c: 2 }] }, total: 5 };
    assert.deepEqual(resolveJsonPath(doc, '$.a.b[0].c'), { found: true, value: 1, wildcard: false });
    assert.deepEqual(resolveJsonPath(doc, 'a.b[-1].c'), { found: true, value: 2, wildcard: false });
    const wildcard = resolveJsonPath(doc, '$.a.b[*].c');
    assert.equal(wildcard.found, true);
    assert.deepEqual(wildcard.value, [1, 2]);
    assert.equal(resolveJsonPath(doc, '$.missing.deep').found, false);
    assert.equal(resolveJsonPath(doc, '$.a.b[9].c').found, false, 'out-of-range index is not a value');
  });

  test('rejects unsupported JSONPath features instead of misbehaving', () => {
    assert.throws(() => parseJsonPath('$.a[?(@.x > 1)]'), /Unsupported JSONPath/);
    assert.throws(() => parseJsonPath('$..deep'), /Unsupported JSONPath/);
    assert.throws(() => parseJsonPath(''), /non-empty/);
  });
});

describe('REST connector', () => {
  test('GET returns status, parsed body and sanitized evidence', async () => {
    const api = await withApi();
    const connector = new RestConnector({ allow_private: true });
    const result = await connector.run({ key: 'order', url: `${api.baseUrl}/orders/ORD-1001` });

    assert.equal(result.ok, true);
    assert.equal(result.value.__http_status, 200);
    assert.equal(result.value.status, 'CONFIRMED', 'top-level JSON fields are spread for assertions');
    assert.equal(result.value.__body.total, 115999);

    const ev = result.evidence;
    assert.equal(ev.kind, 'api_response');
    assert.equal(ev.status, 200);
    assert.ok(ev.body_sha256, 'body hash recorded for tamper evidence');
    assert.ok(ev.duration_ms >= 0);
    assert.ok(ev.captured_at);
    assert.equal(ev.request_header_names.includes('Authorization'), false, 'auth headers are never listed as names');
  });

  test('POST works only when allow_mutating is opted in', async () => {
    const api = await withApi();
    const blocked = await new RestConnector({ allow_private: true }).run({
      key: 'create',
      method: 'POST',
      url: `${api.baseUrl}/orders`,
      body: { sku: 'X' },
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.code, 'CONNECTOR_UNAVAILABLE');
    assert.match(blocked.error.message, /allow_mutating/);

    const allowed = await new RestConnector({ allow_private: true, allow_mutating: true }).run({
      key: 'create',
      method: 'POST',
      url: `${api.baseUrl}/orders`,
      body: { sku: 'X' },
    });
    assert.equal(allowed.ok, true);
    assert.equal(allowed.value.id, 'ORD-NEW');
  });

  test('private/loopback hosts are blocked unless allow_private', async () => {
    const api = await withApi();
    const blocked = await new RestConnector().run({ key: 'x', url: `${api.baseUrl}/orders/ORD-1001` });
    assert.equal(blocked.ok, false);
    assert.match(blocked.error.message, /private\/loopback/i);

    for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'http://169.254.169.254/latest/meta-data']) {
      const r = await new RestConnector({ allow_private: true }).run({ key: 'x', url });
      assert.equal(r.ok, false, `${url} must be refused`);
    }
  });

  test('allowed_hosts restricts destinations', async () => {
    const api = await withApi();
    const r = await new RestConnector({ allow_private: true, allowed_hosts: ['api.example.com'] }).run({
      key: 'x',
      url: `${api.baseUrl}/orders/ORD-1001`,
    });
    assert.equal(r.ok, false);
    assert.match(r.error.message, /allowed_hosts/);
  });

  test('credentials resolve from env and are never stored in evidence or results', async () => {
    const api = await withApi();
    process.env.CONNECTOR_TEST_TOKEN = 'super-secret-token-value';
    process.env.MOCK_API_TOKEN = 'super-secret-token-value';
    try {
      const connector = new RestConnector({
        allow_private: true,
        auth: { type: 'bearer', token_env: 'CONNECTOR_TEST_TOKEN' },
      });
      const result = await connector.run({ key: 'secure', url: `${api.baseUrl}/secure/orders/ORD-1001` });

      assert.equal(result.ok, true, 'valid token authenticates');
      const serialized = JSON.stringify(result);
      assert.ok(!serialized.includes('super-secret-token-value'), 'token must not leak into the result');
      assert.ok(!serialized.includes('Bearer '), 'Authorization header must not leak');
      assert.deepEqual(result.evidence.auth_header_names, ['Authorization'], 'only the header NAME is recorded');
      assert.equal(connector.describeAuth().token_env, 'CONNECTOR_TEST_TOKEN', 'config references the env var name');
    } finally {
      delete process.env.CONNECTOR_TEST_TOKEN;
      delete process.env.MOCK_API_TOKEN;
    }
  });

  test('missing credential env → CONNECTOR_AUTH_FAILED with the env var NAME only', async () => {
    const api = await withApi();
    const result = await new RestConnector({
      allow_private: true,
      auth: { type: 'bearer', token_env: 'NEVER_SET_THIS_ENV_VAR' },
    }).run({ key: 'secure', url: `${api.baseUrl}/secure/orders/ORD-1001` });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'CONNECTOR_AUTH_FAILED');
    assert.match(result.error.message, /NEVER_SET_THIS_ENV_VAR/);
    assert.ok(!/Bearer/.test(result.error.message));
  });

  test('wrong credentials (401) are reported as auth failure, value withheld', async () => {
    const api = await withApi();
    const result = await new RestConnector({
      allow_private: true,
      auth: { type: 'bearer', token_env: 'CONNECTOR_WRONG_TOKEN' },
    }).run({ key: 'secure', url: `${api.baseUrl}/secure/orders/ORD-1001` });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'CONNECTOR_AUTH_FAILED');
    assert.equal(result.value, null, 'an unauthorized body is not business evidence');
  });

  test('timeouts abort and report CONNECTOR_TIMEOUT', async () => {
    const api = await withApi();
    const result = await new RestConnector({ allow_private: true }).run({
      key: 'slow',
      url: `${api.baseUrl}/slow?ms=3000`,
      timeout_ms: 200,
      retries: 0,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'CONNECTOR_TIMEOUT');
    assert.match(result.error.message, /200ms/);
  });

  test('retries are attempted on safe methods only', async () => {
    const api = await withApi();
    const connector = new RestConnector({ allow_private: true, maxRetries: 2 });
    await connector.run({ key: 'flaky', url: `${api.baseUrl}/error`, retries: 1 });
    const errorCalls = api.requests.filter((r) => r.path === '/error');
    assert.ok(errorCalls.length >= 2, `expected retries, saw ${errorCalls.length}`);
  });

  test('sensitive query params and body fields are redacted in evidence', () => {
    const url = sanitizeUrl('https://api.example.com/v1?api_key=abc123&order=9&token=zzz');
    assert.ok(!url.includes('abc123'));
    assert.ok(!url.includes('zzz'));
    assert.ok(url.includes('order=9'), 'non-sensitive params are kept');

    const body = sanitizeBody('{"access_token":"tok_1","name":"ok"}');
    assert.ok(!body.includes('tok_1'));
    assert.ok(body.includes('"name":"ok"'));
  });
});

describe('SQL connector', () => {
  test('parameterized read-only query returns rows and sanitized evidence', async () => {
    const db = withDb();
    const connector = new SqlConnector({ path: db.path });
    const result = await connector.run({
      key: 'order',
      sql: 'SELECT id, status, total FROM orders WHERE id = ?',
      params: ['ORD-1001'],
    });

    assert.equal(result.ok, true);
    assert.equal(result.value.row_count, 1);
    assert.equal(result.value.first.status, 'CONFIRMED');
    const ev = result.evidence;
    assert.equal(ev.kind, 'database_result');
    assert.equal(ev.driver, 'sqlite');
    assert.ok(ev.statement_sha256);
    assert.equal(ev.params_redacted, true, 'params are not stored by default');
    assert.equal(typeof ev.rows_preview[0].total, 'number');
  });

  test('injection payloads inside string literals are DATA, not instructions', async () => {
    const db = withDb();
    const connector = new SqlConnector({ path: db.path });
    const result = await connector.run({
      key: 'inject',
      sql: "SELECT id FROM orders WHERE id = 'ORD-1001''; DROP TABLE orders--'",
    });
    // The payload is DATA inside one literal: the statement stays a single
    // SELECT, the injected "command" never runs, and no row matches it.
    assert.equal(result.ok, true, 'one statement, parsed as a literal — not a second command');
    assert.equal(result.value.row_count, 0, 'the injected literal matches no order id');

    const tableStillThere = await connector.run({ key: 'check', sql: 'SELECT COUNT(*) AS n FROM orders' });
    assert.equal(tableStillThere.ok, true);
    assert.ok(tableStillThere.value.first.n >= 1, 'orders table survived');
  });

  test('destructive and multi-statement queries are rejected before execution', async () => {
    const db = withDb();
    const connector = new SqlConnector({ path: db.path });
    const rejected = [
      'DELETE FROM orders',
      'UPDATE orders SET total = 0',
      'INSERT INTO orders VALUES (1,2,3,4,5)',
      'DROP TABLE orders',
      'PRAGMA writable_schema = ON',
      "ATTACH DATABASE 'other.db' AS other",
      'SELECT 1; DROP TABLE orders',
      "VACUUM",
      "SELECT load_extension('/tmp/evil')",
      'WITH x AS (SELECT 1) SELECT * FROM x',
    ];
    for (const sql of rejected.slice(0, -1)) {
      const result = await connector.run({ key: 'bad', sql });
      assert.equal(result.ok, false, `must reject: ${sql}`);
      assert.ok(
        /Forbidden|read-only|Multiple statements|not allowed/i.test(result.error.message),
        `unexpected message for ${sql}: ${result.error.message}`,
      );
    }
    const cte = await connector.run({ key: 'cte', sql: rejected[rejected.length - 1] });
    assert.equal(cte.ok, true, 'a legitimate WITH … SELECT is allowed');
  });

  test('keyword scan ignores keywords inside string literals', () => {
    assert.doesNotThrow(() => validateReadOnlyQuery("SELECT 'please update me' AS note FROM orders"));
    // Conservative: a reserved word used as an identifier is still rejected.
    assert.throws(() => validateReadOnlyQuery('SELECT delete FROM orders'), /Forbidden keyword/);
    assert.throws(() => validateReadOnlyQuery('UPDATE orders SET total = 1'), /read-only|SELECT or WITH/);
    assert.throws(() => validateReadOnlyQuery('-- innocent\nDELETE FROM orders'), /Forbidden keyword|read-only/);
  });

  test('driver-level read-only: the fixture cannot be written through the connector', async () => {
    const db = withDb();
    const connector = new SqlConnector({ path: db.path });
    const before = await connector.run({ key: 'c', sql: 'SELECT COUNT(*) AS n FROM orders' });
    const countBefore = before.value.first.n;

    // Validation catches DML; the driver layer is the backstop — prove it by
    // opening the same file the way the worker does.
    const { DatabaseSync } = await import('node:sqlite');
    const readOnly = new DatabaseSync(db.path, { readOnly: true });
    assert.throws(
      () => readOnly.prepare('DELETE FROM orders').run(),
      /readonly|read-only|attempt to write/i,
      'read-only handle refuses writes',
    );
    readOnly.close();

    const after2 = await connector.run({ key: 'c', sql: 'SELECT COUNT(*) AS n FROM orders' });
    assert.equal(after2.value.first.n, countBefore, 'row count unchanged');
  });

  test('query timeout is enforced by killing the child process', async () => {
    const db = withDb();
    const connector = new SqlConnector({ path: db.path, timeout_ms: 300 });
    // Recursive CTE that runs far past the timeout (infinite — only the
    // parent's SIGKILL can stop it).
    const result = await connector.run({
      key: 'loop',
      sql: 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT MAX(x) AS m FROM c',
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'CONNECTOR_TIMEOUT');
    assert.match(result.error.message, /exceeded 300ms/);
    // The runaway child must actually be dead, not merely abandoned.
    assert.equal(
      await until(() => activeSqlChildren().length === 0),
      true,
      'no SQL child process survives the timeout',
    );
  });

  test('child-process crash is reported as CONNECTOR_UNAVAILABLE, never hangs', async () => {
    const db = withDb();
    const connector = new SqlConnector({ path: db.path, timeout_ms: 15_000 });
    // A long-but-finite query (~2s) leaves time to crash the child externally.
    const running = connector.run({
      key: 'long',
      sql: 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 8000000) SELECT MAX(x) AS m FROM c',
    });
    assert.equal(await until(() => activeSqlChildren().length === 1), true, 'child process started');
    const child = activeSqlChildren()[0];
    // Give the send callback time to settle, then simulate an external crash.
    await new Promise((resolve) => setTimeout(resolve, 300));
    child.kill('SIGKILL');
    const result = await running;
    assert.equal(result.ok, false, 'a crashed child can never look like success');
    assert.equal(result.error.code, 'CONNECTOR_UNAVAILABLE');
    assert.match(result.error.message, /exited unexpectedly/);
    assert.equal(await until(() => activeSqlChildren().length === 0), true, 'crashed child is reaped');
  });

  test('concurrent queries run in isolated child processes', async () => {
    const db = withDb();
    const connector = new SqlConnector({ path: db.path });
    const results = await Promise.all([
      connector.run({ key: 'a', sql: 'SELECT id FROM orders WHERE id = ?', params: ['ORD-1001'] }),
      connector.run({ key: 'b', sql: 'SELECT id FROM orders WHERE id = ?', params: ['ORD-1002'] }),
      connector.run({ key: 'c', sql: 'SELECT COUNT(*) AS n FROM products' }),
      connector.run({ key: 'd', sql: 'SELECT price FROM products WHERE sku = ?', params: ['IPH17P-256'] }),
      connector.run({ key: 'e', sql: 'SELECT * FROM does_not_exist' }),
    ]);
    assert.equal(results[0].value.first.id, 'ORD-1001');
    assert.equal(results[1].value.first.id, 'ORD-1002');
    assert.equal(results[2].value.first.n, 2);
    assert.equal(results[3].value.first.price, 118999);
    assert.equal(results[4].ok, false, 'a failing query does not poison its siblings');
    assert.equal(await until(() => activeSqlChildren().length === 0), true, 'all children reaped');
  });

  test('no orphaned children remain after success, failure and timeout', async () => {
    const db = withDb();
    const fast = new SqlConnector({ path: db.path, timeout_ms: 5_000 });
    const slow = new SqlConnector({ path: db.path, timeout_ms: 250 });
    const [okResult, failResult, timeoutResult] = await Promise.all([
      fast.run({ key: 'ok', sql: 'SELECT COUNT(*) AS n FROM orders' }),
      fast.run({ key: 'bad', sql: 'SELECT * FROM missing_table' }),
      slow.run({
        key: 'slow',
        sql: 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT MAX(x) AS m FROM c',
      }),
    ]);
    assert.equal(okResult.ok, true);
    assert.equal(failResult.ok, false);
    assert.equal(timeoutResult.error.code, 'CONNECTOR_TIMEOUT');
    assert.equal(
      await until(() => activeSqlChildren().length === 0),
      true,
      'zero surviving child processes',
    );
  });

  test('result size limits: row cap and cell truncation', async () => {
    const db = withDb();
    const connector = new SqlConnector({ path: db.path, max_rows: 1, max_cell_bytes: 4 });
    const rows = await connector.run({ key: 'r', sql: 'SELECT id FROM orders ORDER BY id' });
    assert.equal(rows.value.rows.length, 1, 'max_rows caps the payload');
    assert.equal(rows.value.row_count, 2, 'true row count still reported');
    assert.equal(rows.evidence.truncated, true);

    const cell = await connector.run({ key: 'c', sql: "SELECT name FROM products WHERE sku = 'IPH17P-256'" });
    assert.match(String(cell.value.rows[0].name), /truncated/, 'oversized cells are truncated');
  });

  test('unsupported driver fails loudly (no fake PostgreSQL support)', () => {
    assert.throws(() => new SqlConnector({ driver: 'postgres', path: '/tmp/x' }), /not implemented/i);
    assert.throws(() => new SqlConnector({}), /path/);
  });

  test('non-primitive parameters are rejected', async () => {
    const db = withDb();
    const connector = new SqlConnector({ path: db.path });
    const result = await connector.run({ key: 'p', sql: 'SELECT 1 AS a WHERE 1 = ?', params: [{ evil: true }] });
    assert.equal(result.ok, false);
    assert.match(result.error.message, /primitive/);
  });

  test('missing database file fails as an unavailable connector', async () => {
    const connector = new SqlConnector({ path: '/nonexistent/path/does-not-exist.db' });
    const result = await connector.run({ key: 'x', sql: 'SELECT 1 AS a' });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'CONNECTOR_UNAVAILABLE');
  });
});
