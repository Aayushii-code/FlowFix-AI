/**
 * TinyFish client: run-object lookup must have its own deadline.
 *
 * The execution watchdog is disarmed once the SSE stream ends, so GET
 * /v1/runs/:id carries its own AbortController timeout (15s by default).
 * These tests cover the default, the configurable timeout, prompt abort
 * behavior, and that existing error mapping is unchanged.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { TinyFishClient, RUN_LOOKUP_TIMEOUT_MS } from '../../src/tinyfish/client.js';

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () =>
          new Promise((r) => {
            server.close(r);
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

test('run lookup timeout defaults to 15 seconds', () => {
  assert.equal(RUN_LOOKUP_TIMEOUT_MS, 15_000);
});

test('getRun resolves normally under the default timeout', async () => {
  const srv = await startServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ run_id: 'run_ok', status: 'COMPLETED', steps: [] }));
  });
  try {
    const client = new TinyFishClient({ apiKey: 'test-key', baseUrl: srv.baseUrl });
    const run = await client.getRun('run_ok');
    assert.equal(run.run_id, 'run_ok');
    assert.equal(run.status, 'COMPLETED');
  } finally {
    await srv.close();
  }
});

test('getRun aborts a stalled lookup with TINYFISH_TIMEOUT', async () => {
  const srv = await startServer(() => {
    /* never responds — simulates a stalled control-plane API */
  });
  try {
    const client = new TinyFishClient({ apiKey: 'test-key', baseUrl: srv.baseUrl });
    const started = Date.now();
    await assert.rejects(
      () => client.getRun('run_stalled', { timeoutMs: 150 }),
      (err) => {
        assert.equal(err.code, 'TINYFISH_TIMEOUT');
        assert.equal(err.retryable, true);
        assert.equal(err.details.timeout_ms, 150);
        assert.equal(err.details.run_id, 'run_stalled');
        return true;
      },
    );
    assert.ok(Date.now() - started < 3000, 'lookup aborted promptly instead of hanging');
  } finally {
    await srv.close();
  }
});

test('getRun preserves documented upstream error mapping (404 NOT_FOUND)', async () => {
  const srv = await startServer((_req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: "Run with id 'x' not found" } }));
  });
  try {
    const client = new TinyFishClient({ apiKey: 'test-key', baseUrl: srv.baseUrl });
    await assert.rejects(
      () => client.getRun('missing'),
      (err) => {
        assert.equal(err.code, 'TINYFISH_NOT_FOUND');
        assert.equal(err.httpStatus, 404);
        return true;
      },
    );
  } finally {
    await srv.close();
  }
});

test('getRun sends the X-API-Key header and screenshots mode', async () => {
  let seen = null;
  const srv = await startServer((req, res) => {
    seen = { key: req.headers['x-api-key'], url: req.url };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ run_id: 'run_h', steps: [] }));
  });
  try {
    const client = new TinyFishClient({ apiKey: 'secret-key', baseUrl: srv.baseUrl });
    await client.getRun('run_h', { screenshots: 'none' });
    assert.equal(seen.key, 'secret-key');
    assert.match(seen.url, /screenshots=none/);
  } finally {
    await srv.close();
  }
});
