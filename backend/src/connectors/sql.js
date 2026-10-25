/**
 * SQL verification connector — read-only, parameterized, time-boxed queries.
 *
 * Architecture: a driver registry so PostgreSQL can be added later behind the
 * same contract. **Only `sqlite` is implemented and tested today**; any other
 * driver fails loudly with NOT_IMPLEMENTED rather than pretending to work.
 *
 * Safety layers (all independent):
 *   1. statement validation — single statement, SELECT/WITH only, no
 *      DDL/DML/utility keywords even inside the statement (string literals
 *      are masked first so `"please update me"` in data stays legal);
 *   2. bound parameters — values never enter the SQL text;
 *   3. driver-level read-only open + `PRAGMA query_only`, so a validation
 *      bypass still cannot write;
 *   4. LIMIT enforcement + max rows + max cell bytes;
 *   5. a forked child process per query with a hard timeout — node:sqlite is
 *      synchronous native code, so a thread stuck inside sqlite3_step cannot
 *      be interrupted by V8 termination; killing the process always works.
 *
 * The child runs with a scrubbed environment (no API keys / secrets) and a
 * private IPC channel; it is reaped on success, failure, timeout and parent
 * exit so no orphaned processes are left behind.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SQL_DRIVERS = ['sqlite'];

/** Keywords that must never appear in a verification query. */
const FORBIDDEN_KEYWORDS = [
  'insert', 'update', 'delete', 'drop', 'alter', 'create', 'truncate', 'replace',
  'vacuum', 'attach', 'detach', 'pragma', 'reindex', 'analyze', 'grant', 'revoke',
  'begin', 'commit', 'rollback', 'savepoint', 'load_extension', 'writefile',
];

/** Mask string/blob literals and comments so keyword scanning ignores data. */
function maskLiterals(sql) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < sql.length) {
    const char = sql[i];
    if (quote) {
      if (char === quote) {
        if (sql[i + 1] === quote) { i += 2; continue; } // escaped quote
        quote = null;
      } else if (char === '\\' && quote === '"') {
        i += 2;
        continue;
      }
      out += ' ';
      i += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') { quote = char; out += ' '; i += 1; continue; }
    if (char === '-' && sql[i + 1] === '-') { while (i < sql.length && sql[i] !== '\n') i += 1; continue; }
    if (char === '/' && sql[i + 1] === '*') { i += 2; while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1; i += 2; continue; }
    out += char;
    i += 1;
  }
  return out;
}

