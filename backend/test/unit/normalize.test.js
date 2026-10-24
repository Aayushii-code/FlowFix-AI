/**
 * Normalizer unit tests: provenance on every item, no fabrication of absent
 * data, and the execution-vs-verification separation (COMPLETED is never a
 * PASS — normalize.js does not produce verdicts at all).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeExecution, normalizeExecutionStatus, extractRunId } from '../../src/execution/normalize.js';

const SSE_HAPPY_PATH = [
  { type: 'STARTED', run_id: 'run_abc', timestamp: '2026-10-24T10:00:00Z' },
  { type: 'STREAMING_URL', run_id: 'run_abc', streaming_url: 'https://stream/abc', timestamp: '2026-10-24T10:00:01Z' },
  { type: 'PROGRESS', run_id: 'run_abc', purpose: 'Navigate to shop', timestamp: '2026-10-24T10:00:02Z' },
  { type: 'PROGRESS', run_id: 'run_abc', purpose: 'Search for table', timestamp: '2026-10-24T10:00:05Z' },
  { type: 'HEARTBEAT', run_id: 'run_abc', timestamp: '2026-10-24T10:00:06Z' },
  {
    type: 'COMPLETE',
    run_id: 'run_abc',
    status: 'COMPLETED',
    result: { products: [{ name: 'Wooden Table', price: '£49.00' }] },
    timestamp: '2026-10-24T10:00:10Z',
  },
];

const RUN_OBJECT = {
  run_id: 'run_abc',
  status: 'COMPLETED',
  num_of_steps: 2,
  started_at: '2026-10-24T10:00:00Z',
  finished_at: '2026-10-24T10:00:10Z',
  streaming_url: 'https://stream/abc',
  video_url: null,
  steps: [
    { id: 's1', timestamp: '2026-10-24T10:00:02Z', status: 'COMPLETED', action: 'Navigate', screenshot: 'https://img/s1', html: 'https://html/s1', duration: '1.0s' },
    { id: 's2', timestamp: '2026-10-24T10:00:05Z', status: 'COMPLETED', action: 'Search', screenshot: null, html: null, duration: '0.9s' },
  ],
};

test('extracts run id from the first event carrying it', () => {
  assert.equal(extractRunId(SSE_HAPPY_PATH), 'run_abc');
  assert.equal(extractRunId([]), null);
});

test('happy path: status COMPLETED with steps, result, evidence and provenance', () => {
  const record = normalizeExecution({ events: SSE_HAPPY_PATH, runObject: RUN_OBJECT });

  assert.equal(record.execution_status, 'COMPLETED');
  assert.equal(record.tinyfish_run_id, 'run_abc');
  assert.equal(record.step_count, 2);

  // Agent steps from PROGRESS events
  const steps = record.observations.filter((o) => o.kind === 'agent_step');
  assert.equal(steps.length, 2);
  assert.equal(steps[0].action, 'Navigate to shop');
  for (const s of steps) assert.ok(s.source, 'every observation carries provenance');

  // Result observation keeps the agent's actual payload
  const resultObs = record.observations.find((o) => o.kind === 'agent_result');
  assert.deepEqual(resultObs.result.value, { products: [{ name: 'Wooden Table', price: '£49.00' }] });
  assert.equal(resultObs.source, 'tinyfish_sse:COMPLETE.result');

  // Evidence: only step s1 has a screenshot URL — s2's null must NOT appear
  const shots = record.evidence.filter((e) => e.kind === 'step_screenshot');
  assert.equal(shots.length, 1);
  assert.equal(shots[0].url, 'https://img/s1');
  assert.equal(shots[0].step_id, 's1');

  // HTML snapshot from s1, live stream, raw event log
  assert.ok(record.evidence.some((e) => e.kind === 'step_html' && e.url === 'https://html/s1'));
  assert.ok(record.evidence.some((e) => e.kind === 'live_stream' && e.url === 'https://stream/abc'));
  const rawLog = record.evidence.find((e) => e.kind === 'raw_event_log');
  assert.equal(rawLog.event_count, 6);
  assert.equal(rawLog.events.length, 6);

  for (const e of record.evidence) assert.ok(e.source, 'every evidence item carries provenance');

  // The note reminding consumers execution ≠ verification is present
  assert.match(record.execution_note, /not requirement verification/i);
});

test('no run object: evidence limited to stream facts, no invented screenshots', () => {
  const record = normalizeExecution({ events: SSE_HAPPY_PATH, runObject: null });
  assert.equal(record.evidence.filter((e) => e.kind === 'step_screenshot').length, 0);
  assert.equal(record.evidence.filter((e) => e.kind === 'live_stream').length, 1); // from COMPLETE.streaming_url
  assert.ok(record.evidence.some((e) => e.kind === 'raw_event_log'));
});

test('wrapped result (bare list under result.result) is labeled, not reshaped', () => {
  const events = [
    { type: 'STARTED', run_id: 'r', timestamp: 't' },
    { type: 'COMPLETE', run_id: 'r', status: 'COMPLETED', result: { result: ['a', 'b'] }, timestamp: 't2' },
  ];
  const record = normalizeExecution({ events });
  const resultObs = record.observations.find((o) => o.kind === 'agent_result');
  assert.equal(resultObs.result.format, 'wrapped');
  assert.deepEqual(resultObs.result.value, ['a', 'b']);
});

test('plain-text result is labeled as text', () => {
  const events = [
    { type: 'COMPLETE', run_id: 'r', status: 'COMPLETED', result: 'The title is Example Domain', timestamp: 't' },
  ];
  const record = normalizeExecution({ events });
  const resultObs = record.observations.find((o) => o.kind === 'agent_result');
  assert.equal(resultObs.result.format, 'text');
  assert.equal(resultObs.result.value, 'The title is Example Domain');
});

test('FAILED upstream keeps the upstream error verbatim', () => {
  const events = [
    { type: 'STARTED', run_id: 'r', timestamp: 't' },
    { type: 'COMPLETE', run_id: 'r', status: 'FAILED', error: { code: 'service_busy', message: 'Browser crashed', category: 'SYSTEM_FAILURE', retry_after: 60 }, timestamp: 't2' },
  ];
  const record = normalizeExecution({ events });
  assert.equal(record.execution_status, 'FAILED');
  assert.equal(record.upstream_error.code, 'service_busy');
  assert.equal(record.upstream_error.retry_after, 60);
});

test('timeout and cancel override upstream status', () => {
  assert.equal(normalizeExecutionStatus({ timedOut: true, completeStatus: 'COMPLETED' }), 'TIMED_OUT');
  assert.equal(normalizeExecutionStatus({ cancelled: true, completeStatus: 'COMPLETED' }), 'CANCELLED');
  const timedOut = normalizeExecution({ events: SSE_HAPPY_PATH, timedOut: true });
  assert.equal(timedOut.execution_status, 'TIMED_OUT');
});

test('stream ending while upstream still RUNNING is INCOMPLETE, not COMPLETED', () => {
  const events = [
    { type: 'STARTED', run_id: 'r', timestamp: 't' },
    { type: 'COMPLETE', run_id: 'r', status: 'RUNNING', timestamp: 't2' }, // pathological but defensive
  ];
  const record = normalizeExecution({ events });
  assert.equal(record.execution_status, 'INCOMPLETE');
});

test('empty events: record is honest about missing data, nothing fabricated', () => {
  const record = normalizeExecution({ events: [] });
  assert.equal(record.execution_status, 'INCOMPLETE');
  assert.equal(record.tinyfish_run_id, null);
  assert.equal(record.observations.length, 0);
  assert.equal(record.evidence.find((e) => e.kind === 'raw_event_log').event_count, 0);
});

test('normalize.js NEVER emits a verdict field anywhere', () => {
  const record = normalizeExecution({ events: SSE_HAPPY_PATH, runObject: RUN_OBJECT });
  const flat = JSON.stringify(record).toLowerCase();
  assert.ok(!flat.includes('"verdict"'), 'no verdict key in the execution record');
  assert.ok(!flat.includes('"pass"'), 'no PASS value in the execution record');
});
