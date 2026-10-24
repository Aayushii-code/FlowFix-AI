/**
 * E-commerce transaction assurance.
 *
 * A rule catalog (availability, SKU/variant, price, coupon, cart totals,
 * checkout, order status) plus a verifier that evaluates those rules against
 * a **transaction snapshot** supplied by a sandbox/staging system.
 *
 * Safety rules:
 *  - this module never talks to a payment provider and never submits an
 *    order — it only *verifies* a snapshot you hand it;
 *  - every verdict produced here is labelled `SANDBOX_DATA`, so a sandbox
 *    PASS can never be mistaken for production proof;
 *  - a missing field in the snapshot is INCONCLUSIVE, never a pass.
 *
 * Observations come from the snapshot itself (`source: 'sandbox'`), which is
 * independent of any browser agent's self-report.
 */
import { verifyWithChecks } from '../verification/local-engine.js';
import { normalizeChecks } from '../checks/validate.js';
import { ValidationError } from '../errors.js';

/** Sum of item quantities in a cart snapshot. */
function cartQuantity(cart) {
  if (!cart) return undefined;
  if (typeof cart.quantity === 'number') return cart.quantity;
  if (!Array.isArray(cart.items)) return undefined;
  return cart.items.reduce((sum, item) => sum + (Number(item?.qty ?? item?.quantity) || 0), 0);
}

/**
 * Rule catalog. `resolve` maps a transaction snapshot to the observed value;
 * `check` is the verification check that gets evaluated against it.
 */
export const ECOMMERCE_RULES = {
  product_available: {
    label: 'Product availability',
    description: 'The product is purchasable (in stock) on the product page.',
    severity: 'high',
    params: [],
    resolve: (tx) => tx?.product?.in_stock,
    check: () => ({ key: 'product_available', operator: 'equals', expected: true }),
  },
  sku_matches: {
    label: 'SKU / variant identity',
    description: 'The displayed SKU matches the expected one.',
    severity: 'high',
    params: ['sku'],
    resolve: (tx) => tx?.product?.sku,
    check: (p) => ({ key: 'sku_matches', operator: 'equals', expected: p.sku }),
  },
  variant_matches: {
    label: 'Product variant',
    description: 'The selected variant (size/colour/etc.) matches the expected value.',
    severity: 'medium',
    params: ['variant'],
    resolve: (tx) => tx?.product?.variant,
    check: (p) => ({ key: 'variant_matches', operator: 'equals', expected: p.variant }),
  },
  price_at_most: {
    label: 'Price ceiling',
    description: 'The listed price is at or below the allowed amount.',
    severity: 'high',
    params: ['amount'],
    resolve: (tx) => tx?.product?.price,
    check: (p) => ({ key: 'price_at_most', operator: 'lte', expected: Number(p.amount), transform: 'number' }),
  },
  price_equals: {
    label: 'Exact price',
    description: 'The listed price equals the expected amount.',
    severity: 'high',
    params: ['amount'],
    resolve: (tx) => tx?.product?.price,
    check: (p) => ({ key: 'price_equals', operator: 'equals', expected: Number(p.amount) }),
  },
  discount_at_least: {
    label: 'Discount applied',
    description: 'The order summary shows at least the expected discount.',
    severity: 'medium',
    params: ['amount'],
    resolve: (tx) => tx?.cart?.discount,
    check: (p) => ({ key: 'discount_at_least', operator: 'gte', expected: Number(p.amount), transform: 'number' }),
  },
  coupon_applied: {
    label: 'Coupon code applied',
    description: 'The coupon code appears on the order summary.',
    severity: 'medium',
    params: ['code'],
    resolve: (tx) => tx?.cart?.coupon,
    check: (p) => ({ key: 'coupon_applied', operator: 'contains', expected: p.code }),
  },
  cart_quantity_at_least: {
    label: 'Cart quantity',
    description: 'The cart holds at least the expected number of items.',
    severity: 'medium',
    params: ['quantity'],
    resolve: (tx) => cartQuantity(tx?.cart),
    check: (p) => ({ key: 'cart_quantity_at_least', operator: 'gte', expected: Number(p.quantity) }),
  },
  cart_total_at_most: {
    label: 'Cart total ceiling',
    description: 'The cart/checkout total is at or below the allowed amount.',
    severity: 'high',
    params: ['amount'],
    resolve: (tx) => tx?.cart?.total,
    check: (p) => ({ key: 'cart_total_at_most', operator: 'lte', expected: Number(p.amount), transform: 'number' }),
  },
  checkout_ready: {
    label: 'Checkout validation',
    description: 'The checkout step reports itself ready/valid for submission.',
    severity: 'high',
    params: [],
    resolve: (tx) => tx?.checkout?.ready ?? tx?.checkout?.valid,
    check: () => ({ key: 'checkout_ready', operator: 'equals', expected: true }),
  },
  order_created: {
    label: 'Order creation',
    description: 'An order record was created in the backend.',
    severity: 'high',
    params: [],
    resolve: (tx) => tx?.order?.id,
    check: () => ({ key: 'order_created', operator: 'exists', expected: true }),
  },
  order_status: {
    label: 'Backend order status',
    description: 'The order status in the backend matches the expected state.',
    severity: 'high',
    params: ['status'],
    resolve: (tx) => tx?.order?.status,
    check: (p) => ({ key: 'order_status', operator: 'equals', expected: p.status }),
  },
};

