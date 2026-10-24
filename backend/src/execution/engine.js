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
import { collectEvidence } from '../verification/evidence.js';
import { verifyWithChecks } from '../verification/local-engine.js';

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
  constructor({
    tinyfish,
    verifier,
    timeoutMs = 300_000,
    maxConcurrent = 3,
    maxRetained = 500,
    fetchRunObject = true,
    persistence = null,
    audit = null,
    queue = null,
    localVerification = true,
    evidenceFetcher = null,
  }) {
    this.tinyfish = tinyfish;
    this.verifier = verifier;
    this.timeoutMs = timeoutMs;
    this.maxConcurrent = maxConcurrent;
    this.maxRetained = maxRetained;
    this.fetchRunObject = fetchRunObject;
    /** Durable execution history (SQLite repository). Live runs stay in memory. */
    this.persistence = persistence;
    this.audit = audit;
    this.queue = queue;
    /** Use FlowFix's own independent verifier when no external engine is set. */
    this.localVerification = localVerification;
    /** Injectable page fetcher for independent evidence (tests replace it). */
    this.evidenceFetcher = evidenceFetcher;
    /** @type {Map<string, object>} */
    this.executions = new Map();
    this.runningCount = 0;

    if (this.queue) {
      // Serialisable payload ({ execution_id }) so a Redis/BullMQ driver can
      // carry the same job later without changing this contract.
      this.queue.register('execution.run', async ({ execution_id: id }) => {
        const execution = this.executions.get(id);
        if (!execution) throw new NotFoundError(`Execution ${id} not found`);
        try {
          await execution.run();
        } catch (err) {
          execution.markCrashed(err);
        } finally {
          this.runningCount -= 1;
        }
      });
    }
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
    if (exec) return exec.publicView();
    // Evicted or previously-restarted run: history lives in SQLite.
    if (this.persistence) {
      const row = this.persistence.get(executionId);
      if (row) return viewFromRow(row, this.timeoutMs);
    }
    throw new NotFoundError(`Execution ${executionId} not found`);
  }

  list({ limit = 50 } = {}) {
    return this.search({ limit }).executions;
  }

  /**
   * Searchable, paginated run history backed by the database. Live runs are
   * overlaid with their in-memory view so status is never stale.
   */
  search({
    q = null,
    status = null,
    verdict = null,
    contract_id = null,
    scenario_id = null,
    from = null,
    to = null,
    limit = 50,
    offset = 0,
  } = {}) {
    if (!this.persistence) {
      const live = [...this.executions.values()].slice(-limit).reverse().map((e) => e.publicView());
      return { executions: live, total: live.length, limit, offset: 0 };
    }
    const { executions, total } = this.persistence.search({
      q,
      status,
      verdict,
      contract_id,
      scenario_id,
      from,
      to,
      limit,
      offset,
      includeBody: true,
    });
    const rows = executions.map((row) => {
      const live = this.executions.get(row.id);
      return live ? live.publicView() : viewFromRow(row, this.timeoutMs);
    });
    return { executions: rows, total, limit, offset };
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

    try {
      execution.persist();
      this.safeAudit({
        actor: 'system',
        action: 'execution.created',
        entityType: 'execution',
        entityId: execution.id,
        details: {
          contract_id: spec.contractId ?? null,
          scenario_id: spec.scenarioId ?? null,
          url: spec.url,
          checks: (spec.checks ?? []).length,
        },
      });

      // Dispatch through the queue (in-process driver today, Redis/BullMQ
      // later) — same fire-and-forget semantics; errors land on the record.
      if (this.queue) {
        this.queue.enqueue('execution.run', { execution_id: execution.id });
      } else {
        execution
          .run()
          .catch((err) => execution.markCrashed(err))
          .finally(() => {
            this.runningCount -= 1;
          });
      }
    } catch (err) {
      // Never leave a half-created execution holding a concurrency slot.
      this.runningCount -= 1;
      this.executions.delete(execution.id);
      throw err;
    }

    return execution.publicView();
  }

  /**
   * Attach a root-cause diagnosis to an execution — both in memory (so the
   * live view shows it) and in the durable record (so history keeps it).
   */
  setRootCause(executionId, analysis) {
    const execution = this.executions.get(executionId);
    if (execution) {
      execution.rootCause = analysis;
      execution.persist();
    } else if (this.persistence) {
      this.persistence.setRootCause(executionId, analysis);
    }
    return analysis;
  }

  /**
   * Audit writes are observability, not business logic: a failure here is
   * logged and swallowed so it can never fail a request or a run.
   */
  safeAudit(entry) {
    try {
      this.audit?.record(entry);
    } catch (err) {
      console.error(`[flowfix] audit write failed: ${err.message}`);
    }
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
      this.persist();
      this.emit({ kind: 'terminal', status });
      this.engine.safeAudit({
        actor: 'system',
        action: 'execution.terminal',
        entityType: 'execution',
        entityId: this.id,
        details: {
          status,
          verdict: this.verification?.verdict ?? null,
          verification_status: this.verification?.status ?? null,
          error_code: this.error?.code ?? null,
        },
      });
    } else {
      this.persist();
    }
  }

  publicView() {
    return {
      execution_id: this.id,
      scenario_id: this.spec.scenarioId ?? null,
      contract_id: this.spec.contractId ?? null,
      requirement: this.spec.requirement ?? null,
      url: this.spec.url,
      goal: this.spec.goal,
      checks: this.spec.checks ?? [],
      expected_outcome: this.spec.expectedOutcome ?? null,
      status: this.status,
      created_at: this.createdAt,
      finished_at: this.finishedAt,
      timeout_ms: this.spec.executionTimeoutMs ?? this.engine.timeoutMs,
      error: this.error,
      record: this.record,
      verification: this.verification,
      root_cause: this.rootCause ?? null,
    };
  }

  /**
   * Persist the full execution snapshot (status, record, verification, raw
   * event log) to the durable store. Persistence failures must never break a
   * live run — they are surfaced as `lastPersistError` for diagnostics.
   */
  persist() {
    if (!this.engine.persistence) return;
    try {
      this.engine.persistence.save({
        id: this.id,
        contract_id: this.spec.contractId ?? null,
        scenario_id: this.spec.scenarioId ?? null,
        status: this.status,
        url: this.spec.url,
        goal: this.spec.goal,
        requirement: this.spec.requirement ?? null,
        expected_outcome: this.spec.expectedOutcome ?? null,
        checks: this.spec.checks ?? null,
        spec: this.spec,
        error: this.error,
        record: this.record,
        verification: this.verification,
        events: this.events,
        root_cause: this.rootCause ?? null,
        created_at: this.createdAt,
        finished_at: this.finishedAt,
      });
      this.lastPersistError = null;
    } catch (err) {
      this.lastPersistError = err;
      console.error(`[flowfix] failed to persist execution ${this.id}: ${err.message}`);
    }
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
    this.persist();
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
    this.persist();
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
        reason_codes: [
          executionStatus === 'TIMED_OUT'
            ? 'EXECUTION_TIMEOUT'
            : executionStatus === 'CANCELLED'
              ? 'EXECUTION_CANCELLED'
              : 'EXECUTION_FAILED',
        ],
      },
    };
    this.persist();
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
      // No external engine — FlowFix's own independent verifier takes over
      // *only* when the requirement actually carries machine-verifiable
      // checks. Without checks there is nothing to prove: stay UNAVAILABLE
      // with a null verdict rather than inventing one.
      const checks = this.spec.checks ?? [];
      if (this.engine.localVerification && checks.length > 0) {
        this.verification = { status: 'RUNNING', verdict: null, details: null };
        this.emit({ kind: 'verification', verification: this.verification });
        try {
          const evidence = await collectEvidence({
            record: this.record,
            targetUrl: this.spec.url,
            fetcher: this.engine.evidenceFetcher ?? undefined,
          });
          this.verification = verifyWithChecks({
            executionId: this.id,
            requirementId: this.spec.contractId ?? this.spec.scenarioId ?? null,
            requirement: this.spec.requirement,
            checks,
            record: this.record,
            evidence,
            externalResults: this.spec.externalResults ?? null,
          });
        } catch (err) {
          this.verification = {
            status: 'ERROR',
            verdict: null,
            details: {
              reason: err?.message ?? String(err),
              code: err?.code ?? 'VERIFICATION_ERROR',
              reason_codes: ['VERIFICATION_ENGINE_ERROR'],
            },
          };
        }
        this.persist();
        this.emit({ kind: 'verification', verification: this.verification });
        return;
      }
      this.verification = {
        status: 'UNAVAILABLE',
        verdict: null,
        details: {
          reason: 'Verification engine is not configured (VERIFICATION_ENGINE_URL is empty). Browser execution succeeded but the requirement is NOT yet verified.',
          reason_codes: ['VERIFICATION_UNAVAILABLE', 'NO_CHECKS_DEFINED'],
        },
      };
      this.persist();
      this.emit({ kind: 'verification', verification: this.verification });
      return;
    }

    this.verification = { status: 'RUNNING', verdict: null, details: null };
    this.emit({ kind: 'verification', verification: this.verification });
    this.persist();

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
        details: {
          reason: err?.message ?? String(err),
          code: err?.code ?? 'VERIFICATION_ERROR',
          reason_codes: ['VERIFICATION_ENGINE_ERROR'],
        },
      };
    }
    this.persist();
    this.emit({ kind: 'verification', verification: this.verification });
  }
}

/**
 * Rebuild a public execution view from a persisted row (run history).
 * Used when an execution has been evicted from memory or the process that
 * created it is no longer running.
 */
export function viewFromRow(row, engineTimeoutMs = 300_000) {
  const spec = row.spec ?? {};
  return {
    execution_id: row.id,
    scenario_id: row.scenario_id ?? null,
    contract_id: row.contract_id ?? null,
    requirement: row.requirement ?? null,
    url: row.url,
    goal: row.goal,
    checks: row.checks ?? [],
    expected_outcome: row.expected_outcome ?? null,
    status: row.status,
    created_at: row.created_at,
    finished_at: row.finished_at ?? null,
    timeout_ms: spec.executionTimeoutMs ?? engineTimeoutMs,
    error: row.error ?? null,
    record: row.record ?? null,
    verification: row.verification ?? { status: 'PENDING', verdict: null, details: null },
    root_cause: row.root_cause ?? null,
    from_history: true,
  };
}
