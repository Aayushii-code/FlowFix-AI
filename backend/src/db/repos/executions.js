/**
 * Execution repository — persistent run history.
 *
 * The engine keeps *live* runs in memory (SSE subscribers need them); this
 * repository is the durable record of every execution, including ones that
 * were evicted from memory. Every transition writes a full snapshot, so the
 * table is always a faithful history — no in-memory-only state, no mock data.
 */
import { parseJsonColumn, toJsonColumn } from './json.js';

const JSON_COLUMNS = ['spec', 'error', 'record', 'verification', 'events', 'expected_outcome', 'checks', 'root_cause'];

function rowToExecution(row) {
  if (!row) return null;
  const execution = { ...row };
  for (const column of JSON_COLUMNS) execution[column] = parseJsonColumn(row[column], null);
  return execution;
}

export function createExecutionRepository(db) {
  const upsertStmt = db.prepare(`
    INSERT INTO executions (
      id, contract_id, scenario_id, status, verdict, url, goal, requirement,
      expected_outcome, checks, spec, error, record, verification, events,
      root_cause, created_at, finished_at, updated_at
    ) VALUES (
      @id, @contract_id, @scenario_id, @status, @verdict, @url, @goal, @requirement,
      @expected_outcome, @checks, @spec, @error, @record, @verification, @events,
      @root_cause, @created_at, @finished_at, @updated_at
    )
    ON CONFLICT (id) DO UPDATE SET
      contract_id = excluded.contract_id,
      scenario_id = excluded.scenario_id,
      status = excluded.status,
      verdict = excluded.verdict,
      url = excluded.url,
      goal = excluded.goal,
      requirement = excluded.requirement,
      expected_outcome = excluded.expected_outcome,
      checks = excluded.checks,
      spec = excluded.spec,
      error = excluded.error,
      record = excluded.record,
      verification = excluded.verification,
      events = excluded.events,
      root_cause = excluded.root_cause,
      finished_at = excluded.finished_at,
      updated_at = excluded.updated_at
  `);

  /** Persist a full execution snapshot (public view shape + raw events). */
  function save(snapshot) {
    upsertStmt.run({
      id: snapshot.id ?? snapshot.execution_id,
      contract_id: snapshot.contract_id ?? null,
      scenario_id: snapshot.scenario_id ?? null,
      status: snapshot.status,
      verdict: snapshot.verification?.verdict ?? null,
      url: snapshot.url ?? null,
      goal: snapshot.goal ?? null,
      requirement: snapshot.requirement ?? null,
      expected_outcome: toJsonColumn(snapshot.expected_outcome),
      checks: toJsonColumn(snapshot.checks),
      spec: toJsonColumn(snapshot.spec),
      error: toJsonColumn(snapshot.error),
      record: toJsonColumn(snapshot.record),
      verification: toJsonColumn(snapshot.verification),
      events: toJsonColumn(snapshot.events),
      root_cause: toJsonColumn(snapshot.root_cause),
      created_at: snapshot.created_at ?? new Date().toISOString(),
      finished_at: snapshot.finished_at ?? null,
      updated_at: new Date().toISOString(),
    });
  }

  function get(id) {
    return rowToExecution(db.prepare('SELECT * FROM executions WHERE id = ?').get(id));
  }

  /**
   * Searchable, paginated history. Newest first.
   * @param {{
   *   q?: string, status?: string, verdict?: string, contract_id?: string,
   *   scenario_id?: string, from?: string, to?: string,
   *   limit?: number, offset?: number, include_body?: boolean
   * }} opts
   */
  function search({
    q = '',
    status = null,
    verdict = null,
    contract_id = null,
    scenario_id = null,
    from = null,
    to = null,
    limit = 50,
    offset = 0,
    includeBody = false,
  } = {}) {
    const where = [];
    const params = {};
    if (status) {
      where.push('status = @status');
      params.status = status;
    }
    if (verdict) {
      if (verdict === 'NONE') where.push('(verdict IS NULL)');
      else {
        where.push('verdict = @verdict');
        params.verdict = verdict;
      }
    }
    if (contract_id) {
      where.push('contract_id = @contract_id');
      params.contract_id = contract_id;
    }
    if (scenario_id) {
      where.push('scenario_id = @scenario_id');
      params.scenario_id = scenario_id;
    }
    if (from) {
      where.push('created_at >= @from');
      params.from = from;
    }
    if (to) {
      where.push('created_at <= @to');
      params.to = to;
    }
    if (q && q.trim()) {
      where.push(
        '(goal LIKE @q OR requirement LIKE @q OR url LIKE @q OR id LIKE @q ' +
          'OR scenario_id LIKE @q OR contract_id LIKE @q)',
      );
      params.q = `%${q.trim()}%`;
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    // node:sqlite errors on parameters a statement does not declare, so the
    // COUNT query binds filter params only; pagination is page-query only.
    const pageParams = {
      ...params,
      limit: Math.max(1, Math.min(200, Number(limit) || 50)),
      offset: Math.max(0, Number(offset) || 0),
    };

    const columns = includeBody
      ? '*'
      : `id, contract_id, scenario_id, status, verdict, url, goal, requirement,
         error, verification, created_at, finished_at, updated_at`;

    const rows = db
      .prepare(
        `SELECT ${columns} FROM executions ${clause}
         ORDER BY created_at DESC, rowid DESC
         LIMIT @limit OFFSET @offset`,
      )
      .all(pageParams);
    const total = Number(
      db.prepare(`SELECT COUNT(*) AS c FROM executions ${clause}`).get(params).c,
    );
    return { executions: rows.map(rowToExecution), total };
  }

  function setRootCause(id, rootCause) {
    db.prepare('UPDATE executions SET root_cause = ?, updated_at = ? WHERE id = ?').run(
      toJsonColumn(rootCause),
      new Date().toISOString(),
      id,
    );
  }

  function count() {
    return Number(db.prepare('SELECT COUNT(*) AS c FROM executions').get().c);
  }

  return { save, get, search, setRootCause, count };
}
