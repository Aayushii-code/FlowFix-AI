/**
 * SQL verification query runner — executes ONE validated, read-only query and
 * reports capped rows back to the parent process.
 *
 * Runs as a separate OS **process** (forked by sql.js), not a worker thread:
 * node:sqlite is synchronous native code, and a thread stuck inside
 * `sqlite3_step` cannot be interrupted by V8 termination — only killing the
 * whole process enforces a hard timeout. The parent kills this process on
 * timeout, crash or parent exit; nothing here can outlive it by design.
 *
 * Three independent safety layers:
 *   1. the parent validates the statement before spawning (single SELECT/WITH,
 *      no DDL/DML keywords);
 *   2. this process re-validates the statement itself — a tampered or
 *      bypassed payload still cannot execute non-read-only SQL;
 *   3. the database is opened **read-only** with `PRAGMA query_only`, so even
 *      a validation bypass cannot write anything.
 *
 * The child receives only the query payload over its private IPC channel and
 * runs with a scrubbed environment — no API keys or app secrets exist in
 * this process at all.
 */
import { DatabaseSync } from 'node:sqlite';
import { validateReadOnlyQuery, validateParams } from './sql.js';

if (typeof process.send !== 'function') {
  // Defensive: this script is only meaningful through the parent's fork().
  console.error('sql-worker.js must be forked by sql.js with an IPC channel');
  process.exit(2);
}

/** Report a result to the parent, then exit — never linger. */
function finish(message) {
  try {
    process.send(message, () => process.exit(0));
  } catch {
    process.exit(1);
  }
  // Safety net if the send callback never fires (parent vanished mid-send).
  const bail = setTimeout(() => process.exit(1), 2_000);
  bail.unref?.();
}

function capValue(value, maxCellBytes) {
  if (typeof value === 'string' && value.length > maxCellBytes) {
    return { value: `${value.slice(0, maxCellBytes)}…[truncated]`, truncated: true };
  }
  if (Buffer.isBuffer?.(value) || value instanceof Uint8Array) {
    return { value: `<binary ${value.length} bytes>`, truncated: true };
  }
  return { value, truncated: false };
}

process.on('message', (payload) => {
  const startedAt = Date.now();
  let db = null;
  try {
    const { dbPath, sql, params, maxRows, maxCellBytes, busyTimeoutMs } = payload ?? {};
    if (!dbPath || !sql) throw Object.assign(new Error('malformed SQL payload'), { code: 'VALIDATION_ERROR' });

    // Layer 2: re-validate here, independently of the parent.
    validateReadOnlyQuery(sql);
    const safeParams = validateParams(params);

    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec('PRAGMA query_only = ON');
    db.exec(`PRAGMA busy_timeout = ${Number(busyTimeoutMs) || 2000}`);

    const statement = db.prepare(sql);
    const rawRows = statement.all(...safeParams);

    let truncatedRows = false;
    const rows = rawRows.slice(0, maxRows).map((row) => {
      const out = {};
      for (const [column, raw] of Object.entries(row)) {
        const capped = capValue(raw, maxCellBytes);
        if (capped.truncated) truncatedRows = true;
        out[column] = capped.value;
      }
      return out;
    });

    const columns = rows.length > 0 ? Object.keys(rows[0]) : (statement.columns?.() ?? []).map((c) => c.name);

    finish({
      ok: true,
      rows,
      row_count: rawRows.length,
      returned: rows.length,
      truncated: truncatedRows || rawRows.length > rows.length,
      columns,
      duration_ms: Date.now() - startedAt,
    });
  } catch (err) {
    // Error messages come from SQLite/validation — they may quote the query
    // text but never parameters (bound values are not echoed by SQLite).
    finish({ ok: false, error: err?.message ?? String(err), code: err?.code ?? null });
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
  }
});
