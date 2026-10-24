/**
 * Observation & evidence normalization.
 *
 * Raw material: the SSE events streamed from /v1/automation/run-sse and,
 * when available, the full run object from GET /v1/runs/:id (steps, screenshots).
 *
 * Output: a normalized record with two strictly separated lists —
 *   observations: what the browser DID and WHAT IT REPORTED (facts, with provenance)
 *   evidence:     artifacts that back those observations (URLs, timestamps, provenance)
 *
 * Hard rules:
 *  - Every item carries `source` provenance pointing at the exact upstream field.
 *  - Nothing is invented: absent data stays absent (null / empty list), never a guess.
 *  - This module NEVER produces verdicts. "COMPLETED" here means the browser
 *    finished executing — it is not a PASS for the requirement under test.
 */

/** Pull the run_id from whichever event first carried it. */
export function extractRunId(events) {
  for (const evt of events) {
    if (evt?.run_id) return evt.run_id;
  }
  return null;
}

function firstTimestamp(events) {
  for (const evt of events) {
    if (evt?.timestamp) return evt.timestamp;
  }
  return null;
}

function lastTimestamp(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.timestamp) return events[i].timestamp;
  }
  return null;
}

/**
 * Normalize PROGRESS events into step observations.
 * TinyFish PROGRESS events carry { type, run_id, purpose, timestamp }.
 */
function normalizeProgressSteps(events) {
  const steps = [];
  events.forEach((evt, index) => {
    if (evt?.type !== 'PROGRESS') return;
    steps.push({
      kind: 'agent_step',
      index,
      action: typeof evt.purpose === 'string' ? evt.purpose : null,
      observed_at: evt.timestamp ?? null,
      source: 'tinyfish_sse:PROGRESS',
    });
  });
  return steps;
}

/**
 * Normalize the COMPLETE event's result payload into result observations.
 * TinyFish may return:
 *   - a JSON object directly (result: {...})
 *   - a bare list / plain-text answer under result.result
 * We record exactly what came back plus where it lived — no reshaping beyond
 * labeling, so downstream verification sees the agent's actual output.
 */
function normalizeResult(completeEvent) {
  if (!completeEvent || completeEvent.result === undefined || completeEvent.result === null) {
    return { result: null, result_source: null };
  }
  const result = completeEvent.result;
  let labeled;
  if (result && typeof result === 'object' && !Array.isArray(result) && 'result' in result) {
    labeled = { format: 'wrapped', value: result.result, full_payload: result };
  } else if (Array.isArray(result)) {
    labeled = { format: 'list', value: result };
  } else if (typeof result === 'object' && result !== null) {
    labeled = { format: 'object', value: result };
  } else {
    labeled = { format: 'text', value: String(result) };
  }
  return { result: labeled, result_source: 'tinyfish_sse:COMPLETE.result' };
}

/**
 * Normalize steps + screenshots from the GET /v1/runs/:id run object into
 * evidence artifacts. Each screenshot/HTML URL is recorded verbatim with its
 * step linkage; nulls stay null (we do not substitute placeholders).
 */
function normalizeRunArtifacts(runObject) {
  const evidence = [];
  const steps = Array.isArray(runObject?.steps) ? runObject.steps : [];

  steps.forEach((step) => {
    evidence.push({
      kind: 'step_screenshot',
      step_id: step.id ?? null,
      url: step.screenshot ?? null,
      captured_at: step.timestamp ?? null,
      action: step.action ?? null,
      duration: step.duration ?? null,
      source: 'tinyfish_run_object:steps[].screenshot',
    });
    if (step.html) {
      evidence.push({
        kind: 'step_html',
        step_id: step.id ?? null,
        url: step.html,
        captured_at: step.timestamp ?? null,
        source: 'tinyfish_run_object:steps[].html',
      });
    }
  });

  if (runObject?.streaming_url) {
    evidence.push({
      kind: 'live_stream',
      url: runObject.streaming_url,
      note: 'Live browser view URL (valid ~24h after run start).',
      source: 'tinyfish_run_object:streaming_url',
    });
  }
  if (runObject?.video_url) {
    evidence.push({
      kind: 'run_recording',
      url: runObject.video_url,
      note: 'Run recording URL (expires ~15 minutes after fetch).',
      source: 'tinyfish_run_object:video_url',
    });
  }

  // Drop step_screenshot rows where TinyFish returned no screenshot at all —
  // an artifact entry with a null URL is not evidence.
  return evidence.filter((item) => item.kind !== 'step_screenshot' || item.url !== null);
}

