/**
 * Audit log repository — append-only trail of who did what and when.
 *
 * The table is deliberately insert-only from the application's point of view;
 * nothing updates or deletes audit rows, so the trail stays trustworthy.
 */
import { parseJsonColumn, toJsonColumn } from './json.js';

export function createAuditRepository(db) {
  // `id` is INTEGER PRIMARY KEY (the SQLite rowid alias), so the row id is
  // assigned by SQLite itself — never a UUID string, which SQLite rejects
  // with "datatype mismatch".
  const insertStmt = db.prepare(
    `INSERT INTO audit_log (ts, actor, action, entity_type, entity_id, details)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  /** Record one audit entry. Returns the new row id. */
  function record({ actor = 'system', action, entityType = null, entityId = null, details = null }) {
    const info = insertStmt.run(
      new Date().toISOString(),
      actor,
      action,
      entityType,
      entityId,
      toJsonColumn(details),
    );
    return Number(info.lastInsertRowid);
  }

  function list({ action = null, entity_type = null, entity_id = null, actor = null, limit = 100, offset = 0 } = {}) {
    const where = [];
    const params = {};
    if (action) {
      where.push('action = @action');
      params.action = action;
    }
    if (entity_type) {
      where.push('entity_type = @entity_type');
      params.entity_type = entity_type;
    }
    if (entity_id) {
      where.push('entity_id = @entity_id');
      params.entity_id = entity_id;
    }
    if (actor) {
      where.push('actor = @actor');
      params.actor = actor;
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    // node:sqlite only accepts parameters the statement actually declares, so
    // pagination params are bound to the page query, never to the COUNT.
    const pageParams = {
      ...params,
      limit: Math.max(1, Math.min(500, Number(limit) || 100)),
      offset: Math.max(0, Number(offset) || 0),
    };

    const rows = db
      .prepare(
        `SELECT * FROM audit_log ${clause} ORDER BY ts DESC, rowid DESC LIMIT @limit OFFSET @offset`,
      )
      .all(pageParams);
    const total = Number(db.prepare(`SELECT COUNT(*) AS c FROM audit_log ${clause}`).get(params).c);

    return {
      entries: rows.map((row) => ({
        id: row.id,
        ts: row.ts,
        actor: row.actor,
        action: row.action,
        entity_type: row.entity_type,
        entity_id: row.entity_id,
        details: parseJsonColumn(row.details, null),
      })),
      total,
    };
  }

  return { record, list };
}
