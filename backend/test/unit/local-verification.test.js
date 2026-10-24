/**
 * Independent verification engine — the verdict matrix.
 *
 * These tests pin the platform's core rule: PASS requires independent
 * evidence, a violation proven by evidence is FAIL, and everything else
 * (missing, unreachable, self-reported-only) is INCONCLUSIVE. No test here
 * may pass by accident of a default value.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { verifyWithChecks, readPath, LOCAL_ENGINE_ID } from '../../src/verification/local-engine.js';
import { htmlToText } from '../../src/verification/evidence.js';
import { evaluateOperator, toNumber } from '../../src/checks/operators.js';

/** Evidence model with one fetchable page containing `text`. */
function evidenceWithPage(text, { url = 'https://example.com/page' } = {}) {
  return {
    pages: [{ url, kind: 'target_url', ok: true, status: 200, text, source: 'flowfix_independent_fetch' }],
    agent_report: { present: false, value: null, raw: null, source: null, independent: false },
    steps: [],
    artifacts: [],
    page_fetch_ok: true,
    page_fetch_attempted: true,
  };
}

/** Evidence model where the page could not be fetched at all. */
function evidenceUnreachable(url = 'https://example.com/page') {
  return {
    pages: [{ url, kind: 'target_url', ok: false, status: null, text: '', error: 'ECONNREFUSED', source: 'flowfix_independent_fetch' }],
    agent_report: { present: false, value: null, raw: null, source: null, independent: false },
    steps: [],
    artifacts: [],
    page_fetch_ok: false,
    page_fetch_attempted: true,
  };
}

/** Evidence model with no page at all, only the agent's own claim. */
function evidenceAgentOnly(value) {
  return {
    pages: [],
    agent_report: { present: true, value, raw: { value }, source: 'tinyfish_sse:COMPLETE.result', independent: false },
    steps: [],
    artifacts: [],
    page_fetch_ok: false,
    page_fetch_attempted: false,
  };
}

const completedRecord = { execution_status: 'COMPLETED', observations: [], evidence: [] };

describe('verifyWithChecks — PASS', () => {
  test('all required checks proven by fetched page → PASS with evidence refs', () => {
    const checks = [
      { key: 'headline', source: 'page', operator: 'contains', expected: 'Example Domain', severity: 'high' },
      { key: 'keyword', source: 'page', operator: 'contains', expected: 'illustrative' },
    ];
    const evidence = evidenceWithPage('Example Domain — this domain is for use in illustrative examples.');

    const out = verifyWithChecks({
      executionId: 'exec-1',
      requirementId: 'content-freshness',
      requirement: 'Headline and keyword are present',
      checks,
      record: completedRecord,
      evidence,
    });

    assert.equal(out.status, 'COMPLETED');
    assert.equal(out.verdict, 'PASS');
    assert.equal(out.details.engine, LOCAL_ENGINE_ID);
    assert.equal(out.details.independent_verification, true);
    assert.equal(out.details.execution_id, 'exec-1');
    assert.equal(out.details.requirement_id, 'content-freshness');
    assert.deepEqual(out.details.failed_checks, []);
    assert.deepEqual(out.details.inconclusive_checks, []);
    assert.ok(out.details.reason_codes.includes('ALL_CHECKS_PASSED'));
    assert.ok(out.details.evidence_references.some((r) => r.startsWith('page:')));
    assert.ok(out.details.timestamp);
    assert.equal(out.details.severity, 'info');
    for (const check of out.details.checks) {
      assert.equal(check.status, 'pass');
      assert.equal(check.independent, true);
    }
  });

  test('optional check failing does not flip PASS, but is reported', () => {
    const checks = [
      { key: 'required_one', source: 'page', operator: 'contains', expected: 'Example Domain' },
      { key: 'optional_one', source: 'page', operator: 'contains', expected: 'absent text', required: false },
    ];
    const out = verifyWithChecks({
      executionId: 'exec-2',
      checks,
      record: completedRecord,
      evidence: evidenceWithPage('Example Domain'),
    });
    assert.equal(out.verdict, 'PASS');
    assert.deepEqual(out.details.failed_checks, []);
    assert.deepEqual(out.details.failed_optional_checks, ['optional_one']);
    assert.ok(out.details.reason_codes.includes('EVIDENCE_INCOMPLETE'));
  });
});

