/**
 * Check operators — shared by the local verification engine, the natural
 * language compiler, e-commerce rules and cross-system assertions.
 *
 * Every operator returns a three-state result:
 *   { ok: true }   condition proven true by the evidence
 *   { ok: false }  condition proven false by the evidence
 *   { ok: null }   evidence missing/unusable → caller must say INCONCLUSIVE
 *
 * Nothing here ever defaults a missing observation to success.
 */

export const OPERATOR_NAMES = [
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
  'regex',
  'in',
  'not_in',
  'gt',
  'gte',
  'lt',
  'lte',
  'exists',
  'not_exists',
  'min_count',
  'max_count',
];

const MISSING = Object.freeze({ ok: null, reason: 'EVIDENCE_MISSING' });

/** Parse a number out of "₹1,20,000", "$1,299.00", "12 %", "120000". */
export function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[^0-9.\-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function applyTransform(value, transform) {
  switch (transform) {
    case 'number':
      return toNumber(value);
    case 'trim':
      return typeof value === 'string' ? value.trim() : value;
    case 'lowercase':
      return typeof value === 'string' ? value.toLowerCase() : value;
    case 'uppercase':
      return typeof value === 'string' ? value.toUpperCase() : value;
    case undefined:
    case null:
      return value;
    default:
      return value;
  }
}

function asString(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function lengthOf(value) {
  if (Array.isArray(value)) return value.length;
  const s = asString(value);
  return s === null ? null : s.length;
}

/**
 * @param {{ operator: string, expected?: any }} spec
 * @param {any} observed value resolved from evidence (undefined = missing)
 * @returns {{ ok: boolean|null, reason?: string, actual?: any }}
 */
export function evaluateOperator(spec, observed) {
  const operator = spec?.operator ?? 'equals';
  const expected = spec?.expected;

  if (observed === undefined || observed === null || observed === '') {
    if (operator === 'not_exists') return { ok: true, actual: observed ?? null };
    if (operator === 'exists') return { ok: false, actual: observed ?? null };
    return MISSING;
  }

  switch (operator) {
    case 'exists':
      return { ok: true, actual: observed };
    case 'not_exists':
      return { ok: false, actual: observed };

    case 'equals': {
      if (typeof expected === 'number') {
        const n = toNumber(observed);
        return n === null ? MISSING : { ok: n === expected, actual: n };
      }
      return { ok: asString(observed) === asString(expected), actual: observed };
    }
    case 'not_equals':
      return { ok: asString(observed) !== asString(expected), actual: observed };

    case 'contains': {
      if (Array.isArray(observed)) {
        return { ok: observed.some((item) => asString(item) === asString(expected)), actual: observed };
      }
      const hay = asString(observed);
      const needle = asString(expected);
      if (hay === null || needle === null) return MISSING;
      return { ok: hay.toLowerCase().includes(needle.toLowerCase()), actual: observed };
    }
    case 'not_contains': {
      const hay = asString(observed);
      const needle = asString(expected);
      if (hay === null || needle === null) return MISSING;
      return { ok: !hay.toLowerCase().includes(needle.toLowerCase()), actual: observed };
    }

    case 'starts_with': {
      const s = asString(observed);
      return s === null ? MISSING : { ok: s.toLowerCase().startsWith(String(expected).toLowerCase()), actual: observed };
    }
    case 'ends_with': {
      const s = asString(observed);
      return s === null ? MISSING : { ok: s.toLowerCase().endsWith(String(expected).toLowerCase()), actual: observed };
    }

    case 'regex': {
      const s = asString(observed);
      if (s === null) return MISSING;
      try {
        return { ok: new RegExp(expected, 'i').test(s), actual: observed };
      } catch {
        return { ok: null, reason: 'INVALID_OPERATOR_SPEC' };
      }
    }

    case 'in': {
      if (!Array.isArray(expected)) return { ok: null, reason: 'INVALID_OPERATOR_SPEC' };
      if (Array.isArray(observed)) {
        return { ok: observed.every((item) => expected.some((e) => asString(e) === asString(item))), actual: observed };
      }
      return { ok: expected.some((e) => asString(e) === asString(observed)), actual: observed };
    }
    case 'not_in': {
      if (!Array.isArray(expected)) return { ok: null, reason: 'INVALID_OPERATOR_SPEC' };
      return { ok: !expected.some((e) => asString(e) === asString(observed)), actual: observed };
    }

    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const actual = toNumber(observed);
      const target = toNumber(expected);
      if (actual === null || target === null) return MISSING;
      if (operator === 'gt') return { ok: actual > target, actual };
      if (operator === 'gte') return { ok: actual >= target, actual };
      if (operator === 'lt') return { ok: actual < target, actual };
      return { ok: actual <= target, actual };
    }

    case 'min_count': {
      const len = lengthOf(observed);
      if (len === null) return MISSING;
      return { ok: len >= Number(expected), actual: len };
    }
    case 'max_count': {
      const len = lengthOf(observed);
      if (len === null) return MISSING;
      return { ok: len <= Number(expected), actual: len };
    }

    default:
      return { ok: null, reason: 'UNKNOWN_OPERATOR' };
  }
}
