/**
 * Verification adapter unit tests. The critical invariant: the adapter can
 * only surface PASS when the engine literally returned PASS — malformed,
 * missing, timed-out or erroring responses all collapse to verdict=null.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { VerificationAdapter } from '../../src/verification/adapter.js';

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({ baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

const PAYLOAD = {
  executionId: 'e1',
  scenarioId: 'product-search',
  requirement: 'search must show matching products',
  url: 'https://example.com',
  goal: 'search',
  expectedOutcome: { type: 'extracted_data_matches' },
  record: { execution_status: 'COMPLETED', observations: [{ kind: 'agent_step' }], evidence: [{ kind: 'raw_event_log', event_count: 3 }] },
};

test('unconfigured adapter reports UNAVAILABLE with null verdict', async () => {
  const adapter = new VerificationAdapter({ baseUrl: '' });
  assert.equal(adapter.isConfigured(), false);
  const outcome = await adapter.verify(PAYLOAD);
  assert.equal(outcome.status, 'UNAVAILABLE');
  assert.equal(outcome.verdict, null);
});

test('engine PASS is surfaced verbatim with checks', async () => {
  const srv = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ verdict: 'PASS', summary: 'all checks green', checks: [{ id: 'c1', passed: true }] }));
  });
  const adapter = new VerificationAdapter({ baseUrl: srv.baseUrl });
  const outcome = await adapter.verify(PAYLOAD);
  await srv.close();

  assert.equal(outcome.status, 'COMPLETED');
  assert.equal(outcome.verdict, 'PASS');
  assert.equal(outcome.details.summary, 'all checks green');
  assert.deepEqual(outcome.details.checks, [{ id: 'c1', passed: true }]);
  assert.ok(outcome.details.verified_at);
});

test('engine FAIL is surfaced verbatim', async () => {
  const srv = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ verdict: 'FAIL', summary: 'keyword missing', checks: [] }));
  });
  const adapter = new VerificationAdapter({ baseUrl: srv.baseUrl });
  const outcome = await adapter.verify(PAYLOAD);
  await srv.close();
  assert.equal(outcome.verdict, 'FAIL');
});

test('malformed verdict "MAYBE" collapses to ERROR + null verdict, never coerced', async () => {
  const srv = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ verdict: 'MAYBE' }));
  });
  const adapter = new VerificationAdapter({ baseUrl: srv.baseUrl });
  const outcome = await adapter.verify(PAYLOAD);
  await srv.close();
  assert.equal(outcome.status, 'ERROR');
  assert.equal(outcome.verdict, null);
  assert.equal(outcome.details.code, 'VERIFICATION_INVALID_VERDICT');
});

test('missing verdict field collapses to ERROR + null verdict', async () => {
  const srv = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ summary: 'oops, forgot the verdict' }));
  });
  const adapter = new VerificationAdapter({ baseUrl: srv.baseUrl });
  const outcome = await adapter.verify(PAYLOAD);
  await srv.close();
  assert.equal(outcome.verdict, null);
  assert.equal(outcome.status, 'ERROR');
});

test('engine 500 → ERROR with http_status recorded', async () => {
  const srv = await startServer((req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'boom' }));
  });
  const adapter = new VerificationAdapter({ baseUrl: srv.baseUrl });
  const outcome = await adapter.verify(PAYLOAD);
  await srv.close();
  assert.equal(outcome.status, 'ERROR');
  assert.equal(outcome.verdict, null);
  assert.equal(outcome.details.http_status, 500);
});

test('engine timeout → ERROR VERIFICATION_TIMEOUT with null verdict', async () => {
  const srv = await startServer(() => {
    /* never responds */
  });
  const adapter = new VerificationAdapter({ baseUrl: srv.baseUrl, timeoutMs: 150 });
  const outcome = await adapter.verify(PAYLOAD);
  await srv.close();
  assert.equal(outcome.status, 'ERROR');
  assert.equal(outcome.verdict, null);
  assert.equal(outcome.details.code, 'VERIFICATION_TIMEOUT');
});

test('non-JSON response → ERROR, verdict null', async () => {
  const srv = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html>not json</html>');
  });
  const adapter = new VerificationAdapter({ baseUrl: srv.baseUrl });
  const outcome = await adapter.verify(PAYLOAD);
  await srv.close();
  assert.equal(outcome.status, 'ERROR');
  assert.equal(outcome.details.code, 'VERIFICATION_MALFORMED_RESPONSE');
});

test('verification payload carries observations and evidence to the engine', async () => {
  let received = null;
  const srv = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ verdict: 'INCONCLUSIVE', checks: [] }));
    });
  });
  const adapter = new VerificationAdapter({ baseUrl: srv.baseUrl });
  await adapter.verify(PAYLOAD);
  await srv.close();

  assert.equal(received.execution_id, 'e1');
  assert.equal(received.execution_status, 'COMPLETED');
  assert.deepEqual(received.observations, PAYLOAD.record.observations);
  assert.equal(received.evidence.length, 1);
  assert.equal(received.expected_outcome.type, 'extracted_data_matches');
});