/** Split on top-level semicolons (outside quotes — already masked). */
function statements(masked) {
  return masked.split(';').map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Validate a query. Throws a typed Error with a safe message.
 * @returns {{ sql: string, masked: string }}
 */
export function validateReadOnlyQuery(sql, { maxLength = 4_000 } = {}) {
  if (typeof sql !== 'string' || !sql.trim()) throw sqlError('Query must be a non-empty string');
  if (sql.length > maxLength) throw sqlError(`Query exceeds ${maxLength} characters`);

  const masked = maskLiterals(sql);
  const parts = statements(masked);
  if (parts.length === 0) throw sqlError('Query contains no statement');
  if (parts.length > 1) throw sqlError('Multiple statements are not allowed — send exactly one query');

  const leading = parts[0].replace(/^\s+/, '');
  if (!/^(select|with)\b/i.test(leading)) {
    throw sqlError('Only read-only queries are allowed (the statement must start with SELECT or WITH)');
  }

  const words = masked.toLowerCase().match(/[a-z_]+/g) ?? [];
  for (const keyword of FORBIDDEN_KEYWORDS) {
    if (words.includes(keyword)) {
      throw sqlError(`Forbidden keyword "${keyword.toUpperCase()}" — verification queries are read-only`);
    }
  }
  if (/\bload_extension\b|\bwrite_file\b/i.test(masked)) throw sqlError('Forbidden SQLite function');

  return { sql: sql.trim(), masked };
}

function sqlError(message) {
  const err = new Error(message);
  err.code = 'VALIDATION_ERROR';
  return err;
}

/** Bound parameters must be primitives — no objects, no driver surprises. */
export function validateParams(params) {
  if (params === undefined || params === null) return [];
  if (!Array.isArray(params)) throw sqlError('params must be an array of primitive values');
  return params.map((value, index) => {
    if (value === null) return null;
    if (['string', 'number', 'boolean'].includes(typeof value)) return value;
    if (value instanceof Uint8Array) return value;
    throw sqlError(`params[${index}] must be a primitive (string, number, boolean or null)`);
  });
}

export class SqlConnector {
  /**
   * @param {{ driver?: string, path: string, timeout_ms?: number, max_rows?: number,
   *           max_cell_bytes?: number, include_params_in_evidence?: boolean }} config
   */
  constructor(config = {}) {
    const driver = config.driver ?? 'sqlite';
    if (!SQL_DRIVERS.includes(driver)) {
      const err = new Error(
        `SQL driver "${driver}" is not implemented. Implemented and tested: ${SQL_DRIVERS.join(', ')}. ` +
          'PostgreSQL is an architecture target only — do not claim support until it is implemented and tested.',
      );
      err.code = 'NOT_IMPLEMENTED_SQL_DRIVER';
      throw err;
    }
    if (!config.path || typeof config.path !== 'string') {
      throw sqlError('database connector requires "path" (SQLite file path)');
    }
    this.config = config;
    this.dbPath = config.path;
    this.timeoutMs = config.timeout_ms ?? 5_000;
    this.maxRows = config.max_rows ?? 200;
    this.maxCellBytes = config.max_cell_bytes ?? 10_000;
    this.includeParams = config.include_params_in_evidence ?? false;
  }

  describe() {
    return {
      driver: 'sqlite',
      // Least privilege: the file is opened read-only by the worker.
      privileges: 'read_only',
      timeout_ms: this.timeoutMs,
      max_rows: this.maxRows,
      database: path.basename(this.dbPath),
    };
  }

  /**
   * @param {{ key: string, sql: string, params?: any[] }} step
   * @returns {Promise<{ key, ok, value, evidence, error }>}
   */
  async run(step) {
    const startedAt = Date.now();
    const key = step.key;

    const evidenceBase = (extra = {}) => ({
      kind: 'database_result',
      source: `sql_connector:${(step.sql ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)}`,
      driver: 'sqlite',
      database: path.basename(this.dbPath),
      statement_sha256: step.sql ? crypto.createHash('sha256').update(step.sql).digest('hex') : null,
      params: this.includeParams ? (step.params ?? []) : '[redacted]',
      params_redacted: !this.includeParams,
      duration_ms: Date.now() - startedAt,
      captured_at: new Date().toISOString(),
      ...extra,
    });

    let validated;
    let params;
    try {
      validated = validateReadOnlyQuery(step.sql);
      params = validateParams(step.params);
    } catch (err) {
      return {
        key,
        ok: false,
        value: null,
        error: { code: err.code === 'VALIDATION_ERROR' ? 'VALIDATION_ERROR' : 'CONNECTOR_UNAVAILABLE', message: err.message },
        evidence: evidenceBase({ rejected: true, error: err.message }),
      };
    }

    try {
      const result = await this.#execute(validated.sql, params);
      if (!result.ok) {
        return {
          key,
          ok: false,
          value: null,
          error: { code: 'CONNECTOR_UNAVAILABLE', message: `SQL query failed: ${result.error}` },
          evidence: evidenceBase({ error: result.error }),
        };
      }
      const value = {
        row_count: result.row_count,
        rows: result.rows,
        first: result.rows[0] ?? null,
        columns: result.columns,
      };
      return {
        key,
        ok: true,
        value,
        error: null,
        evidence: evidenceBase({
          row_count: result.row_count,
          returned: result.returned,
          truncated: result.truncated,
          columns: result.columns,
          rows_preview: result.rows.slice(0, 20),
          executed_sql: validated.sql,
        }),
      };
    } catch (err) {
      const timedOut = err?.message === 'timeout';
      return {
        key,
        ok: false,
        value: null,
        error: timedOut
          ? { code: 'CONNECTOR_TIMEOUT', message: `SQL query exceeded ${this.timeoutMs}ms and was terminated` }
          : { code: 'CONNECTOR_UNAVAILABLE', message: err?.message ?? String(err) },
        evidence: evidenceBase({ error: err?.message ?? String(err) }),
      };
    }
  }

  #execute(sql, params) {
    return new Promise((resolve, reject) => {
      const payload = {
        dbPath: this.dbPath,
        sql,
        params,
        maxRows: this.maxRows,
        maxCellBytes: this.maxCellBytes,
        busyTimeoutMs: Math.min(this.timeoutMs, 2_000),
      };

      let child;
      try {
        child = fork(fileURLToPath(new URL('./sql-worker.js', import.meta.url)), [], {
          // stdout ignored (results travel over IPC), stderr piped for
          // crash diagnostics, ipc channel for the result message.
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
          windowsHide: true,
          execArgv: ['--max-old-space-size=128'],
          // The query child never inherits app secrets (TINYFISH_API_KEY,
          // connector tokens, …) — it needs nothing but the OS basics.
          env: childEnv(),
          // v8 serialization keeps Uint8Array/Blob-style bound parameters
          // intact across the channel (JSON would corrupt them).
          serialization: 'advanced',
        });
      } catch (err) {
        reject(err);
        return;
      }
      trackChild(child);

      let stderrTail = '';
      child.stderr?.on('data', (chunk) => {
        stderrTail = `${stderrTail}${String(chunk)}`.slice(-1_000);
      });

      let settled = false;

      // Hard timeout: SIGKILL — uncatchable on every platform, which is
      // exactly what a query stuck in native SQLite code needs.
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const err = new Error('timeout');
        err.code = 'CONNECTOR_TIMEOUT';
        hardKill(child);
        reject(err);
      }, this.timeoutMs);

      child.once('message', (message) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(message);
        // Reap a child that lingers after reporting: nothing keeps it alive.
        const reap = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) hardKill(child);
        }, 2_000);
        reap.unref?.();
      });

      child.once('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });

      // The child died before reporting: crash, OOM, external kill.
      child.once('exit', (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(childCrashError(code, signal, stderrTail));
      });

      try {
        child.send(payload, (sendErr) => {
          if (sendErr && !settled) {
            settled = true;
            clearTimeout(timer);
            hardKill(child);
            reject(sendErr);
          }
        });
      } catch (err) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          hardKill(child);
          reject(err);
        }
      }
    });
  }
}

