/**
 * Contract repository — the Contract Library's data-access layer.
 *
 * Contracts are the unit of assurance: a business requirement plus the
 * machine-verifiable checks that prove it. Rows hold JSON documents in TEXT
 * columns; this module owns (de)serialization so callers only ever see plain
 * objects.
 */
import crypto from 'node:crypto';
import { parseJsonColumn, toJsonColumn } from './json.js';

const JSON_COLUMNS = new Set([
  'checks',
  'preconditions',
  'steps',
  'expected_results',
  'evidence_requirements',
  'expected_outcome',
]);

function rowToContract(row) {
  if (!row) return null;
  const contract = { ...row };
  for (const column of JSON_COLUMNS) contract[column] = parseJsonColumn(row[column], []);
  contract.expected_outcome = parseJsonColumn(row.expected_outcome, null);
  contract.version = Number(row.version);
  return contract;
}

const toJsonValue = (value) => toJsonColumn(value, null);

export function createContractRepository(db) {
  const insertStmt = db.prepare(`
    INSERT INTO contracts (
      id, name, description, requirement, url, goal, checks, preconditions,
      steps, expected_results, evidence_requirements, expected_outcome,
      risk_level, status, version, source, created_at, updated_at
    ) VALUES (
      @id, @name, @description, @requirement, @url, @goal, @checks, @preconditions,
      @steps, @expected_results, @evidence_requirements, @expected_outcome,
      @risk_level, @status, @version, @source, @created_at, @updated_at
    )
  `);

  const getStmt = db.prepare('SELECT * FROM contracts WHERE id = ?');
  const deleteStmt = db.prepare('DELETE FROM contracts WHERE id = ?');

  const INSERTABLE = [
    'id',
    'name',
    'description',
    'requirement',
    'url',
    'goal',
    'checks',
    'preconditions',
    'steps',
    'expected_results',
    'evidence_requirements',
    'expected_outcome',
    'risk_level',
    'status',
    'version',
    'source',
    'created_at',
    'updated_at',
  ];

  function insert(contract) {
    const params = {};
    for (const key of INSERTABLE) {
      let value = contract[key];
      if (value === undefined) value = JSON_COLUMNS.has(key) ? [] : null;
      if (value === null) {
        params[key] = null;
      } else if (JSON_COLUMNS.has(key) || typeof value === 'object') {
        // Any document value is stored as JSON text (portable to PostgreSQL).
        params[key] = toJsonColumn(value, null);
      } else {
        params[key] = value;
      }
    }
    params.id = params.id ?? crypto.randomUUID();
    params.checks = params.checks ?? '[]';
    params.risk_level = params.risk_level ?? 'medium';
    params.status = params.status ?? 'active';
    params.version = params.version ?? 1;
    params.source = params.source ?? 'manual';
    params.created_at = params.created_at ?? new Date().toISOString();
    params.updated_at = params.updated_at ?? params.created_at;
    insertStmt.run(params);
    return get(params.id);
  }

  function get(id) {
    return rowToContract(getStmt.get(id));
  }

  /**
   * List with search + pagination. Newest updated first.
   * @param {{ q?: string, status?: string, risk_level?: string, limit?: number, offset?: number }} opts
   */
  function list({ q = '', status = 'active', risk_level = null, limit = 50, offset = 0 } = {}) {
    const where = [];
    const params = {};
    if (status && status !== 'all') {
      where.push('status = @status');
      params.status = status;
    }
    if (risk_level) {
      where.push('risk_level = @risk_level');
      params.risk_level = risk_level;
    }
    if (q && q.trim()) {
      where.push('(name LIKE @q OR requirement LIKE @q OR description LIKE @q OR url LIKE @q)');
      params.q = `%${q.trim()}%`;
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    // node:sqlite binds only parameters the statement declares: pagination
    // goes to the page query, filter params to both, never the reverse.
    const pageParams = {
      ...params,
      limit: Math.max(1, Math.min(200, Number(limit) || 50)),
      offset: Math.max(0, Number(offset) || 0),
    };

    const rows = db
      .prepare(
        `SELECT * FROM contracts ${clause}
         ORDER BY updated_at DESC, created_at DESC
         LIMIT @limit OFFSET @offset`,
      )
      .all(pageParams);
    const total = db
      .prepare(`SELECT COUNT(*) AS c FROM contracts ${clause}`)
      .get(params).c;
    return { contracts: rows.map(rowToContract), total: Number(total) };
  }

  /** Full update; bumps version and records a revision snapshot. */
  function update(id, patch, { changeNote = null } = {}) {
    const current = get(id);
    if (!current) return null;
    const next = { ...current, ...patch, id };
    next.version = current.version + 1;
    next.updated_at = new Date().toISOString();

    db.exec('BEGIN');
    try {
      db.prepare(
        `UPDATE contracts SET
           name = @name, description = @description, requirement = @requirement,
           url = @url, goal = @goal, checks = @checks, preconditions = @preconditions,
           steps = @steps, expected_results = @expected_results,
           evidence_requirements = @evidence_requirements, expected_outcome = @expected_outcome,
           risk_level = @risk_level, status = @status, version = @version, updated_at = @updated_at
         WHERE id = @id`,
      ).run({
        id: next.id,
        name: next.name,
        description: next.description ?? null,
        requirement: next.requirement,
        url: next.url ?? null,
        goal: next.goal ?? null,
        checks: toJsonValue(next.checks ?? []),
        preconditions: toJsonValue(next.preconditions ?? []),
        steps: toJsonValue(next.steps ?? []),
        expected_results: toJsonValue(next.expected_results ?? []),
        evidence_requirements: toJsonValue(next.evidence_requirements ?? []),
        expected_outcome: toJsonValue(next.expected_outcome ?? null),
        risk_level: next.risk_level ?? 'medium',
        status: next.status ?? 'active',
        version: next.version,
        updated_at: next.updated_at,
      });
      insertRevision(id, current.version, current, changeNote ?? 'auto-snapshot before update');
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return get(id);
  }

  function remove(id) {
    const info = deleteStmt.run(id);
    return Number(info.changes) > 0;
  }

  function insertRevision(contractId, version, snapshot, changeNote = null) {
    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO contract_revisions (id, contract_id, version, snapshot, change_note, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, contractId, version, JSON.stringify(snapshot), changeNote, new Date().toISOString());
    return id;
  }

  function listRevisions(contractId) {
    const rows = db
      .prepare(
        'SELECT id, version, change_note, created_at, snapshot FROM contract_revisions WHERE contract_id = ? ORDER BY version DESC',
      )
      .all(contractId);
    return rows.map((row) => ({
      id: row.id,
      version: Number(row.version),
      change_note: row.change_note,
      created_at: row.created_at,
      snapshot: parseJsonColumn(row.snapshot, null),
    }));
  }

  function count() {
    return Number(db.prepare('SELECT COUNT(*) AS c FROM contracts').get().c);
  }

  return { insert, get, list, update, remove, insertRevision, listRevisions, count };
}
