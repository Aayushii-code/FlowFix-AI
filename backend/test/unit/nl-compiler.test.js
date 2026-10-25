/**
 * Natural-language requirement compiler.
 *
 * The important assertions here are the *refusals*: when a sentence carries
 * no observable condition, the compiler must say so instead of inventing one,
 * and it must never fabricate a URL.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  compileRequirement,
  extractUrl,
  extractMoneyThreshold,
  extractQuoted,
  extractQuantity,
} from '../../src/contracts/compiler.js';

describe('compileRequirement — the documented example', () => {
  const sentence =
    'Check whether iPhone 17 Pro is available for less than ₹1,20,000 and can be added to the cart.';
  const result = compileRequirement(sentence);

  test('produces a structured draft with all contract fields', () => {
    const { draft } = result;
    assert.equal(draft.requirement, sentence);
    assert.equal(draft.source, 'nl_compiler');
    assert.ok(draft.name.length > 0 && draft.name.length <= 81);
    assert.ok(Array.isArray(draft.preconditions) && draft.preconditions.length > 0);
    assert.ok(draft.steps.length >= 2, 'workflow steps derived from the intents');
    assert.ok(draft.expected_results.length > 0);
    assert.ok(draft.evidence_requirements.length > 0);
    assert.ok(['low', 'medium', 'high', 'critical'].includes(draft.risk_level));
    assert.equal(draft.risk_level, 'high', 'money threshold ⇒ high risk');
    assert.ok(draft.goal, 'a runnable goal is generated');
    assert.match(draft.goal, /Do not complete any real payment/i);
  });

  test('derives one check per observable condition', () => {
    const keys = result.draft.checks.map((c) => c.key);
    assert.deepEqual(keys.sort(), ['added_to_cart', 'available', 'price_threshold']);

    const price = result.draft.checks.find((c) => c.key === 'price_threshold');
    assert.equal(price.operator, 'lt');
    assert.equal(price.expected, 120000);
    assert.equal(price.transform, 'number');
    assert.equal(price.source, 'page');
    assert.ok(price.pattern.includes('₹'));

    const available = result.draft.checks.find((c) => c.key === 'available');
    assert.equal(available.operator, 'regex');
    assert.equal(available.source, 'page');
  });

  test('does not invent a URL — it flags the gap instead', () => {
    assert.equal(result.draft.url, null);
    assert.equal(result.confidence, 'medium');
    const ambiguity = result.ambiguities.find((a) => a.field === 'url');
    assert.ok(ambiguity, 'missing URL is reported as an ambiguity');
    assert.match(ambiguity.suggestion, /https?:\/\//);
  });

  test('checks are valid per the shared validator', () => {
    // The draft must round-trip through POST /api/contracts unchanged.
    for (const check of result.draft.checks) {
      assert.ok(check.key && check.operator && check.source);
      assert.ok(check.expected !== undefined);
    }
  });
});

describe('compileRequirement — other requirement shapes', () => {
  test('headline with a literal becomes a contains check', () => {
    const r = compileRequirement('The landing page must display the headline "Example Domain".', {
      url: 'https://example.com',
    });
    assert.equal(r.confidence, 'high');
    assert.equal(r.draft.checks.length, 1);
    assert.equal(r.draft.checks[0].expected, 'Example Domain');
    assert.equal(r.draft.checks[0].source, 'page');
    assert.deepEqual(r.ambiguities, []);
  });

  test('URL in the sentence is extracted (absolute and bare-host forms)', () => {
    assert.equal(extractUrl('Check https://example.com/shop now'), 'https://example.com/shop');
    assert.equal(extractUrl('Verify on example.com that it works'), 'https://example.com');
    assert.equal(extractUrl('Check whether the page is good'), null);
  });

  test('money thresholds parse currency and comparator', () => {
    const inr = extractMoneyThreshold('costs less than ₹1,20,000');
    assert.deepEqual({ amount: inr.amount, currency: inr.currency, operator: inr.operator }, {
      amount: 120000,
      currency: 'INR',
      operator: 'lt',
    });

    const usd = extractMoneyThreshold('priced under $500 or less');
    assert.equal(usd.amount, 500);
    assert.equal(usd.currency, 'USD');
    assert.equal(usd.operator, 'lte');

    assert.equal(extractMoneyThreshold('the page loads quickly'), null);
  });

  test('quantity conditions are recognised with their operator', () => {
    assert.deepEqual(extractQuantity('at least 3 results'), { value: 3, operator: 'gte' });
    assert.deepEqual(extractQuantity('no more than 5 items'), { value: 5, operator: 'lte' });
    assert.equal(extractQuantity('lots of results'), null);
  });

  test('quoted literals are extracted for exact-value checks', () => {
    assert.deepEqual(extractQuoted('say "hello world" to the page'), ['hello world']);
  });

  test('unverifiable prose yields zero checks, low confidence and explicit gaps', () => {
    const r = compileRequirement('Make sure the app is nice and good.');
    assert.equal(r.draft.checks.length, 0);
    assert.equal(r.confidence, 'low');
    assert.equal(r.draft.expected_outcome, null);
    const fields = r.ambiguities.map((a) => a.field);
    assert.ok(fields.includes('checks'), 'reports that nothing is verifiable');
    assert.ok(fields.includes('url'));
    assert.ok(r.ambiguities.every((a) => a.message && a.suggestion), 'every ambiguity explains how to fix it');
  });

  test('tentative language is flagged rather than silently accepted', () => {
    const r = compileRequirement('This page might show a discount maybe.');
    const fields = r.ambiguities.map((a) => a.field);
    assert.ok(fields.includes('requirement'));
  });

  test('quantity without a countable noun is flagged, not guessed', () => {
    const r = compileRequirement('There are at least 3 of them.');
    const fields = r.ambiguities.map((a) => a.field);
    assert.ok(fields.includes('checks.quantity'));
    assert.equal(r.draft.checks.length, 0);
  });

  test('headline mentioned but not quoted → ambiguity, not a fabricated value', () => {
    const r = compileRequirement('Check that the headline is correct.', { url: 'https://example.com' });
    assert.equal(r.draft.checks.length, 0);
    assert.ok(r.ambiguities.some((a) => a.field === 'checks.headline'));
  });

  test('empty input throws instead of producing an empty contract', () => {
    assert.throws(() => compileRequirement(''), /non-empty/);
    assert.throws(() => compileRequirement(null), /non-empty/);
  });

  test('risk level reflects business impact', () => {
    assert.equal(compileRequirement('The checkout total must be below ₹1,000.').draft.risk_level, 'high');
    assert.equal(compileRequirement('The page shows the word "welcome".').draft.risk_level, 'low');
    assert.equal(
      compileRequirement('The product must be in stock.').draft.risk_level,
      'medium',
    );
  });
});
