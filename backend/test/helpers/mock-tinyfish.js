/**
 * Protocol-faithful TinyFish mock server for integration tests.
 *
 * Implements the documented surfaces used by the backend:
 *   POST /v1/automation/run-sse  → SSE stream (STARTED → STREAMING_URL →
 *                                   PROGRESS… → COMPLETE) per docs.tinyfish.ai
 *   GET  /v1/runs/:id            → run object with steps/screenshots
 *   POST /v1/runs/:id/cancel     → idempotent cancel
 *
 * Behavior is selected per-target via the URL hostname or a header-free
 * convention encoded in the target URL path, so a single mock can serve all
 * scenarios. Failure modes mimic the documented error envelopes exactly.
 */
import http from 'node:http';

let runCounter = 0;

/** Build a documented COMPLETE payload. */
function completeEvent(runId, status, result, extra = {}) {
  return { type: 'COMPLETE', run_id: runId, status, result, timestamp: new Date().toISOString(), ...extra };
}

export function startMockTinyFish({ defaultDelayMs = 10 } = {}) {
  /** @type {Map<string, {status: string, goal: string, cancelled: boolean, result: object}>} */
  const runs = new Map();
  const requests = { sse: [], getRun: [], cancel: [] };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    // Auth check per docs: missing/invalid key → documented envelope.
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'MISSING_API_KEY', message: 'X-API-Key header is required' } }));
      return;
    }
    if (apiKey === 'invalid-key') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'INVALID_API_KEY', message: 'Invalid or expired API key' }, request_id: 'req_mock_1' }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/automation/run-sse') {
      handleSse(req, res, url);
      return;
    }
    if (req.method === 'GET' && /^\/v1\/runs\/[^/]+$/.test(url.pathname)) {
      handleGetRun(req, res, url);
      return;
    }
    if (req.method === 'POST' && /^\/v1\/runs\/[^/]+\/cancel$/.test(url.pathname)) {
      handleCancel(req, res, url);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: `No route ${req.method} ${url.pathname}` } }));
  });

  function writeEvent(res, event) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function handleSse(req, res, url) {
    let body = '';
    for await (const chunk of req) body += chunk;
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'INVALID_INPUT', message: 'Malformed JSON body' } }));
      return;
    }
    requests.sse.push({ payload, at: Date.now() });

    // Validation mirrors documented INVALID_INPUT behavior.
    if (typeof payload.url !== 'string' || typeof payload.goal !== 'string' || !payload.goal) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'INVALID_INPUT', message: 'Field "goal" is required and must be a non-empty string' } }));
      return;
    }

    // Behavior selection: goal text is the switch (mock only — real TinyFish
    // picks behavior from the site itself).
    const goal = payload.goal;
    const behavior = goal.includes('BEHAVIOR:billing_reject')
      ? 'billing'
      : goal.includes('BEHAVIOR:goal_failure')
        ? 'goal_failure'
        : goal.includes('BEHAVIOR:hang')
          ? 'hang'
          : 'success';

    if (behavior === 'billing') {
      res.writeHead(402, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            code: 'INSUFFICIENT_CREDITS',
            message: "Run not started: the user's TinyFish wallet balance is too low ($-2.50).",
            details: { reason: 'wallet_out_of_funds', non_retryable: true, balance: '-2.50', currency: 'usd' },
          },
        }),
      );
      return;
    }

    const runId = `run_mock_${++runCounter}`;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const run = { status: 'RUNNING', goal, cancelled: false, result: null };
    runs.set(runId, run);

    writeEvent(res, { type: 'STARTED', run_id: runId, timestamp: new Date().toISOString() });
    await sleep(defaultDelayMs);
    writeEvent(res, {
      type: 'STREAMING_URL',
      run_id: runId,
      streaming_url: `https://stream.mock.local/${runId}`,
      timestamp: new Date().toISOString(),
    });
    writeEvent(res, { type: 'PROGRESS', run_id: runId, purpose: 'Navigate to the target page', timestamp: new Date().toISOString() });
    writeEvent(res, { type: 'PROGRESS', run_id: runId, purpose: 'Interact with page elements', timestamp: new Date().toISOString() });
    // HEARTBEAT comment frames are part of the protocol too.
    res.write(`: heartbeat\n\n`);
    await sleep(defaultDelayMs);

    if (behavior === 'hang') {
      // Keep the stream open without COMPLETE until client disconnects —
      // exercises the watchdog timeout path. Clean up on every close signal
      // so a test client that aborts can never leak this interval.
      const keepAlive = setInterval(() => {
        if (res.destroyed) return clearInterval(keepAlive);
        res.write(`: heartbeat\n\n`);
      }, 100);
      keepAlive.unref?.();
      req.on('close', () => clearInterval(keepAlive));
      res.on('close', () => clearInterval(keepAlive));
      res.on('error', () => clearInterval(keepAlive));
      return;
    }

    if (behavior === 'goal_failure') {
      // Documented trap: HTTP 200 + COMPLETED, but result reports failure.
      const result = { status: 'failure', reason: 'Could not find any products matching the term' };
      run.status = 'COMPLETED';
      run.result = result;
      writeEvent(res, completeEvent(runId, 'COMPLETED', result));
      res.end();
      return;
    }

    // Success result shaped by the goal keyword, per scenario.
    let result;
    if (goal.toLowerCase().includes('table')) {
      result = {
        products: [
          { name: 'Wooden Table', price: '£49.00' },
          { name: 'Coffee Table', price: '£29.00' },
        ],
      };
    } else if (goal.toLowerCase().includes('form') || goal.toLowerCase().includes('contact')) {
      result = {
        echoed: {
          customername: 'FlowFix Tester',
          email: 'tester@flowfix.example',
          deliverto: '1 Test Street',
          comments: 'FlowFix verification run',
        },
      };
    } else if (goal.toLowerCase().includes('headline')) {
      result = { headline: 'Example Domain', body_contains_illustrative: true };
    } else {
      result = { answer: 'done' };
    }
    run.status = 'COMPLETED';
    run.result = result;
    writeEvent(res, completeEvent(runId, 'COMPLETED', result));
    res.end();
  }

  function handleGetRun(req, res, url) {
    const runId = url.pathname.split('/').pop();
    requests.getRun.push({ runId, at: Date.now() });
    const run = runs.get(runId);
    if (!run) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: `Run with id '${runId}' not found` } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        run_id: runId,
        status: run.status,
        goal: run.goal,
        created_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        finished_at: run.status === 'COMPLETED' ? new Date().toISOString() : null,
        num_of_steps: 2,
        result: run.result,
        output_schema: null,
        profile_attached: false,
        profile_id: null,
        error: null,
        streaming_url: `https://stream.mock.local/${runId}`,
        browser_config: { proxy_enabled: false, proxy_country_code: null },
        video_url: null,
        steps: [
          {
            id: 'step-0001',
            timestamp: new Date().toISOString(),
            status: 'COMPLETED',
            action: 'Navigate to target page',
            screenshot: `https://agent.mock.local/runs/${runId}/steps/step-0001/screenshot`,
            html: `https://agent.mock.local/runs/${runId}/steps/step-0001/html`,
            duration: '1.2s',
          },
          {
            id: 'step-0002',
            timestamp: new Date().toISOString(),
            status: 'COMPLETED',
            action: 'Interact with page elements',
            screenshot: null, // real TinyFish omits screenshots sometimes; must stay null downstream
            html: null,
            duration: '0.8s',
          },
        ],
      }),
    );
  }

  function handleCancel(req, res, url) {
    const runId = url.pathname.split('/').slice(-2)[0];
    requests.cancel.push({ runId, at: Date.now() });
    const run = runs.get(runId);
    if (!run) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: `Run with id '${runId}' not found` } }));
      return;
    }
    if (!run.cancelled) {
      run.cancelled = true;
      run.status = 'CANCELLED';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'CANCELLED', cancelled_at: new Date().toISOString(), message: null }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'CANCELLED', cancelled_at: new Date().toISOString(), message: 'Run already cancelled' }));
    }
  }

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        requests,
        runs,
        close: () =>
          new Promise((r) => {
            server.close(r);
            server.closeAllConnections?.(); // destroy any open SSE/keep-alive sockets
          }),
      });
    });
  });
}

/** Mock verification engine for Meenu's contract (see docs/API.md). */
export function startMockVerificationEngine({ verdict = 'PASS', delayMs = 5, malformed = false } = {}) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.pathname === undefined && req.url !== '/verify') {
      if (req.url !== '/verify') {
        res.writeHead(404).end();
        return;
      }
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      /* ignore */
    }
    requests.push({ body: parsed, at: Date.now() });

    await new Promise((r) => setTimeout(r, delayMs));

    if (malformed) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ verdict: 'MAYBE', checks: [] }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        verdict,
        summary: `Engine evaluated the evidence and returned ${verdict}.`,
        checks: [
          { id: 'c1', description: 'primary condition', passed: verdict === 'PASS', observed: 'see evidence', expected: 'see requirement' },
        ],
      }),
    );
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        requests,
        close: () =>
          new Promise((r) => {
            server.close(r);
            server.closeAllConnections?.();
          }),
      });
    });
  });
}