// ── Child-process bookkeeping ──────────────────────────────────────────────

const liveChildren = new Set();
let exitHookInstalled = false;

function trackChild(child) {
  liveChildren.add(child);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    // If this process exits for any reason, no query child may survive it.
    process.once('exit', () => {
      for (const c of liveChildren) {
        try {
          c.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
      liveChildren.clear();
    });
  }
  const forget = () => liveChildren.delete(child);
  child.once('exit', forget);
  child.once('error', forget);
}

/** SIGKILL: works even while the child is inside a native SQLite call. */
function hardKill(child) {
  try {
    child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
}

/** Minimal, secret-free environment for the query child. */
function childEnv() {
  const env = {};
  for (const key of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'PATHEXT']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function childCrashError(code, signal, stderrTail) {
  const tail = stderrTail
    .replace(/\u001b\[[0-9;]*m/g, '')
    .trim()
    .slice(-400);
  const how = signal ? `signal ${signal}` : `code ${code}`;
  const err = new Error(
    `SQL child process exited unexpectedly (${how})${tail ? `: ${tail}` : ''}`,
  );
  err.code = 'CONNECTOR_UNAVAILABLE';
  return err;
}

/**
 * Live SQL child processes. Used by diagnostics and tests to prove that no
 * orphaned children remain after success, failure and timeout paths.
 * @returns {import('node:child_process').ChildProcess[]}
 */
export function activeSqlChildren() {
  return [...liveChildren];
}