/**
 * Map TinyFish's COMPLETE.status / run-object status onto our execution
 * statuses. This is execution state only — never a requirement verdict.
 */
export function normalizeExecutionStatus({ completeStatus, runObject, timedOut, cancelled }) {
  if (timedOut) return 'TIMED_OUT';
  if (cancelled) return 'CANCELLED';

  const upstream = runObject?.status ?? completeStatus ?? null;
  switch (upstream) {
    case 'COMPLETED':
      return 'COMPLETED';
    case 'FAILED':
      return 'FAILED';
    case 'CANCELLED':
      return 'CANCELLED';
    case 'PENDING':
    case 'RUNNING':
      // Upstream stream ended while run still active — treat as truncated.
      return 'INCOMPLETE';
    default:
      return upstream ? 'UNKNOWN' : 'INCOMPLETE';
  }
}

/**
 * Build the normalized execution record.
 *
 * @param {{
 *   events: object[],          // every SSE event received, in order
 *   runObject: object|null,    // GET /v1/runs/:id response if fetched
 *   timedOut?: boolean,
 *   cancelled?: boolean,
 *   upstreamError?: object|null, // TinyFish error object when FAILED
 * }} input
 */
export function normalizeExecution({ events = [], runObject = null, timedOut = false, cancelled = false, upstreamError = null }) {
  const completeEvent = events.find((e) => e?.type === 'COMPLETE') ?? null;

  const executionStatus = normalizeExecutionStatus({
    completeStatus: completeEvent?.status ?? null,
    runObject,
    timedOut,
    cancelled,
  });

  const observations = [
    ...normalizeProgressSteps(events),
  ];

  const { result, result_source } = normalizeResult(completeEvent);
  if (result !== null) {
    observations.push({
      kind: 'agent_result',
      result,
      source: result_source,
    });
  }

  const evidence = normalizeRunArtifacts(runObject);

  if (!evidence.some((e) => e.kind === 'live_stream')) {
    // The streaming URL can arrive either as its own STREAMING_URL event or
    // embedded in COMPLETE, depending on timing — take whichever exists.
    const streamingEvent = events.find((e) => e?.type === 'STREAMING_URL' && e.streaming_url);
    const streamingUrl = streamingEvent?.streaming_url ?? completeEvent?.streaming_url ?? null;
    if (streamingUrl) {
      evidence.push({
        kind: 'live_stream',
        url: streamingUrl,
        source: streamingEvent ? 'tinyfish_sse:STREAMING_URL' : 'tinyfish_sse:COMPLETE.streaming_url',
      });
    }
  }

  // Preserve the complete raw event log as first-class audit evidence.
  evidence.push({
    kind: 'raw_event_log',
    event_count: events.length,
    events,
    source: 'tinyfish_sse:stream',
  });

  const error =
    upstreamError ??
    (completeEvent?.error ?? null) ??
    (runObject?.error ?? null) ??
    null;

  return {
    execution_status: executionStatus,
    tinyfish_run_id: extractRunId(events) ?? runObject?.run_id ?? null,
    started_at: firstTimestamp(events) ?? runObject?.started_at ?? null,
    finished_at: lastTimestamp(events) ?? runObject?.finished_at ?? null,
    step_count: runObject?.num_of_steps ?? observations.filter((o) => o.kind === 'agent_step').length ?? null,
    observations,
    evidence,
    upstream_error: error,
    /**
     * Explicit reminder for consumers: a COMPLETED execution only means the
     * browser ran the journey and returned output. Whether the requirement
     * under test actually held is decided exclusively by the verification
     * engine and lives in verification.verdict — never computed here.
     */
    execution_note:
      'COMPLETED indicates successful browser execution, not requirement verification. Verdicts come only from the verification engine.',
  };
}
