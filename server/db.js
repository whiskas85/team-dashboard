'use strict';
// Storage layer: SQLite (node:sqlite, built into Node >= 22.13) with rolling retention.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS servers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE,
  token_hash    TEXT NOT NULL,
  hostname      TEXT,
  os            TEXT,
  agent_version TEXT,
  cpu_cores     REAL,
  mem_total_mb  REAL,
  disk_total_gb REAL,
  notes         TEXT,
  created_at    INTEGER NOT NULL,
  last_seen     INTEGER
);

CREATE TABLE IF NOT EXISTS apps (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'portal',     -- portal | service | other
  kind        TEXT NOT NULL DEFAULT 'process',    -- process | docker | systemd
  match       TEXT,                               -- process regex / container name / unit
  domain      TEXT,
  port        INTEGER,
  template    TEXT,
  status      TEXT NOT NULL DEFAULT 'active',     -- pending | provisioning | active | error | removing
  status_msg  TEXT,
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER,
  UNIQUE(server_id, name)
);

CREATE TABLE IF NOT EXISTS server_metrics (
  server_id     INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  ts            INTEGER NOT NULL,
  cpu_pct       REAL,
  load1         REAL,
  load5         REAL,
  load15        REAL,
  mem_used_mb   REAL,
  mem_total_mb  REAL,
  swap_used_mb  REAL,
  disk_used_gb  REAL,
  disk_total_gb REAL,
  net_rx_bps    REAL,
  net_tx_bps    REAL,
  procs         INTEGER,
  uptime_s      INTEGER,
  extra         TEXT
);
CREATE INDEX IF NOT EXISTS ix_server_metrics ON server_metrics(server_id, ts);
CREATE INDEX IF NOT EXISTS ix_server_metrics_ts ON server_metrics(ts);

CREATE TABLE IF NOT EXISTS app_metrics (
  app_id    INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  server_id INTEGER NOT NULL,
  ts        INTEGER NOT NULL,
  cpu_pct   REAL,      -- percent of ONE core (150 = 1.5 cores)
  mem_mb    REAL,
  procs     INTEGER
);
CREATE INDEX IF NOT EXISTS ix_app_metrics ON app_metrics(app_id, ts);
CREATE INDEX IF NOT EXISTS ix_app_metrics_ts ON app_metrics(ts);

CREATE TABLE IF NOT EXISTS tasks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id  INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  app_id     INTEGER,
  action     TEXT NOT NULL,                        -- create_app | remove_app | purge_app | set_admin_password | update_app | list_versions
  payload    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'queued',       -- queued | sent | done | failed
  message    TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_tasks ON tasks(server_id, status);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// Columns added after the first release: existing databases get them on startup.
const MIGRATIONS = [
  ['apps', 'health', 'TEXT'],        // ok | down
  ['apps', 'health_code', 'INTEGER'], // HTTP status (0 = unreachable)
  ['apps', 'health_at', 'INTEGER'],
  ['apps', 'health_error', 'TEXT'],   // short human-readable reason when down
  ['apps', 'provisioned', 'INTEGER NOT NULL DEFAULT 0'], // 1 = created on the server by the console
  ['apps', 'archived_at', 'INTEGER'],  // set when remove_app moved the portal to the archive
  ['apps', 'archived_by', 'TEXT'],
  ['apps', 'archive_path', 'TEXT'],    // e.g. /opt/archivio/squadra-demo-20261006120000
  ['apps', 'version', 'TEXT'],         // gestionale version running (from /api/stato or the hooks)
  ['apps', 'version_at', 'INTEGER'],
  ['apps', 'auto_update', 'INTEGER NOT NULL DEFAULT 0'], // 1 = nightly update to the latest version
  ['servers', 'versions', 'TEXT'],     // JSON {available, latest} from the list_versions hook
  ['servers', 'versions_at', 'INTEGER'],
  ['servers', 'versions_error', 'TEXT'],
  ['tasks', 'result', 'TEXT'],         // JSON of the hook's last output line
];

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  for (const [table, col, type] of MIGRATIONS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
  // Apps the console provisioned before the flag existed
  db.exec("UPDATE apps SET provisioned = 1 WHERE provisioned = 0 AND id IN (SELECT app_id FROM tasks WHERE action = 'create_app')");
  markSquadPortals(db);
  return db;
}