/**
 * Turn `expectations` (`[{ type, ...params }]`) into validated checks.
 * @param {Array<{type: string} & Record<string, any>>} expectations
 */
export function buildEcommerceChecks(expectations) {
  if (!Array.isArray(expectations) || expectations.length === 0) {
    throw new ValidationError('expectations must be a non-empty array of rule objects', {
      rules: Object.keys(ECOMMERCE_RULES),
    });
  }
  return normalizeChecks(
    expectations.map((expectation, index) => {
      const rule = ECOMMERCE_RULES[expectation?.type];
      if (!rule) {
        throw new ValidationError(`expectations[${index}].type must be one of: ${Object.keys(ECOMMERCE_RULES).join(', ')}`, {
          rules: Object.keys(ECOMMERCE_RULES),
        });
      }
      for (const param of rule.params) {
        if (expectation[param] === undefined || expectation[param] === null || expectation[param] === '') {
          throw new ValidationError(`expectations[${index}] (${expectation.type}) requires "${param}"`, {
            params: rule.params,
          });
        }
      }
      const base = rule.check(expectation);
      return {
        ...base,
        source: 'sandbox',
        description: rule.description,
        severity: expectation.severity ?? rule.severity,
      };
    }),
    'expectations',
  );
}

/**
 * Verify a sandbox transaction snapshot against e-commerce expectations.
 *
 * @param {{
 *   transaction: object,          // { product, cart, checkout, order }
 *   expectations: object[],       // [{ type, ...params }]
 *   requirementId?: string|null,
 *   requirement?: string|null,
 * }} input
 */
export function verifySandboxTransaction({ transaction, expectations, requirementId = null, requirement = null }) {
  if (!transaction || typeof transaction !== 'object' || Array.isArray(transaction)) {
    throw new ValidationError('transaction must be an object (sandbox snapshot)');
  }

  const checks = buildEcommerceChecks(expectations);
  const rules = expectations.map((e) => ECOMMERCE_RULES[e.type]);

  // Resolve every observed value from the snapshot, keyed by check key.
  const sandbox = {};
  checks.forEach((check, i) => {
    const rule = rules[i];
    const observed = rule.resolve(transaction);
    sandbox[check.key] = {
      value: observed,
      evidence_ref: `sandbox:${rule.label.toLowerCase().replace(/\s+/g, '_')}`,
    };
  });

  const result = verifyWithChecks({
    executionId: `sandbox:${requirementId ?? 'transaction'}`,
    requirementId,
    requirement,
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
    externalResults: { sandbox },
  });

  // Label the whole thing as sandbox evidence — never production proof.
  result.details.sandbox = true;
  result.details.reason_codes = [...new Set([...(result.details.reason_codes ?? []), 'SANDBOX_DATA'])];
  result.details.explanation = `${result.details.explanation} (Verified against a sandbox transaction snapshot, not production data.)`;
  return result;
}
