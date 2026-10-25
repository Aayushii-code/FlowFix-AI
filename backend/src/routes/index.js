/**
 * API routes. Contract for Aman's frontend — see docs/API.md.
 *
 * All JSON endpoints use the envelope conventions:
 *   success → the resource object directly
 *   failure → { error: { code, message, retryable, details? } }
 */
import { Router } from 'express';
import { asyncRoute, NotFoundError, ValidationError, AppError } from '../errors.js';
import { SCENARIOS, getScenario, scenarioSummaries } from '../scenarios/index.js';
import { normalizeChecks } from '../checks/validate.js';
import { analyzeRootCause } from '../analysis/root-cause.js';

const PROFILE_VALUES = new Set(['lite', 'stealth']);

function validateExecutionInput(body) {
  if (!body || typeof body !== 'object') {
    throw new ValidationError('Request body must be a JSON object');
  }

  // Exactly one of: scenario_id, or an ad-hoc { url, goal } pair.
  const hasScenario = typeof body.scenario_id === 'string' && body.scenario_id.length > 0;
  const hasAdHoc = body.url !== undefined || body.goal !== undefined;

  if (hasScenario && hasAdHoc) {
    throw new ValidationError('Provide either scenario_id or ad-hoc url+goal, not both');
  }
  if (!hasScenario && !hasAdHoc) {
    throw new ValidationError('Provide scenario_id for a built-in scenario, or url+goal for an ad-hoc journey');
  }

  let spec;
  if (hasScenario) {
    const scenario = getScenario(body.scenario_id);
    if (!scenario) {
      throw new ValidationError(
        `Unknown scenario_id "${body.scenario_id}"`,
        { known_scenarios: SCENARIOS.map((s) => s.id) },
      );
    }
    spec = {
      scenarioId: scenario.id,
      requirement: scenario.requirement,
      url: scenario.url,
      goal: scenario.goal,
      expectedOutcome: scenario.expected_outcome,
      checks: scenario.checks ?? [],
      browserProfile: scenario.browserProfile,
      agentConfig: scenario.agentConfig,
      captureConfig: scenario.captureConfig,
    };
  } else {
    if (typeof body.url !== 'string' || !/^https?:\/\//i.test(body.url)) {
      throw new ValidationError('url must be an absolute http(s) URL');
    }
    if (typeof body.goal !== 'string' || body.goal.trim().length === 0) {
      throw new ValidationError('goal must be a non-empty string');
    }
    if (body.browser_profile !== undefined && !PROFILE_VALUES.has(body.browser_profile)) {
      throw new ValidationError('browser_profile must be "lite" or "stealth"');
    }
    spec = {
      scenarioId: null,
      requirement: typeof body.requirement === 'string' ? body.requirement : null,
      url: body.url,
      goal: body.goal,
      expectedOutcome: body.expected_outcome ?? null,
      checks: normalizeChecks(body.checks),
      browserProfile: body.browser_profile ?? undefined,
      agentConfig: body.agent_config ?? undefined,
      captureConfig: body.capture_config ?? undefined,
      outputSchema: body.output_schema ?? undefined,
    };
  }

  if (body.execution_timeout_ms !== undefined) {
    const t = Number(body.execution_timeout_ms);
    if (!Number.isFinite(t) || t <= 0) throw new ValidationError('execution_timeout_ms must be a positive number');
    spec.executionTimeoutMs = t;
  }

  return spec;
}

/**
 * Clamped pagination. `?limit=abc` or a negative offset must never turn into
 * NaN slicing (which silently returned every row).
 */
function parseLimit(value, fallback, max = 200) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, 1), max);
}

function parseOffset(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return 0;
  return Math.max(n, 0);
}