// Gestionale squads (deploy/squadra-server.sh) are the only portals the console may archive:
// containers zd-sq-<name>-*, and never the reserved names (production ops, test*, www).
// Covers squads registered by hand instead of created from the console.
function markSquadPortals(db) {
  db.exec(`UPDATE apps SET provisioned = 1
           WHERE provisioned = 0 AND type = 'portal' AND kind = 'docker'
             AND match = '^zd-sq-' || name || '-'
             AND name NOT IN ('ops', 'www') AND name NOT LIKE 'test%'
             AND name GLOB '[a-z0-9]*' AND name NOT GLOB '*[^a-z0-9-]*'`);
}

// From gestionale 3.29.0 our own gestionale (ops.zerodarkteam.it) is a hosted squad like the others,
// "zerodark" (containers zd-sq-zerodark-*), and every squad's database lives in the shared Postgres
// zd-sq-pg. The old production app (zd-app/zd-db, often declared in the agent's local config) is
// kept but no longer monitored, so its history stays reachable from the Archive.
function adoptOwnSquad(db, { name = 'zerodark', domain = 'ops.zerodarkteam.it', now = Math.floor(Date.now() / 1000) } = {}) {
  const match = `^zd-sq-${name}-`;
  const old = db
    .prepare("SELECT * FROM apps WHERE domain = ? AND name != ? AND (match IS NULL OR match NOT LIKE '^zd-sq-%') AND status NOT IN ('archived', 'purging', 'unmonitored')")
    .all(domain, name);
  for (const o of old) {
    if (!db.prepare('SELECT 1 FROM apps WHERE server_id = ? AND name = ?').get(o.server_id, name)) {
      db.prepare("INSERT INTO apps (server_id, name, type, kind, match, domain, status, provisioned, created_at) VALUES (?, ?, 'portal', 'docker', ?, ?, 'active', 1, ?)")
        .run(o.server_id, name, match, domain, now);
    }
    db.prepare("UPDATE apps SET status = 'unmonitored', archived_at = ?, archived_by = 'console', status_msg = ? WHERE id = ?")
      .run(now, `Sostituita da «${name}»: dal gestionale 3.29.0 la produzione è un gestionale ospitato (zd-sq-${name}-*)`, o.id);
  }
  // The shared Postgres of the squads, wherever squads run
  const servers = db.prepare("SELECT DISTINCT server_id FROM apps WHERE match LIKE '^zd-sq-%' AND status NOT IN ('archived', 'purging')").all();
  for (const { server_id: sid } of servers) {
    if (db.prepare("SELECT 1 FROM apps WHERE server_id = ? AND (match = '^zd-sq-pg$' OR name = 'postgres-squadre')").get(sid)) continue;
    db.prepare("INSERT INTO apps (server_id, name, type, kind, match, status, created_at) VALUES (?, 'postgres-squadre', 'service', 'docker', '^zd-sq-pg$', 'active', ?)").run(sid, now);
  }
  return old.length;
}

// Rolling window: everything older than `days` is dropped, so the DB never grows past the window.
function purge(db, days, now = Date.now()) {
  const cutoff = Math.floor(now / 1000) - Math.round(days * 86400);
  const a = db.prepare('DELETE FROM server_metrics WHERE ts < ?').run(cutoff).changes;
  const b = db.prepare('DELETE FROM app_metrics WHERE ts < ?').run(cutoff).changes;
  const c = db.prepare("DELETE FROM tasks WHERE status IN ('done','failed') AND updated_at < ?").run(cutoff).changes;
  return { server_metrics: a, app_metrics: b, tasks: c };
}

function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { open, purge, tx, markSquadPortals, adoptOwnSquad };