describe('verifyWithChecks — FAIL (evidence proves violation)', () => {
  test('required check violated by fetched page → FAIL with reason + explanation', () => {
    const checks = [{ key: 'headline', source: 'page', operator: 'contains', expected: 'Example Domain' }];
    const out = verifyWithChecks({
      executionId: 'exec-3',
      checks,
      record: completedRecord,
      evidence: evidenceWithPage('Totally different page content'),
    });

    assert.equal(out.verdict, 'FAIL');
    assert.deepEqual(out.details.failed_checks, ['headline']);
    assert.ok(out.details.reason_codes.includes('CHECK_VIOLATED'));
    assert.match(out.details.explanation, /violated/i);
    assert.ok(out.details.expected_result.some((e) => e.expected === 'Example Domain'));
    assert.ok(out.details.observed_result.some((o) => o.status === 'fail'));
  });

  test('agent reported success but evidence contradicts it → SILENT_FAILURE', () => {
    const checks = [{ key: 'stock', source: 'page', operator: 'contains', expected: 'In stock' }];
    const out = verifyWithChecks({
      executionId: 'exec-4',
      checks,
      record: completedRecord,
      evidence: {
        ...evidenceWithPage('Out of stock — no items available'),
        agent_report: { present: true, value: { availability: 'In stock' }, raw: {}, source: 'tinyfish_sse:COMPLETE.result', independent: false },
      },
    });

    assert.equal(out.verdict, 'FAIL');
    assert.ok(out.details.reason_codes.includes('SILENT_FAILURE'));
    assert.ok(out.details.reason_codes.includes('CHECK_VIOLATED'));
    assert.equal(out.details.severity, 'critical');
  });
});

describe('verifyWithChecks — INCONCLUSIVE (never a fabricated verdict)', () => {
  test('page unreachable → INCONCLUSIVE, never PASS', () => {
    const checks = [{ key: 'headline', source: 'page', operator: 'contains', expected: 'Example Domain' }];
    const out = verifyWithChecks({
      executionId: 'exec-5',
      checks,
      record: completedRecord,
      evidence: evidenceUnreachable(),
    });

    assert.equal(out.verdict, 'INCONCLUSIVE');
    assert.deepEqual(out.details.failed_checks, []);
    assert.deepEqual(out.details.inconclusive_checks, ['headline']);
    assert.ok(out.details.reason_codes.includes('EVIDENCE_UNREACHABLE'));
    assert.match(out.details.explanation, /could not be proven/i);
  });

  test('no evidence at all → INCONCLUSIVE with EVIDENCE_MISSING', () => {
    const checks = [{ key: 'headline', source: 'page', operator: 'contains', expected: 'Example Domain' }];
    const out = verifyWithChecks({
      executionId: 'exec-6',
      checks,
      record: { execution_status: 'COMPLETED', observations: [], evidence: [] },
      evidence: {
        pages: [],
        agent_report: { present: false, value: null, independent: false },
        steps: [],
        artifacts: [],
        page_fetch_ok: false,
        page_fetch_attempted: false,
      },
    });
    assert.equal(out.verdict, 'INCONCLUSIVE');
    assert.ok(out.details.reason_codes.includes('EVIDENCE_MISSING'));
  });

  test('agent self-report alone can NEVER produce PASS', () => {
    const checks = [{ key: 'headline', source: 'agent_report', path: 'headline', operator: 'equals', expected: 'Example Domain' }];
    const out = verifyWithChecks({
      executionId: 'exec-7',
      checks,
      record: completedRecord,
      evidence: evidenceAgentOnly({ headline: 'Example Domain' }),
    });

    assert.equal(out.verdict, 'INCONCLUSIVE');
    assert.equal(out.verdict !== 'PASS', true, 'self-reported success must not be PASS');
    assert.ok(out.details.reason_codes.includes('EVIDENCE_NOT_INDEPENDENT'));
    assert.equal(out.details.checks[0].independent, false);
    assert.equal(out.details.checks[0].status, 'inconclusive');
  });

  test('agent self-report claiming a violation → INCONCLUSIVE, not FAIL', () => {
    const checks = [{ key: 'price', source: 'agent_report', path: 'price', operator: 'lte', expected: 100 }];
    const out = verifyWithChecks({
      executionId: 'exec-8',
      checks,
      record: completedRecord,
      evidence: evidenceAgentOnly({ price: 250 }),
    });

    assert.equal(out.verdict, 'INCONCLUSIVE');
    assert.ok(out.details.reason_codes.includes('UNVERIFIED_VIOLATION'));
    assert.deepEqual(out.details.failed_checks, []);
  });

  test('no checks → UNAVAILABLE with null verdict and NO_CHECKS_DEFINED', () => {
    const out = verifyWithChecks({
      executionId: 'exec-9',
      checks: [],
      record: completedRecord,
      evidence: evidenceWithPage('anything'),
    });
    assert.equal(out.status, 'UNAVAILABLE');
    assert.equal(out.verdict, null);
    assert.equal(out.details.reason_code, 'NO_CHECKS_DEFINED');
  });

  test('evidence covering only part of the required conditions → INCONCLUSIVE', () => {
    const checks = [
      { key: 'present', source: 'page', operator: 'contains', expected: 'Example Domain' },
      // Second condition needs a database leg that was never supplied, so it
      // cannot be proven either way.
      { key: 'order_recorded', source: 'database', path: 'order_id', operator: 'exists', expected: true },
    ];
    const out = verifyWithChecks({
      executionId: 'exec-10',
      checks,
      record: completedRecord,
      evidence: evidenceWithPage('Example Domain'),
    });
    assert.equal(out.verdict, 'INCONCLUSIVE');
    assert.deepEqual(out.details.failed_checks, []);
    assert.deepEqual(out.details.inconclusive_checks, ['order_recorded']);
    assert.equal(out.details.checks[0].status, 'pass', 'proven condition stays proven');
    assert.ok(out.details.reason_codes.includes('EVIDENCE_MISSING'));
  });

  test('one proven violation among mixed evidence → FAIL, each check reported separately', () => {
    const checks = [
      { key: 'present', source: 'page', operator: 'contains', expected: 'Example Domain' },
      { key: 'missing_evidence', source: 'page', operator: 'contains', expected: 'never observed' },
    ];
    const out = verifyWithChecks({
      executionId: 'exec-12',
      checks,
      record: completedRecord,
      evidence: evidenceWithPage('Example Domain'),
    });
    assert.equal(out.verdict, 'FAIL');
    assert.deepEqual(out.details.failed_checks, ['missing_evidence']);
    assert.equal(out.details.checks[0].status, 'pass');
  });
});

