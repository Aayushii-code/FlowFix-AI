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

export function createRoutes({ engine, config }) {
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
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    res.json({ executions: engine.list({ limit }) });
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

  return router;
}
