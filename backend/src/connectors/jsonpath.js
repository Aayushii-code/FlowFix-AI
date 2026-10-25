/**
 * JSONPath subset — field-level assertion paths.
 *
 * Supported (documented, deliberately small):
 *   $.a.b            object navigation (leading `$` optional)
 *   $.a[0].b         array index
 *   $.a[*].b         map over an array → returns an array of values
 *   $[-1]            negative index (last element)
 *
 * Not supported (throws a typed error rather than silently misbehaving):
 * filters `?(@.x > 1)`, recursive descent `..`, unions, slices.
 */

const UNSUPPORTED = [/\?\s*\(/, /\.\./, /:\s*-?\d/, /\|/];

export function parseJsonPath(path) {
  if (typeof path !== 'string' || !path.trim()) {
    throw new Error('path must be a non-empty string');
  }
  for (const pattern of UNSUPPORTED) {
    if (pattern.test(path)) {
      throw new Error(`Unsupported JSONPath feature in "${path}" (only $.a.b, [n], [*] and [-n] are supported)`);
    }
  }
  const normalized = path.startsWith('$') ? path.slice(1) : path;
  return normalized
    .replace(/\[(\d+|\*|-\d+)\]/g, '.$1')
    .split('.')
    .filter((part) => part !== '');
}

/**
 * @param {any} root parsed JSON document
 * @param {string} path assertion path
 * @returns {{ found: boolean, value: any, wildcard: boolean }}
 */
export function resolveJsonPath(root, path) {
  const parts = parseJsonPath(path);
  let cursor = root;
  let wildcard = false;

  for (const part of parts) {
    if (cursor === null || cursor === undefined) return { found: false, value: undefined, wildcard };

    if (part === '*') {
      if (!Array.isArray(cursor)) return { found: false, value: undefined, wildcard: true };
      wildcard = true;
      // Remaining segments are applied per element; collapse to a value array.
      const rest = parts.slice(parts.indexOf(part) + 1);
      const mapped = [];
      let anyFound = false;
      for (const element of cursor) {
        const sub = rest.length ? resolveJsonPath(element, rest.join('.')) : { found: true, value: element };
        if (sub.found) {
          anyFound = true;
          mapped.push(sub.value);
        }
      }
      return { found: anyFound, value: mapped, wildcard: true };
    }

    if (Array.isArray(cursor)) {
      const index = part === '-1' ? cursor.length - 1 : Number(part);
      if (!Number.isInteger(index) || index < 0 || index >= cursor.length) {
        return { found: false, value: undefined, wildcard };
      }
      cursor = cursor[index];
      continue;
    }

    if (typeof cursor !== 'object') return { found: false, value: undefined, wildcard };
    if (!(part in cursor)) return { found: false, value: undefined, wildcard };
    cursor = cursor[part];
  }

  return { found: true, value: cursor, wildcard };
}
