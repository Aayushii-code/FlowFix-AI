/**
 * Natural-language requirement compiler.
 *
 * Turns a plain-English business requirement into a structured, reviewable
 * verification contract:
 *
 *   "Check whether iPhone 17 Pro is available for less than ₹1,20,000 and can
 *    be added to the cart."
 *     → url, preconditions, workflow steps, expected results, machine-
 *       verifiable checks, evidence requirements, risk level.
 *
 * Design rules (this component must never lie):
 *  - it is a **deterministic rule parser**, not an AI oracle: it reports a
 *    confidence and lists every ambiguity it could not resolve;
 *  - it only emits a check when the sentence actually implies one that can be
 *    evaluated against observable evidence — otherwise it flags the gap and
 *    leaves the check list empty rather than inventing a condition;
 *  - output is a DRAFT: the caller reviews and edits it before it becomes a
 *    contract (POST /api/contracts) or is executed.
 */
import { normalizeChecks } from '../checks/validate.js';

const CURRENCY_UNIT = {
  '₹': 'INR',
  rs: 'INR',
  inr: 'INR',
  rupees: 'INR',
  $: 'USD',
  usd: 'USD',
  dollars: 'USD',
  '€': 'EUR',
  eur: 'EUR',
  euros: 'EUR',
  '£': 'GBP',
  gbp: 'GBP',
  pounds: 'GBP',
};

const WEAKENERS = /\b(maybe|probably|might|could|possibly|sort of|kind of|somehow|nice to have|hopefully)\b/i;

/** Pull the first absolute URL out of the sentence. */
export function extractUrl(text) {
  const match = text.match(/\bhttps?:\/\/[^\s,;)"']+/i);
  if (match) return match[0].replace(/[.,;]+$/, '');
  // "on example.com" / "at www.example.com/shop"
  const bare = text.match(/\b(?:on|at|to)\s+((?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s,;)]*)?)/i);
  if (bare) {
    const host = bare[1];
    if (!/\.(com|net|org|io|ai|dev|app|co|in|uk|edu|gov)$/i.test(host.split('/')[0])) return null;
    return `https://${host}`;
  }
  return null;
}

