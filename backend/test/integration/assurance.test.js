/**
 * Assurance endpoints: NL compile → contract draft → persist, e-commerce
 * sandbox verification, and the platform metadata endpoints (audit, reason
 * codes, check types, capabilities).
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApp } from '../../src/app.js';

const apps = [];
after(async () => {
  for (const a of apps) await a.close().catch(() => {});
});

function startApp(env = {}) {
  const handle = createApp({
    DATABASE_PATH: path.join(os.tmpdir(), `flowfix-assurance-${crypto.randomUUID()}.db`),
    ...env,
  });
  return new Promise((resolve) => {
    const server = handle.app.listen(0, '127.0.0.1', () => {
      const h = {
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: async () => {
          await new Promise((r) => {
            server.close(r);
            server.closeAllConnections?.();
          });
          await handle.close();
        },
      };
      apps.push(h);
      resolve(h);
    });
  });
}

async function json(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed = null;
  try {
    parsed = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body: parsed };
}

const SENTENCE =
  'Check whether iPhone 17 Pro is available for less than ₹1,20,000 and can be added to the cart.';

describe('POST /api/contracts/compile — natural language → contract draft', () => {
  test('compiles the documented example into a reviewable draft', async () => {
    const app = await startApp();
    const { status, body } = await json('POST', `${app.baseUrl}/api/contracts/compile`, { requirement: SENTENCE });

    assert.equal(status, 200);
    assert.equal(body.saved, false, 'compile must NOT persist anything');
    assert.equal(body.draft.source, 'nl_compiler');
    assert.equal(body.draft.checks.length, 3);
    assert.equal(body.confidence, 'medium');
    assert.ok(body.ambiguities.some((a) => a.field === 'url'));
    assert.ok(body.next_step.path === '/api/contracts');
    assert.ok(body.extracted.money_threshold.amount === 120000);
  });

  test('the compiled draft round-trips through POST /api/contracts', async () => {
    const app = await startApp();
    const compiled = await json('POST', `${app.baseUrl}/api/contracts/compile`, {
      requirement: SENTENCE,
      url: 'https://shop.example.com/product/iphone-17-pro',
    });
    assert.equal(compiled.body.confidence, 'high');

    const saved = await json('POST', `${app.baseUrl}/api/contracts`, compiled.body.draft);
    assert.equal(saved.status, 201, 'draft must be a valid contract payload');
    assert.equal(saved.body.contract.checks.length, 3);
    assert.equal(saved.body.contract.source, 'nl_compiler');
    assert.equal(saved.body.contract.url, 'https://shop.example.com/product/iphone-17-pro');
  });

  test('rejects a missing requirement with a helpful error', async () => {
    const app = await startApp();
    const { status, body } = await json('POST', `${app.baseUrl}/api/contracts/compile`, {});
    assert.equal(status, 400);
    assert.equal(body.error.code, 'VALIDATION_ERROR');
    assert.ok(body.error.details.example, 'error shows an example requirement');
  });
});

describe('E-commerce transaction assurance (sandbox)', () => {
  test('GET rules catalog is complete and labelled sandbox-only', async () => {
    const app = await startApp();
    const { status, body } = await json('GET', `${app.baseUrl}/api/assurance/ecommerce/rules`);
    assert.equal(status, 200);
    assert.equal(body.sandbox_only, true);
    assert.match(body.note, /never initiates/i);
    for (const type of ['product_available', 'sku_matches', 'price_at_most', 'coupon_applied', 'cart_total_at_most', 'checkout_ready', 'order_status']) {
      assert.ok(body.rules.some((r) => r.type === type), `rule ${type} documented`);
    }
    for (const rule of body.rules) {
      assert.ok(rule.label && rule.description && rule.severity, `${rule.type} fully described`);
    }
  });

  test('a satisfying sandbox transaction verifies to PASS, labelled SANDBOX_DATA', async () => {
    const app = await startApp();
    const { status, body } = await json('POST', `${app.baseUrl}/api/assurance/ecommerce/verify`, {
      requirement: 'iPhone 17 Pro under ₹1,20,000 with coupon and confirmed order',
      transaction: {
        product: { sku: 'IPH17P-256', variant: 'Black', price: 118999, in_stock: true },
        cart: { items: [{ sku: 'IPH17P-256', qty: 1 }], coupon: 'SAVE10', discount: 3000, total: 115999 },
        checkout: { ready: true },
        order: { id: 'ORD-1', status: 'CONFIRMED' },
      },
      expectations: [
        { type: 'product_available' },
        { type: 'sku_matches', sku: 'IPH17P-256' },
        { type: 'price_at_most', amount: 120000 },
        { type: 'coupon_applied', code: 'SAVE10' },
        { type: 'cart_total_at_most', amount: 120000 },
        { type: 'checkout_ready' },
        { type: 'order_created' },
        { type: 'order_status', status: 'CONFIRMED' },
      ],
    });

    assert.equal(status, 200);
    assert.equal(body.verdict, 'PASS');
    assert.equal(body.details.sandbox, true, 'sandbox results must be labelled');
    assert.ok(body.details.reason_codes.includes('SANDBOX_DATA'));
    assert.match(body.details.explanation, /sandbox/i);
    assert.deepEqual(body.details.failed_checks, []);
    assert.equal(body.details.checks.length, 8);
    for (const check of body.details.checks) {
      assert.equal(check.status, 'pass');
      assert.ok(check.evidence_ref?.startsWith('sandbox:'), 'each check cites its snapshot field');
    }
  });

  test('a violating transaction proves FAIL with the offending values', async () => {
    const app = await startApp();
    const { body } = await json('POST', `${app.baseUrl}/api/assurance/ecommerce/verify`, {
      transaction: {
        product: { sku: 'IPH17P-256', price: 149999, in_stock: false },
        cart: { items: [], total: 149999 },
        order: { id: null, status: 'CANCELLED' },
      },
      expectations: [
        { type: 'product_available' },
        { type: 'price_at_most', amount: 120000 },
        { type: 'order_status', status: 'CONFIRMED' },
      ],
    });

    assert.equal(body.verdict, 'FAIL');
    assert.deepEqual(body.details.failed_checks.sort(), ['order_status', 'price_at_most', 'product_available']);
    const priceCheck = body.details.checks.find((c) => c.key === 'price_at_most');
    assert.equal(priceCheck.observed, 149999, 'observed value recorded for the audit trail');
    assert.ok(body.details.reason_codes.includes('CHECK_VIOLATED'));
  });

  test('fields missing from the snapshot → INCONCLUSIVE, never a pass', async () => {
    const app = await startApp();
    const { body } = await json('POST', `${app.baseUrl}/api/assurance/ecommerce/verify`, {
      transaction: { product: { sku: 'X' } },
      expectations: [{ type: 'price_at_most', amount: 100 }, { type: 'order_status', status: 'CONFIRMED' }],
    });

    assert.equal(body.verdict, 'INCONCLUSIVE');
    assert.deepEqual(body.details.failed_checks, []);
    assert.ok(body.details.reason_codes.includes('EVIDENCE_MISSING'));
  });

  test('validation: unknown rule, missing params, missing transaction', async () => {
    const app = await startApp();
    const unknown = await json('POST', `${app.baseUrl}/api/assurance/ecommerce/verify`, {
      transaction: { product: {} },
      expectations: [{ type: 'free_money' }],
    });
    assert.equal(unknown.status, 400);
    assert.match(unknown.body.error.message, /type must be one of/);

    const missingParam = await json('POST', `${app.baseUrl}/api/assurance/ecommerce/verify`, {
      transaction: { product: {} },
      expectations: [{ type: 'price_at_most' }],
    });
    assert.equal(missingParam.status, 400);
    assert.match(missingParam.body.error.message, /requires "amount"/);

    const noTransaction = await json('POST', `${app.baseUrl}/api/assurance/ecommerce/verify`, {
      expectations: [{ type: 'product_available' }],
    });
    assert.equal(noTransaction.status, 400);
    assert.match(noTransaction.body.error.message, /transaction/);
  });
});

describe('Platform metadata endpoints', () => {
  test('GET /api/reason-codes returns the full catalog with severity', async () => {
    const app = await startApp();
    const { status, body } = await json('GET', `${app.baseUrl}/api/reason-codes`);
    assert.equal(status, 200);
    const codes = body.reason_codes;
    for (const code of ['ALL_CHECKS_PASSED', 'CHECK_VIOLATED', 'SILENT_FAILURE', 'EVIDENCE_MISSING', 'EVIDENCE_NOT_INDEPENDENT', 'NO_CHECKS_DEFINED']) {
      assert.ok(codes.some((r) => r.code === code), `${code} documented`);
    }
    const silent = codes.find((r) => r.code === 'SILENT_FAILURE');
    assert.equal(silent.severity, 'critical');
    assert.ok(silent.summary.length > 0);
  });

  test('GET /api/check-types marks independent vs non-independent sources', async () => {
    const app = await startApp();
    const { body } = await json('GET', `${app.baseUrl}/api/check-types`);
    assert.ok(body.operators.includes('contains'));
    const page = body.sources.find((s) => s.source === 'page');
    const agent = body.sources.find((s) => s.source === 'agent_report');
    assert.equal(page.independent, true);
    assert.equal(agent.independent, false);
    assert.match(agent.note, /never/i);
    assert.equal(body.verification_engines.local_enabled, true);
  });

  test('GET /api/capabilities reports only what is actually configured', async () => {
    const app = await startApp();
    const { body } = await json('GET', `${app.baseUrl}/api/capabilities`);
    assert.equal(body.tinyfish.configured, false, 'no key set in this test app');
    assert.equal(body.verification.engine, 'local');
    assert.equal(body.persistence.kind, 'sqlite');
    assert.equal(body.connectors.rest, 'available');
    assert.equal(body.connectors.crm, 'not_configured', 'never claim an unconfigured connector');
  });

  test('GET /api/audit returns the append-only trail with filters', async () => {
    const app = await startApp();
    await json('POST', `${app.baseUrl}/api/contracts`, {
      name: 'Audit probe',
      requirement: 'The page shows "probe".',
      url: 'https://example.com',
      goal: 'Look for probe',
      checks: [{ key: 'probe', operator: 'contains', expected: 'probe' }],
    });

    const all = await json('GET', `${app.baseUrl}/api/audit`);
    assert.equal(all.status, 200);
    assert.ok(all.body.total >= 1);
    assert.ok(all.body.entries.some((e) => e.action === 'contract.created'));

    const filtered = await json('GET', `${app.baseUrl}/api/audit?action=contract.created`);
    assert.ok(filtered.body.entries.every((e) => e.action === 'contract.created'));

    const empty = await json('GET', `${app.baseUrl}/api/audit?action=does.not.exist`);
    assert.equal(empty.body.total, 0);
  });
});