export function createRoutes({ engine, config, repos }) {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'flowfix-ai-backend',
      tinyfish_configured: config.tinyfish.configured,
      verification_configured: config.verification.configured,
      running_executions: engine.runningCount,
      max_concurrent_executions: config.execution.maxConcurrent,
      time: new Date().toISOString(),
    });
  });

  router.get('/scenarios', (_req, res) => {
    res.json({ scenarios: scenarioSummaries() });
  });

  // ── Executions ────────────────────────────────────────────────────────────

  router.post('/executions', asyncRoute((req, res) => {
    const spec = validateExecutionInput(req.body);
    const execution = engine.createExecution(spec);
    res.status(202).json(execution);
  }));

  router.get('/executions', (req, res) => {
    // Searchable run history: full-text over url/goal/requirement/id plus
    // status, verdict, contract, scenario and time-window filters.
    const result = engine.search({
      q: req.query.q ?? null,
      status: req.query.status ?? null,
      verdict: req.query.verdict ?? null,
      contract_id: req.query.contract_id ?? null,
      scenario_id: req.query.scenario_id ?? null,
      from: req.query.from ?? null,
      to: req.query.to ?? null,
      limit: parseLimit(req.query.limit, 50),
      offset: parseOffset(req.query.offset),
    });
    res.json({
      executions: result.executions,
      total: result.total,
      limit: result.limit,
      offset: result.offset,
    });
  });

  router.get('/executions/:id', asyncRoute((req, res) => {
    res.json(engine.get(req.params.id));
  }));

  router.post('/executions/:id/cancel', asyncRoute((req, res) => {
    const result = engine.cancel(req.params.id);
    res.json({ execution_id: req.params.id, ...result });
  }));

  /**
   * SSE stream for the frontend. Events:
   *   status         — lifecycle transitions
   *   upstream_event — raw TinyFish SSE events as they arrive
   *   record         — normalized observations/evidence (once execution ends)
   *   verification   — independent verdict updates from Meenu's engine
   *   terminal       — final execution status; stream then closes
   *   heartbeat      — comment frames every 15s to keep proxies alive
   */
  router.get('/executions/:id/events', asyncRoute((req, res) => {
    const view = engine.get(req.params.id); // 404s if unknown

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 3000\n\n`);
    res.write(`event: snapshot\ndata: ${JSON.stringify(view)}\n\n`);

    // Stream state. `closed` guards every write so we can never emit after
    // res.end() (later lifecycle events like verification can still fire
    // after `terminal`), and teardown runs exactly once from any path:
    // terminal frame, client disconnect, or socket error.
    let closed = false;
    let heartbeat = null;
    let unsubscribe = () => {};

    const teardown = () => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      unsubscribe();
    };

    const send = (evt) => {
      if (closed) return;
      try {
        res.write(`event: ${evt.kind}\ndata: ${JSON.stringify(evt)}\n\n`);
      } catch {
        teardown();
        return;
      }
      if (evt.kind === 'terminal') {
        teardown();
        res.end();
      }
    };

    const execution = engine.executions.get(view.execution_id);
    if (execution) {
      unsubscribe = execution.subscribe(send);
      // subscribe() replays synchronously — if the execution was already
      // terminal, send() already tore us down; drop the fresh subscription.
      if (closed) unsubscribe();
    }

    if (!closed) {
      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          res.write(`: heartbeat\n\n`);
        } catch {
          teardown();
        }
      }, 15_000);
    }

    const onClientGone = () => {
      const wasOpen = !closed;
      teardown();
      if (wasOpen) res.end();
    };
    req.on('close', onClientGone);
    res.on('error', teardown);
  }));

  /**
   * (Re)run verification on a completed execution — e.g. after Meenu's engine
   * comes back online, or to re-verify a new engine build. Idempotent from the
   * client's perspective; each call records its own engine response.
   */
  router.post('/executions/:id/verify', asyncRoute(async (req, res) => {
    const execution = engine.executions.get(req.params.id);
    if (!execution) throw new NotFoundError(`Execution ${req.params.id} not found`);
    if (execution.status !== 'COMPLETED') {
      throw new AppError(
        'EXECUTION_NOT_COMPLETED',
        `Verification requires a COMPLETED execution; current status is ${execution.status}`,
        { httpStatus: 409 },
      );
    }
    await execution.handOffToVerification({ force: true });
    res.json({ execution_id: execution.id, verification: execution.verification });
  }));

  /**
   * Auditable report: separates browser-execution facts from the independent
   * verification verdict, per FlowFix AI's core rule — execution success is
   * NOT requirement verification.
   */
  router.get('/executions/:id/report', asyncRoute((req, res) => {
    const view = engine.get(req.params.id);
    res.json({
      report_version: '1.0',
      generated_at: new Date().toISOString(),
      execution: {
        execution_id: view.execution_id,
        scenario_id: view.scenario_id,
        requirement: view.requirement,
        url: view.url,
        goal: view.goal,
        status: view.status,
        created_at: view.created_at,
        finished_at: view.finished_at,
        error: view.error,
      },
      observations: view.record?.observations ?? null,
      evidence: view.record?.evidence
        ? view.record.evidence.map(({ events: _events, ...meta }) => meta) // summarize raw log, don't duplicate payload
        : null,
      verification: view.verification,
      verdict: view.verification?.verdict ?? null,
      verdict_note:
        view.verification?.verdict == null
          ? 'No independent verdict yet. Browser execution alone does not verify the requirement.'
          : 'Verdict produced by the independent verification engine.',
    });
  }));

  /**
   * Evidence Viewer payload: every artifact and observation for one run,
   * grouped by kind, each with its provenance, plus a coverage map showing
   * which evidence backs which verification check.
   */
  router.get('/executions/:id/evidence', (req, res) => {
    const view = engine.get(req.params.id);
    const record = view.record ?? null;
    const evidence = record?.evidence ?? [];

    const byKind = (kind) =>
      evidence
        .filter((item) => item.kind === kind)
        .map(({ events: _events, ...item }) => item);

    const rawLog = evidence.find((item) => item.kind === 'raw_event_log') ?? null;
    const eventsLimit = parseLimit(req.query.events_limit, 100, 5000);
    const wantRaw = req.query.raw !== 'off';

    // Provenance census: every fact traces back to a named source.
    const provenance = {};
    for (const item of [...(record?.observations ?? []), ...evidence]) {
      const source = item.source ?? 'unknown';
      provenance[source] = (provenance[source] ?? 0) + 1;
    }

    const checks = view.checks ?? [];
    const verdictChecks = view.verification?.details?.checks ?? [];
    const coverage = checks.map((check) => {
      const evaluated = verdictChecks.find((c) => c.key === check.key) ?? null;
      return {
        key: check.key,
        source: check.source,
        status: evaluated?.status ?? 'not_evaluated',
        evidence_ref: evaluated?.evidence_ref ?? null,
        independent: evaluated?.independent ?? null,
      };
    });

    res.json({
      execution_id: view.execution_id,
      status: view.status,
      contract_id: view.contract_id,
      scenario_id: view.scenario_id,
      verification: {
        status: view.verification?.status ?? null,
        verdict: view.verification?.verdict ?? null,
        evidence_references: view.verification?.details?.evidence_references ?? [],
        reason_codes: view.verification?.details?.reason_codes ?? [],
      },
      observations: record?.observations ?? [],
      artifacts: {
        screenshots: byKind('step_screenshot'),
        html: byKind('step_html'),
        streams: byKind('live_stream'),
        recordings: byKind('run_recording'),
        api_responses: byKind('api_response'),
        database_results: byKind('database_result'),
      },
      evidence_coverage: coverage,
      evidence_fetch_error: record?.evidence_fetch_error ?? null,
      evidence_note:
        record?.evidence_note ??
        'Artifacts are listed exactly as captured; missing data stays missing rather than being substituted.',
      provenance,
      raw_event_log: wantRaw && rawLog
        ? {
            event_count: rawLog.event_count,
            returned: Math.min(rawLog.events?.length ?? 0, eventsLimit),
            truncated: (rawLog.events?.length ?? 0) > eventsLimit,
            events: (rawLog.events ?? []).slice(0, eventsLimit),
            source: rawLog.source,
          }
        : null,
      generated_at: new Date().toISOString(),
    });
  });

  /**
   * Root cause analysis for a finished run — diagnosis only; it never alters
   * the verdict. Result is persisted so history keeps the diagnosis.
   */
  router.get('/executions/:id/root-cause', (req, res) => {
    const view = engine.get(req.params.id);
    if (!['COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'INCOMPLETE'].includes(view.status)) {
      throw new AppError(
        'EXECUTION_NOT_FINISHED',
        `Root cause analysis requires a finished execution; current status is ${view.status}`,
        { httpStatus: 409 },
      );
    }
    const analysis = analyzeRootCause(view);
    try {
      engine.setRootCause(view.execution_id, analysis);
    } catch {
      /* diagnosis must not fail the request if persistence hiccups */
    }
    res.json({ execution_id: view.execution_id, root_cause: analysis });
  });

  return router;
}
