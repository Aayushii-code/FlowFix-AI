/**
 * Execution engine — owns the lifecycle of one browser journey execution.
 *
 * Lifecycle: QUEUED → RUNNING → COMPLETED | FAILED | TIMED_OUT | CANCELLED
 *
 * Responsibilities:
 *  - concurrency limiting (respects TinyFish's pending-run cap)
 *  - hard watchdog timeout: on expiry we cancel the upstream run and mark
 *    the execution TIMED_OUT — we never leave a zombie run behind
 *  - explicit cancellation (client disconnect or POST /cancel)
 *  - fetching the run object after completion for screenshot/step evidence
 *  - normalization via execution/normalize.js
 *  - emitting lifecycle events to attached SSE listeners (Aman's frontend)
 *
 * It never computes verdicts. On COMPLETED it hands the normalized record to
 * the verification adapter, which asks Meenu's engine independently.
 */
import crypto from 'node:crypto';
import { AppError, ConcurrencyLimitError, ExecutionTimeoutError, NotFoundError } from '../errors.js';
import { normalizeExecution } from './normalize.js';

const TERMINAL_STATUSES = new Set(['COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'INCOMPLETE']);

export class ExecutionEngine {
  /**
   * @param {{
   *   tinyfish: import('../tinyfish/client.js').TinyFishClient,
   *   verifier: import('../verification/adapter.js').VerificationAdapter,
   *   timeoutMs?: number,
   *   maxConcurrent?: number,
   *   fetchRunObject?: boolean,
   * }} deps
   */
  constructor({ tinyfish, verifier, timeoutMs = 300_000, maxConcurrent = 3, maxRetained = 500, fetchRunObject = true }) {
    this.tinyfish = tinyfish;
    this.verifier = verifier;
    this.timeoutMs = timeoutMs;
    this.maxConcurrent = maxConcurrent;
    this.maxRetained = maxRetained;
    this.fetchRunObject = fetchRunObject;
    /** @type {Map<string, object>} */
    this.executions = new Map();
    this.runningCount = 0;
  }

  /**
   * Bound the in-memory history: keep the newest `maxRetained` executions.
   * Only terminal executions are evicted — a running execution must keep its
   * record so its later events/record/verification stay observable.
   * Evicted ids behave exactly like unknown ids (404 NOT_FOUND).
   */
  evictIfNeeded() {
    if (this.executions.size <= this.maxRetained) return;
    for (const [id, execution] of this.executions) {
      if (this.executions.size <= this.maxRetained) break;
      if (execution.isTerminal) this.executions.delete(id);
    }
  }

  /** Public snapshot of an execution (defensive copy of shareable fields). */
  get(executionId) {
    const exec = this.executions.get(executionId);
    if (!exec) throw new NotFoundError(`Execution ${executionId} not found`);
    return exec.publicView();
  }

  list({ limit = 50 } = {}) {
    return [...this.executions.values()]
      .slice(-limit)
      .reverse()
      .map((e) => e.publicView());
  }

  /**
   * Create + start an execution. Returns the QUEUED record immediately; the
   * journey runs in the background and emits events to SSE subscribers.
   *
   * @param {{
   *   scenarioId: string|null,
   *   requirement: string,        // the natural-language requirement under test
   *   url: string,
   *   goal: string,
   *   expectedOutcome?: object,   // opaque expectation passed to verification
   *   browserProfile?: 'lite'|'stealth',
   *   agentConfig?: object,
   *   captureConfig?: object,
   *   outputSchema?: object,
   *   executionTimeoutMs?: number,
   * }} spec
   */
  createExecution(spec) {
    if (this.runningCount >= this.maxConcurrent) {
      throw new ConcurrencyLimitError(this.maxConcurrent);
    }

    const execution = new Execution(spec, this);
    this.executions.set(execution.id, execution);
    this.evictIfNeeded();
    this.runningCount += 1;

    // Fire and forget; errors are captured on the record itself.
    execution
      .run()
      .catch((err) => execution.markCrashed(err))
      .finally(() => {
        this.runningCount -= 1;
      });

    return execution.publicView();
  }

  /** Cancel a running execution; idempotent like TinyFish's own cancel. */
  cancel(executionId) {
    const execution = this.executions.get(executionId);
    if (!execution) throw new NotFoundError(`Execution ${executionId} not found`);
    return execution.requestCancel();
  }
}

/** One execution instance. Not exported directly; created via the engine. */
class Execution {
  constructor(spec, engine) {
    this.engine = engine;
    this.id = crypto.randomUUID();
    this.spec = spec;
    this.status = 'QUEUED';
    this.events = []; // raw TinyFish SSE events, in order — audit trail
    this.record = null; // normalized record once execution finishes
    this.verification = { status: 'PENDING', verdict: null, details: null };
    this.error = null;
    this.cancelRequested = false;
    this.abortController = new AbortController();
    this.timeoutHandle = null;
    this.createdAt = new Date().toISOString();
    this.finishedAt = null;
    /** @type {Set<(evt: object) => void>} */
    this.listeners = new Set();
  }

  get isTerminal() {
    return TERMINAL_STATUSES.has(this.status);
  }

  /** Subscribe to lifecycle events; returns unsubscribe fn. */
  subscribe(listener) {
    this.listeners.add(listener);
    // Replay history so late subscribers see the full picture.
    for (const evt of this.events) listener({ kind: 'upstream_event', event: evt });
    if (this.record) listener({ kind: 'record', record: this.record });
    if (this.verification.status !== 'PENDING') listener({ kind: 'verification', verification: this.verification });
    if (this.isTerminal) listener({ kind: 'terminal', status: this.status });
    return () => this.listeners.delete(listener);
  }

  emit(payload) {
    for (const listener of this.listeners) {
      try {
        listener(payload);
      } catch {
        /* a broken subscriber must not break the run */
      }
    }
  }

  setStatus(status) {
    if (this.isTerminal) return;
    this.status = status;
    this.emit({ kind: 'status', status, at: new Date().toISOString() });
    if (TERMINAL_STATUSES.has(status)) {
      this.finishedAt = new Date().toISOString();
      this.emit({ kind: 'terminal', status });
    }
  }

  publicView() {
    return {
      execution_id: this.id,
      scenario_id: this.spec.scenarioId ?? null,
      requirement: this.spec.requirement ?? null,
      url: this.spec.url,
      goal: this.spec.goal,
      expected_outcome: this.spec.expectedOutcome ?? null,
      status: this.status,
      created_at: this.createdAt,
      finished_at: this.finishedAt,
      timeout_ms: this.spec.executionTimeoutMs ?? this.engine.timeoutMs,
      error: this.error,
      record: this.record,
      verification: this.verification,
    };
  }

  requestCancel() {
    if (this.isTerminal) {
      return { status: this.status, already_finished: true };
    }
    this.cancelRequested = true;
    clearTimeout(this.timeoutHandle); // run is over; don't leave the watchdog armed
    this.abortController.abort(); // stops the SSE fetch
    // Record + verification BEFORE terminal status so any observer of the
    // terminal state always sees a settled record (no races).
    this.finalizeRecord({ cancelled: true });
    this.setStatus('CANCELLED');
    // Best-effort upstream cancel if we already know the run id.
    const runId = this.events.find((e) => e?.run_id)?.run_id;
    if (runId) {
      this.engine.tinyfish.cancelRun(runId).catch(() => {
        /* upstream cancel is best-effort; run has its own TTL */
      });
    }
    return { status: this.status, already_finished: false };
  }

  markCrashed(err) {
    if (this.isTerminal) return;
    this.error = { code: err?.code ?? 'INTERNAL_ERROR', message: err?.message ?? String(err), retryable: err?.retryable ?? false };
    this.finalizeRecord({});
    this.setStatus('FAILED');
  }

  async run() {
    this.setStatus('RUNNING');
    const timeoutMs = this.spec.executionTimeoutMs ?? this.engine.timeoutMs;

    this.timeoutHandle = setTimeout(() => {
      if (this.isTerminal) return;
      this.error = new ExecutionTimeoutError(timeoutMs).toJSON().error;
      this.abortController.abort(); // stop consuming the stream
      // Settle record + verification (SKIPPED) before the terminal status.
      this.finalizeRecord({ timedOut: true });
      this.setStatus('TIMED_OUT');
      const runId = this.events.find((e) => e?.run_id)?.run_id;
      if (runId) {
        this.engine.tinyfish.cancelRun(runId).catch(() => {});
      }
    }, timeoutMs);

    try {
      await this.engine.tinyfish.runSse(
        {
          url: this.spec.url,
          goal: this.spec.goal,
          browserProfile: this.spec.browserProfile,
          agentConfig: this.spec.agentConfig,
          captureConfig: this.spec.captureConfig,
          outputSchema: this.spec.outputSchema,
        },
        {
          signal: this.abortController.signal,
          onEvent: (event) => {
            this.events.push(event);
            this.emit({ kind: 'upstream_event', event });
          },
        },
      );
    } catch (err) {
      clearTimeout(this.timeoutHandle);
      if (this.cancelRequested || this.status === 'CANCELLED' || this.status === 'TIMED_OUT') {
        return; // already finalized by cancel/timeout path
      }
      if (err?.name === 'AbortError') {
        this.finalizeRecord({ cancelled: true });
        this.setStatus('CANCELLED');
        return;
      }
      this.error = {
        code: err?.code ?? 'TINYFISH_STREAM_ERROR',
        message: err?.message ?? String(err),
        retryable: err?.retryable ?? false,
        upstream: err?.upstream ?? null,
      };
      // Settle record + verification (SKIPPED) before the terminal status so
      // every observer of FAILED sees a finalized verification block.
      this.finalizeRecord({});
      this.setStatus('FAILED');
      return;
    } finally {
      clearTimeout(this.timeoutHandle);
    }

    // Stream completed — pull the run object for step/screenshot evidence.
    // Evidence fetching must never turn a good run bad: on failure we keep
    // the SSE-derived record and note the gap honestly.
    let runObject = null;
    let evidenceFetchError = null;
    const runId = this.events.find((e) => e?.run_id)?.run_id;
    if (runId && this.engine.fetchRunObject) {
      try {
        runObject = await this.engine.tinyfish.getRun(runId);
      } catch (err) {
        evidenceFetchError = { code: err?.code ?? 'EVIDENCE_FETCH_FAILED', message: err?.message ?? String(err) };
      }
    }

    const completeEvent = this.events.find((e) => e?.type === 'COMPLETE');
    const failedUpstream = completeEvent?.status === 'FAILED' || runObject?.status === 'FAILED';

    this.record = normalizeExecution({
      events: this.events,
      runObject,
      upstreamError: failedUpstream ? (completeEvent?.error ?? runObject?.error ?? null) : null,
    });
    if (evidenceFetchError) {
      this.record.evidence_fetch_error = evidenceFetchError;
      this.record.evidence_note =
        'Run object (screenshots/steps) could not be fetched; evidence below is limited to the raw SSE stream.';
    }
    this.emit({ kind: 'record', record: this.record });

    if (failedUpstream) {
      this.error = this.record.upstream_error ?? { code: 'TINYFISH_RUN_FAILED', message: 'Run failed upstream', retryable: true };
      // Verification settles BEFORE the terminal status so observers of
      // FAILED always see a settled verification block.
      this.finishVerificationAfterFailure('FAILED');
      this.setStatus('FAILED');
      return;
    }

    // Verification settles BEFORE the execution reports COMPLETED: an
    // observer of a terminal execution must always see a settled verdict
    // block (verdict from the engine, or an honest UNAVAILABLE/ERROR with
    // verdict null) — never a transient PENDING/RUNNING.
    await this.handOffToVerification();
    this.setStatus('COMPLETED');
  }

  finalizeRecord({ timedOut = false, cancelled = false } = {}) {
    if (this.record) return; // already finalized by normal path
    this.record = normalizeExecution({ events: this.events, runObject: null, timedOut, cancelled });
    this.emit({ kind: 'record', record: this.record });
    // Every path that finalizes outside the success flow is a failure path:
    // verification must settle at SKIPPED with verdict null — never left
    // PENDING after the execution is terminal. The terminal status is known
    // at call time (this.status is assigned only after finalize in most
    // paths), so derive it honestly for the details block.
    if (this.verification.status === 'PENDING') {
      const terminalStatus = timedOut ? 'TIMED_OUT' : cancelled ? 'CANCELLED' : 'FAILED';
      this.finishVerificationAfterFailure(terminalStatus);
    }
  }

  finishVerificationAfterFailure(executionStatus = this.status) {
    this.verification = {
      status: 'SKIPPED',
      verdict: null,
      details: {
        reason: 'Execution did not complete successfully; requirement verification was not attempted.',
        execution_status: executionStatus,
      },
    };
    this.emit({ kind: 'verification', verification: this.verification });
  }

  /**
   * Hand the normalized record to the verification adapter. The adapter
   * returns a verdict sourced from Meenu's engine — or null with an honest
   * status when verification is unavailable. We never default to PASS.
   */
  async handOffToVerification({ force = false } = {}) {
    // Automatic hand-off must not clobber a settled verification block left by
    // a cancel/timeout race. An explicit re-verify (POST .../verify) passes
    // force:true and is allowed to replace a previous ERROR/UNAVAILABLE/verdict.
    if (!force && this.verification.status !== 'PENDING' && this.verification.status !== 'RUNNING') {
      return;
    }
    if (!this.engine.verifier.isConfigured()) {
      this.verification = {
        status: 'UNAVAILABLE',
        verdict: null,
        details: {
          reason: 'Verification engine is not configured (VERIFICATION_ENGINE_URL is empty). Browser execution succeeded but the requirement is NOT yet verified.',
        },
      };
      this.emit({ kind: 'verification', verification: this.verification });
      return;
    }

    this.verification = { status: 'RUNNING', verdict: null, details: null };
    this.emit({ kind: 'verification', verification: this.verification });

    try {
      const outcome = await this.engine.verifier.verify({
        executionId: this.id,
        scenarioId: this.spec.scenarioId ?? null,
        requirement: this.spec.requirement,
        url: this.spec.url,
        goal: this.spec.goal,
        expectedOutcome: this.spec.expectedOutcome ?? null,
        record: this.record,
      });
      this.verification = outcome;
    } catch (err) {
      // A verification failure must NEVER be read as PASS or FAIL.
      this.verification = {
        status: 'ERROR',
        verdict: null,
        details: { reason: err?.message ?? String(err), code: err?.code ?? 'VERIFICATION_ERROR' },
      };
    }
    this.emit({ kind: 'verification', verification: this.verification });
  }
}
