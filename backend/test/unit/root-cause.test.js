/**
 * Root cause analysis — classification, evidence-backed causes, and the
 * risk split on recommended actions (safe vs requires human approval).
 *
 * The analyzer is diagnosis only: it must never mutate the execution or
 * produce/alter a verdict.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRootCause, ROOT_CAUSE_CLASSES } from '../../src/analysis/root-cause.js';

function view(overrides = {}) {
  return {
    execution_id: 'exec-1',
    status: 'COMPLETED',
    timeout_ms: 300000,
    error: null,
    record: { execution_status: 'COMPLETED', observations: [], evidence: [] },
    verification: { status: 'COMPLETED', verdict: 'PASS', details: { checks: [], failed_checks: [], reason_codes: ['ALL_CHECKS_PASSED'] } },
    ...overrides,
  };
}

function agentFailureRecord() {
  return {
    execution_status: 'COMPLETED',
    observations: [{ kind: 'agent_result', result: { format: 'object', value: { status: 'failure', reason: 'not found' } }, source: 'tinyfish_sse:COMPLETE.result' }],
    evidence: [],
  };
}

describe('classification', () => {
  test('verified success', () => {
    const out = analyzeRootCause(view());
    assert.equal(out.classification, 'SUCCESS');
    assert.equal(out.severity, 'info');
    assert.ok(out.likely_causes.every((c) => c.cause && c.confidence && c.evidence !== undefined));
  });

  test('silent failure: agent said COMPLETED, evidence says FAIL', () => {
    const out = analyzeRootCause(
      view({
        verification: {
          status: 'COMPLETED',
          verdict: 'FAIL',
          details: { failed_checks: ['price_threshold'], reason_codes: ['CHECK_VIOLATED', 'SILENT_FAILURE'], checks: [] },
        },
      }),
    );
    assert.equal(out.classification, 'SILENT_FAILURE');
    assert.equal(out.severity, 'critical');
    assert.ok(out.reason_codes.includes('SILENT_FAILURE'));
    assert.match(out.likely_causes[0].cause, /reported success/i);
    // Remediation touching production must be gated behind approval.
    const productionAction = out.recommended_actions.find((a) => /production data/i.test(a.action));
    assert.ok(productionAction, 'production-touching action is recommended');
    assert.equal(productionAction.risk, 'requires_approval');
    assert.ok(out.recommended_actions.some((a) => a.risk === 'safe'), 'safe actions are offered too');
  });

  test('evidence gap for INCONCLUSIVE', () => {
    const out = analyzeRootCause(
      view({
        verification: {
          status: 'COMPLETED',
          verdict: 'INCONCLUSIVE',
          details: { failed_checks: [], inconclusive_checks: ['headline'], reason_codes: ['EVIDENCE_UNREACHABLE'], checks: [] },
        },
      }),
    );
    assert.equal(out.classification, 'EVIDENCE_GAP');
    assert.ok(out.reason_codes.includes('EVIDENCE_UNREACHABLE'));
    assert.ok(out.recommended_actions.some((a) => /re-run/i.test(a.action)));
  });

  test('agent goal failure is distinguished from an evidence gap', () => {
    const out = analyzeRootCause(
      view({
        record: agentFailureRecord(),
        verification: { status: 'UNAVAILABLE', verdict: null, details: { reason_codes: ['NO_CHECKS_DEFINED'] } },
      }),
    );
    assert.equal(out.classification, 'AGENT_GOAL_FAILURE');
    assert.ok(out.reason_codes.includes('AGENT_REPORTED_FAILURE'));
    assert.match(out.likely_causes[0].evidence, /failure/);
  });

  test('timeout, cancel and upstream errors are classified from the typed error', () => {
    const timedOut = analyzeRootCause(
      view({ status: 'TIMED_OUT', error: { code: 'EXECUTION_TIMEOUT', message: 'watchdog' }, verification: { status: 'SKIPPED', verdict: null, details: {} } }),
    );
    assert.equal(timedOut.classification, 'TIMEOUT');
    assert.ok(timedOut.recommended_actions.some((a) => /watchdog|timeout_ms/i.test(a.action)));

    const cancelled = analyzeRootCause(view({ status: 'CANCELLED', verification: { status: 'SKIPPED', verdict: null, details: {} } }));
    assert.equal(cancelled.classification, 'CANCELLED');

    const upstream = analyzeRootCause(
      view({ status: 'FAILED', error: { code: 'TINYFISH_INSUFFICIENT_CREDITS', message: 'no credits', retryable: false }, verification: { status: 'SKIPPED', verdict: null, details: {} } }),
    );
    assert.equal(upstream.classification, 'UPSTREAM_ERROR');
    assert.ok(upstream.recommended_actions.some((a) => /balance|allowance/i.test(a.action)));

    const unconfigured = analyzeRootCause(
      view({ status: 'FAILED', error: { code: 'TINYFISH_NOT_CONFIGURED', message: 'no key' }, record: { observations: [], evidence: [] }, verification: { status: 'SKIPPED', verdict: null, details: {} } }),
    );
    assert.equal(unconfigured.classification, 'NOT_CONFIGURED');
    assert.ok(unconfigured.recommended_actions.some((a) => /TINYFISH_API_KEY/.test(a.action)));
  });

  test('every classification in the catalog is documented', () => {
    for (const [key, meta] of Object.entries(ROOT_CAUSE_CLASSES)) {
      assert.ok(meta.label && meta.severity, `${key} has label + severity`);
    }
    // Exercise the fallback path too.
    const unknown = analyzeRootCause({ status: 'WEIRD_STATE' });
    assert.ok(ROOT_CAUSE_CLASSES[unknown.classification], 'unknown outcomes still map to a documented class');
    assert.ok(unknown.likely_causes.length > 0, 'never returns an empty diagnosis');
  });

  test('diagnosis never mutates the input or invents a verdict', () => {
    const input = view();
    const snapshot = JSON.stringify(input);
    const out = analyzeRootCause(input);
    assert.equal(JSON.stringify(input), snapshot, 'input unchanged');
    assert.equal('verdict' in out, false, 'analysis carries no verdict field of its own');
    assert.ok(out.analyzed_at);
    assert.ok(out.summary.length > 0);
  });

  test('summary flags gated actions', () => {
    const out = analyzeRootCause(
      view({ verification: { status: 'COMPLETED', verdict: 'FAIL', details: { failed_checks: ['x'], reason_codes: ['CHECK_VIOLATED', 'SILENT_FAILURE'], checks: [] } } }),
    );
    assert.match(out.summary, /require human approval/);
  });
});