describe('check resolution helpers', () => {
  test('readPath navigates objects and arrays', () => {
    assert.equal(readPath({ a: { b: [{ c: 42 }] } }, 'a.b[0].c'), 42);
    assert.equal(readPath({ a: 'x' }, 'a'), 'x');
    assert.equal(readPath({}, 'a.b.c'), undefined);
    assert.equal(readPath(null, 'a'), undefined);
  });

  test('pattern extraction feeds structured operators', () => {
    const checks = [
      { key: 'price', source: 'page', operator: 'lte', pattern: 'Price:\\s*£([\\d,]+)', transform: 'number', expected: 50 },
    ];
    const out = verifyWithChecks({
      executionId: 'exec-11',
      checks,
      record: completedRecord,
      evidence: evidenceWithPage('Wooden Table Price: £49.00 only'),
    });
    assert.equal(out.verdict, 'PASS');
    assert.equal(out.details.checks[0].observed, 49);
  });
});

describe('operators are three-state', () => {
  test('missing observation returns ok:null, never true', () => {
    assert.equal(evaluateOperator({ operator: 'contains', expected: 'x' }, undefined).ok, null);
    assert.equal(evaluateOperator({ operator: 'contains', expected: 'x' }, null).ok, null);
    assert.equal(evaluateOperator({ operator: 'lte', expected: 10 }, 'not a number').ok, null);
    assert.equal(evaluateOperator({ operator: 'exists', expected: true }, undefined).ok, false);
  });

  test('currency strings parse for numeric comparison', () => {
    assert.equal(toNumber('₹1,20,000'), 120000);
    assert.equal(toNumber('$1,299.00'), 1299.0);
    assert.equal(toNumber('abc'), null);
    assert.equal(evaluateOperator({ operator: 'lte', expected: 120000 }, '₹1,19,999').ok, true);
  });
});

describe('htmlToText', () => {
  test('strips scripts/styles/tags and decodes entities', () => {
    const html = '<html><head><style>h1{color:red}</style><script>alert(1)</script></head>' +
      '<body><h1>Example &amp; Domain</h1><p>&pound;49</p></body></html>';
    const text = htmlToText(html);
    assert.ok(!text.includes('alert(1)'), 'script contents must not leak into evidence');
    assert.ok(!text.includes('color:red'), 'style contents must not leak into evidence');
    assert.ok(text.includes('Example & Domain'));
    assert.ok(text.includes('£49'), `expected decoded currency, got: ${text}`);
  });
});