/** All quoted fragments — used as literal values (headlines, SKUs, coupons). */
export function extractQuoted(text) {
  return [...text.matchAll(/["“'']([^"”'']{1,80})["”'']/g)].map((m) => m[1].trim()).filter(Boolean);
}

/**
 * Money threshold: "less than ₹1,20,000", "under $500", "₹1,20,000 or less".
 * Returns { amount, currency, operator } or null.
 */
export function extractMoneyThreshold(text) {
  const lower = text.toLowerCase();
  const currencyMatch = text.match(/(₹|rs\.?|inr|\$|usd|€|eur|£|gbp)\s*([\d,]+(?:\.\d+)?)|(?:([\d,]+(?:\.\d+)?)\s*(rupees?|dollars?|euros?|pounds?))/i);
  if (!currencyMatch) return null;

  const rawAmount = currencyMatch[2] ?? currencyMatch[3];
  const unit = currencyMatch[1] ?? currencyMatch[4];
  if (!rawAmount || !unit) return null;
  const amount = Number(rawAmount.replace(/,/g, ''));
  if (!Number.isFinite(amount)) return null;

  const currency = CURRENCY_UNIT[String(unit).toLowerCase()] ?? 'INR';

  const before = /(?:less than|under|below|cheaper than|within|at most|no more than|up to|≤|<=)\s*$/i;
  const after = /^\s*(?:or less|or fewer|or below|or cheaper)/i;
  const sentenceStart = text.slice(0, Math.max(0, currencyMatch.index ?? 0));
  const tail = text.slice((currencyMatch.index ?? 0) + currencyMatch[0].length, (currencyMatch.index ?? 0) + currencyMatch[0].length + 24);

  let operator = null;
  // Explicit inclusive suffix ("…or less") outranks an adjacent word like
  // "under", and multi-word phrases are checked before their fragments so
  // "no more than" never parses as "more than".
  if (after.test(tail)) operator = 'lte';
  else if (before.test(sentenceStart)) {
    operator = /\b(?:less than|under|below|cheaper than|<)\b/i.test(sentenceStart) ? 'lt' : 'lte';
  } else if (/\b(?:less than|under|below|cheaper than)\b/i.test(lower)) {
    operator = 'lt';
  } else if (/\b(?:at most|no more than|within|up to)\b/i.test(lower)) {
    operator = 'lte';
  } else if (/\b(?:more than|above|over|greater than|exceeds?)\b/i.test(lower)) {
    operator = 'gte';
  }
  if (operator === null) return null;

  return { amount, currency, operator };
}

/** Numeric quantity conditions: "at least 3", "no more than 5", "> 10". */
export function extractQuantity(text) {
  const patterns = [
    { re: /\bno more than\s+(\d+)\b/i, operator: 'lte' },
    { re: /\bno fewer than\s+(\d+)\b/i, operator: 'gte' },
    { re: /\bat least\s+(\d+)\b/i, operator: 'gte' },
    { re: /\bminimum of\s+(\d+)\b/i, operator: 'gte' },
    { re: /\bat most\s+(\d+)\b/i, operator: 'lte' },
    { re: /\bmore than\s+(\d+)\b/i, operator: 'gt' },
    { re: /\bless than\s+(\d+)\b/i, operator: 'lt' },
    { re: /\bexactly\s+(\d+)\b/i, operator: 'equals' },
  ];
  for (const { re, operator } of patterns) {
    const m = text.match(re);
    if (m) return { value: Number(m[1]), operator };
  }
  return null;
}

function riskFor(intents, text, { money = null } = {}) {
  // Money, checkout and order integrity are the high-impact failures.
  if (money || intents.checkout || /\border\b|\btotal\b|\bprice\b|\bcost\b/i.test(text)) return 'high';
  if (intents.stock || intents.cart || intents.coupon || intents.search) return 'medium';
  return 'low';
}

function nameFor(text) {
  const firstSentence = text.split(/(?<=[.!?])\s/)[0] ?? text;
  const trimmed = firstSentence.trim();
  if (trimmed.length <= 80) return trimmed.replace(/[.!?]+$/, '');
  return `${trimmed.slice(0, 77).trimEnd()}…`;
}

/**
 * Compile one natural-language requirement into a contract draft.
 *
 * @param {string} text plain-English requirement
 * @param {{ url?: string }} [options] URL when the sentence did not contain one
 * @returns {{ draft: object, extracted: object, ambiguities: object[], confidence: string }}
 */
export function compileRequirement(text, { url: providedUrl = null } = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('compileRequirement requires a non-empty requirement string');
  }
  const requirement = text.trim();
  const lower = requirement.toLowerCase();

  const url = providedUrl ?? extractUrl(requirement);
  const quoted = extractQuoted(requirement);
  const money = extractMoneyThreshold(requirement);
  const quantity = extractQuantity(requirement);

  const intents = {
    search: /\bsearch(?:ing)? for\b|\bfind (?:the )?(?:product|item)s?\b/i.test(requirement),
    stock: /\bin stock\b|\bavailable\b|\bavailability\b|\bstocks?\b/i.test(requirement),
    cart: /\bcart\b|\bbasket\b|\badd (?:it |this )?to (?:the )?(?:cart|basket)\b/i.test(requirement),
    checkout: /\bcheckout\b|\bplace (?:the )?order\b|\bpurchase\b|\bbuy\b/i.test(requirement),
    coupon: /\bcoupon\b|\bpromo(?: code)?\b|\bdiscount(?: code)?\b/i.test(requirement),
    headline: /\bheadline\b|\bh1\b|\bpage title\b/i.test(requirement),
    form: /\bform\b|\bsubmit\b|\bfield\b/i.test(requirement),
    login: /\blog(?:ged| ?in)|\bsign(?:ed)? in\b|\bauthenticate/i.test(requirement),
  };

  const checks = [];
  const steps = [];
  const expectedResults = [];
  const evidenceRequirements = [{ text: 'Page snapshot re-fetched by FlowFix independently of the agent' }];
  const ambiguities = [];
  const extracted = {
    url,
    quoted_values: quoted,
    money_threshold: money,
    quantity,
    intents: Object.entries(intents).filter(([, v]) => v).map(([k]) => k),
  };

  // ── Price / money ────────────────────────────────────────────────────────
  if (money) {
    const symbol = { INR: '₹', USD: '$', EUR: '€', GBP: '£' }[money.currency] ?? '';
    checks.push({
      key: 'price_threshold',
      description: `Price is ${money.operator === 'lt' ? 'below' : 'at most'} ${symbol}${money.amount.toLocaleString('en-IN')} ${money.currency}`,
      source: 'page',
      operator: money.operator,
      pattern: `${symbol}\\s*([\\d,]+(?:\\.\\d+)?)`,
      transform: 'number',
      expected: money.amount,
      severity: 'high',
    });
    steps.push({ text: `Locate the product or offer and read its displayed price` });
    expectedResults.push({ text: `Displayed price ${money.operator === 'lt' ? '<' : '≤'} ${symbol}${money.amount}` });
    evidenceRequirements.push({ text: 'Price visible in the captured page snapshot' });
  }

  // ── Availability / stock ─────────────────────────────────────────────────
  if (intents.stock) {
    checks.push({
      key: 'available',
      description: 'The item is shown as available / in stock',
      source: 'page',
      operator: 'regex',
      expected: 'in\\s*stock|available|add to (?:cart|basket)',
      severity: 'high',
    });
    steps.push({ text: 'Check the product page availability state' });
    expectedResults.push({ text: 'Availability state is affirmative' });
  }

  // ── Add to cart ──────────────────────────────────────────────────────────
  if (intents.cart) {
    checks.push({
      key: 'added_to_cart',
      description: 'The item can be added to the cart',
      source: 'page',
      operator: 'regex',
      expected: 'added to (?:your )?(?:cart|basket)|in (?:your )?(?:cart|basket)|cart \\(\\d+\\)',
      severity: 'high',
    });
    steps.push({ text: 'Add the item to the cart and read the cart state' });
    expectedResults.push({ text: 'Cart reflects the added item' });
    evidenceRequirements.push({ text: 'Cart state screenshot after the add action' });
  }

  // ── Coupon / discount ────────────────────────────────────────────────────
  if (intents.coupon) {
    const code = quoted.find((q) => /^[A-Z0-9_-]{3,20}$/i.test(q));
    checks.push(
      code
        ? {
            key: 'coupon_applied',
            description: `Coupon ${code} is applied`,
            source: 'page',
            operator: 'contains',
            expected: code,
            severity: 'medium',
          }
        : {
            key: 'discount_visible',
            description: 'A discount line is visible on the order summary',
            source: 'page',
            operator: 'regex',
            expected: 'discount|you save|savings|promo applied',
            severity: 'medium',
          },
    );
    steps.push({ text: code ? `Apply coupon ${code}` : 'Apply the promotion code' });
    expectedResults.push({ text: 'Order summary shows a discount line' });
  }

  // ── Headline / literal text ──────────────────────────────────────────────
  if (intents.headline && quoted.length > 0) {
    checks.push({
      key: 'headline',
      description: `Headline equals "${quoted[0]}"`,
      source: 'page',
      operator: 'contains',
      expected: quoted[0],
      severity: 'high',
    });
    steps.push({ text: 'Read the page headline' });
    expectedResults.push({ text: `Headline is "${quoted[0]}"` });
  } else if (intents.headline) {
    ambiguities.push({
      field: 'checks.headline',
      message: 'A headline check was implied but no literal headline was given.',
      suggestion: 'Quote the expected headline, e.g. headline must be "Example Domain".',
    });
  }

  // ── Quantity / result counts ─────────────────────────────────────────────
  if (quantity) {
    const countsResults = /\bresults?\b|\bitems?\b|\bproducts?\b|\bmatches\b/i.test(requirement);
    if (countsResults) {
      checks.push({
        key: 'result_count',
        description: `At least/equals ${quantity.value} matching results`,
        source: 'page',
        operator: quantity.operator === 'equals' ? 'gte' : quantity.operator,
        pattern: '(\\d+)\\s+(?:results?|items?|products?|matches)',
        transform: 'number',
        expected: quantity.value,
        severity: 'medium',
      });
      expectedResults.push({ text: `Result count ${quantity.operator} ${quantity.value}` });
    } else {
      ambiguities.push({
        field: 'checks.quantity',
        message: `A quantity (${quantity.value}) was mentioned but nothing to count was identified.`,
        suggestion: 'Name the counted item, e.g. "at least 3 results".',
      });
    }
  }

  // ── Generic literal presence (quoted text with no other rule) ────────────
  if (quoted.length > 0 && !intents.headline && !intents.coupon) {
    const literal = quoted[0];
    checks.push({
      key: 'text_present',
      description: `Page contains "${literal}"`,
      source: 'page',
      operator: 'contains',
      expected: literal,
      severity: 'medium',
    });
    expectedResults.push({ text: `Page contains "${literal}"` });
  }

  // ── Search intent ────────────────────────────────────────────────────────
  if (intents.search) {
    const term = quoted[0] ?? requirement.match(/search(?:ing)? for\s+([^,.;]+)/i)?.[1]?.trim();
    if (term) steps.push({ text: `Search the site for "${term}"` });
    expectedResults.push({ text: 'Search results page lists matching items' });
  }
  if (intents.checkout) {
    steps.push({ text: 'Proceed to checkout (sandbox only — never submit a real payment)' });
    evidenceRequirements.push({ text: 'Order summary and confirmation screenshot' });
  }
  if (steps.length === 0) steps.push({ text: 'Open the target page and observe the state' });

  // ── Confidence + ambiguity report ────────────────────────────────────────
  if (!url) {
    ambiguities.push({
      field: 'url',
      message: 'No application URL was found in the requirement.',
      suggestion: 'Include the target address, e.g. "on https://example.com".',
    });
  }
  if (checks.length === 0) {
    ambiguities.push({
      field: 'checks',
      message: 'No machine-verifiable condition could be derived from this sentence.',
      suggestion: 'State an observable condition, e.g. "the page shows X" or "price is below ₹Y".',
    });
  }
  if (WEAKENERS.test(requirement)) {
    ambiguities.push({
      field: 'requirement',
      message: 'The requirement uses tentative language ("might", "could", …) which cannot be verified as written.',
      suggestion: 'Rewrite it as a definite condition.',
    });
  }

  const confidence = checks.length === 0 ? 'low' : !url ? 'medium' : 'high';

  const draft = {
    name: nameFor(requirement),
    description: 'Generated by the FlowFix natural-language compiler — review before saving.',
    requirement,
    url,
    goal: buildGoal({ requirement, steps, intents, quoted }),
    risk_level: riskFor(intents, requirement, { money }),
    source: 'nl_compiler',
    preconditions: [
      { text: intents.login ? 'User is authenticated' : 'Visitor is anonymous' },
      { text: 'Target application is reachable and not rate-limiting us' },
    ],
    steps,
    expected_results: expectedResults,
    evidence_requirements: evidenceRequirements,
    checks: normalizeChecks(checks),
    expected_outcome: checks.length
      ? { type: 'checks_passed', condition: expectedResults.map((r) => r.text).join('; ') }
      : null,
  };

  return { draft, extracted, ambiguities, confidence };
}

/** A goal sentence TinyFish can actually execute. */
function buildGoal({ steps, intents, quoted }) {
  const parts = steps.map((s) => s.text);
  const reports = [];
  if (intents.stock) reports.push('availability state');
  if (intents.cart) reports.push('cart contents after adding');
  if (intents.coupon) reports.push('discount line and totals');
  if (quoted.length) reports.push(`whether "${quoted[0]}" is present`);
  reports.push('the exact values you observed');

  return `${parts.join('. ')}. Report ${reports.join(', ')}. Do not complete any real payment.`;
}
