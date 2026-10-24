/**
 * Shared validation for `checks` — the objects that make a requirement
 * machine-verifiable. Used by both the execution route and the Contract
 * Library so a contract and an ad-hoc run accept exactly the same shape.
 */
import { ValidationError } from '../errors.js';
import { OPERATOR_NAMES } from './operators.js';

export const CHECK_SOURCES = [
  'page',
  'api',
  'database',
  'sandbox',
  'agent_report',
  'observation',
];

const SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);

/**
 * Validate and normalize the `checks` array (Aman's contract shape:
 * key/operator/expected). Malformed checks are rejected loudly instead of
 * silently producing an unverifiable run.
 *
 * @param {any} raw
 * @param {string} label used in error messages ('checks' by default)
 * @returns {object[]}
 */
export function normalizeChecks(raw, label = 'checks') {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ValidationError(`${label} must be an array`);

  return raw.map((check, index) => {
    const at = `${label}[${index}]`;
    if (!check || typeof check !== 'object' || Array.isArray(check)) {
      throw new ValidationError(`${at} must be an object`);
    }
    if (typeof check.key !== 'string' || !check.key.trim()) {
      throw new ValidationError(`${at}.key must be a non-empty string`);
    }
    if (typeof check.operator !== 'string' || !check.operator.trim()) {
      throw new ValidationError(`${at}.operator must be a non-empty string`);
    }
    if (!OPERATOR_NAMES.includes(check.operator)) {
      throw new ValidationError(`${at}.operator must be one of: ${OPERATOR_NAMES.join(', ')}`, {
        operators: OPERATOR_NAMES,
      });
    }
    if (check.source !== undefined && !CHECK_SOURCES.includes(check.source)) {
      throw new ValidationError(`${at}.source must be one of: ${CHECK_SOURCES.join(', ')}`, {
        sources: CHECK_SOURCES,
      });
    }
    if (check.severity !== undefined && !SEVERITIES.has(check.severity)) {
      throw new ValidationError(`${at}.severity must be one of: ${[...SEVERITIES].join(', ')}`);
    }

    return {
      key: check.key.trim(),
      description: typeof check.description === 'string' ? check.description : null,
      source: check.source ?? 'page',
      operator: check.operator,
      expected: check.expected ?? null,
      ...(check.path !== undefined ? { path: check.path } : {}),
      ...(check.pattern !== undefined ? { pattern: check.pattern } : {}),
      ...(check.transform !== undefined ? { transform: check.transform } : {}),
      ...(check.severity !== undefined ? { severity: check.severity } : {}),
      ...(check.required !== undefined ? { required: Boolean(check.required) } : {}),
    };
  });
}
