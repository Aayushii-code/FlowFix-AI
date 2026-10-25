/**
 * Ordered schema migrations for the FlowFix AI SQLite store.
 *
 * Rules:
 *  - migrations run in order, each inside its own transaction, and are
 *    recorded in `schema_migrations` so they never re-apply;
 *  - migrations are append-only — never edit an applied migration, add a new
 *    one instead;
 *  - SQL is deliberately portable (TEXT for JSON documents, ISO-8601 TEXT
 *    timestamps) so a later PostgreSQL port is a type swap, not a rewrite.
 */

export const MIGRATIONS = [
  {
    id: 1,
    name: 'initial_schema',
    sql: `
      CREATE TABLE contracts (
        id                   TEXT PRIMARY KEY,
        name                 TEXT NOT NULL,
        description          TEXT,
        requirement          TEXT NOT NULL,
        url                  TEXT,
        goal                 TEXT,
        checks               TEXT NOT NULL DEFAULT '[]',
        preconditions        TEXT NOT NULL DEFAULT '[]',
        steps                TEXT NOT NULL DEFAULT '[]',
        expected_results     TEXT NOT NULL DEFAULT '[]',
        evidence_requirements TEXT NOT NULL DEFAULT '[]',
        expected_outcome     TEXT,
        risk_level           TEXT NOT NULL DEFAULT 'medium',
        status               TEXT NOT NULL DEFAULT 'active',
        version              INTEGER NOT NULL DEFAULT 1,
        source               TEXT NOT NULL DEFAULT 'manual',
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL
      );

      CREATE INDEX idx_contracts_status ON contracts (status);
      CREATE INDEX idx_contracts_updated ON contracts (updated_at DESC);

      CREATE TABLE contract_revisions (
        id           TEXT PRIMARY KEY,
        contract_id  TEXT NOT NULL,
        version      INTEGER NOT NULL,
        snapshot     TEXT NOT NULL,
        change_note  TEXT,
        created_at   TEXT NOT NULL,
        FOREIGN KEY (contract_id) REFERENCES contracts (id) ON DELETE CASCADE
      );

      CREATE INDEX idx_contract_revisions_contract ON contract_revisions (contract_id, version DESC);

      CREATE TABLE executions (
        id              TEXT PRIMARY KEY,
        contract_id     TEXT,
        scenario_id     TEXT,
        status          TEXT NOT NULL,
        verdict         TEXT,
        url             TEXT,
        goal            TEXT,
        requirement     TEXT,
        expected_outcome TEXT,
        checks          TEXT,
        spec            TEXT,
        error           TEXT,
        record          TEXT,
        verification    TEXT,
        events          TEXT,
        root_cause      TEXT,
        created_at      TEXT NOT NULL,
        finished_at     TEXT,
        updated_at      TEXT NOT NULL
      );

      CREATE INDEX idx_executions_created ON executions (created_at DESC);
      CREATE INDEX idx_executions_status ON executions (status);
      CREATE INDEX idx_executions_contract ON executions (contract_id);
      CREATE INDEX idx_executions_verdict ON executions (verdict);

      CREATE TABLE audit_log (
        id          INTEGER PRIMARY KEY,
        ts          TEXT NOT NULL,
        actor       TEXT NOT NULL,
        action      TEXT NOT NULL,
        entity_type TEXT,
        entity_id   TEXT,
        details     TEXT
      );

      CREATE INDEX idx_audit_ts ON audit_log (ts DESC);
      CREATE INDEX idx_audit_entity ON audit_log (entity_type, entity_id);
    `,
  },
];
