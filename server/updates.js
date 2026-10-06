'use strict';
// Versions and updates of the gestionale squads (deploy/console-hooks in whiskas85/team-management).
//
// The gestionale does the risky part on the server (backup, switch, check, automatic roll back):
//   list_versions  -> {"available":["3.25.0","3.24.0"],"latest":"3.25.0","current":"3.24.0"}
//   update_app     -> {"version":"3.25.0","previous":"3.24.0"}                       (exit 0)
//                     {"version":"3.24.0","attempted":"3.25.0","rolled_back":true}   (exit 1)
// The console decides what and when: which version, manual or nightly, one update at a time
// per server, and never retrying automatically a version that already had to be rolled back.

const VERSION_RE = /^\d+\.\d+\.\d+$/;
const isVersion = (v) => typeof v === 'string' && VERSION_RE.test(v);

function cmpVersion(a, b) {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}

// Squads only: production (ops) and test environments follow their own release.
const SQUAD_SQL = "a.type = 'portal' AND a.provisioned = 1 AND a.status = 'active'";
const PENDING = "status IN ('queued', 'sent')";

function serverVersions(server) {
  let v = null;
  try { v = server && server.versions ? JSON.parse(server.versions) : null; } catch { v = null; }
  return {
    available: (v && Array.isArray(v.available) ? v.available.filter(isVersion) : []).sort((a, b) => cmpVersion(b, a)),
    latest: v && isVersion(v.latest) ? v.latest : null,
    at: server ? server.versions_at || null : null,
    error: server ? server.versions_error || null : null,
  };
}

class Updates {
  constructor(db, { now, tx, interval = 3600, hour = 4, timeZone = 'Europe/Rome' }) {
    Object.assign(this, { db, now, tx, interval, hour, timeZone });
  }

  queue(app, action, payload) {
    const t = this.now();
    return this.db
      .prepare("INSERT INTO tasks (server_id, app_id, action, payload, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)")
      .run(app.server_id, app.id ?? null, action, JSON.stringify(payload), t, t).lastInsertRowid;
  }

  pending(appId) {
    return this.db.prepare(`SELECT id, payload, status FROM tasks WHERE app_id = ? AND action = 'update_app' AND ${PENDING} ORDER BY id DESC LIMIT 1`).get(appId);
  }

  /** Ask the server which versions it has (and, for a named app, which one it runs). */
  refresh(serverId, { force = false } = {}) {
    const s = this.db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
    if (!s) return false;
    const squads = this.db.prepare(`SELECT a.* FROM apps a WHERE a.server_id = ? AND ${SQUAD_SQL}`).all(serverId);
    if (!squads.length && !force) return false;
    const busy = this.db.prepare(`SELECT 1 FROM tasks WHERE server_id = ? AND action = 'list_versions' AND ${PENDING}`).get(serverId);
    if (busy) return true;
    if (!force && s.versions_at && s.versions_at > this.now() - this.interval) return false;
    this.tx(this.db, () => {
      this.db.prepare('UPDATE servers SET versions_at = ? WHERE id = ?').run(this.now(), serverId); // also when it fails: no retry storm
      this.queue({ server_id: serverId }, 'list_versions', {});
      // squads still running a gestionale without /api/stato: ask the server which version they run
      for (const a of squads.filter((x) => !x.version)) this.queue(a, 'list_versions', { name: a.name });
    });
    return true;
  }

  refreshAll() {
    for (const { id } of this.db.prepare('SELECT id FROM servers').all()) this.refresh(id);
  }

  /** Manual or automatic update of one squad. Throws a message for the user when it cannot. */
  request(appId, version, { by, auto = false } = {}) {
    const a = this.db.prepare('SELECT a.* FROM apps a WHERE a.id = ?').get(appId);
    if (!a) throw new Error('App non trovata');
    if (!(a.type === 'portal' && a.provisioned && a.status === 'active')) throw new Error('Si aggiornano solo i gestionali delle squadre, attivi');
    if (!isVersion(version)) throw new Error('Versione non valida (es. 3.25.0)');
    if (this.pending(a.id)) throw new Error('Un aggiornamento è già in corso');
    const id = this.queue(a, 'update_app', { name: a.name, domain: a.domain, version, from: a.version || null, by: by || null, auto: !!auto });
    return { id, status: 'queued', version };
  }

  /** Squads behind the latest version of their server. */
  behind(serverId) {
    const s = serverVersions(this.db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId));
    if (!s.latest) return [];
    return this.db
      .prepare(`SELECT a.* FROM apps a WHERE a.server_id = ? AND ${SQUAD_SQL}`)
      .all(serverId)
      .filter((a) => a.version && cmpVersion(a.version, s.latest) < 0)
      .map((a) => ({ app: a, latest: s.latest }));
  }

  /** A version that already failed (rolled back) for this app is not retried automatically. */
  failedBefore(appId, version) {
    return this.db
      .prepare("SELECT payload FROM tasks WHERE app_id = ? AND action = 'update_app' AND status = 'failed' ORDER BY id DESC LIMIT 20")
      .all(appId)
      .some((t) => JSON.parse(t.payload).version === version);
  }

  localHour(date = new Date()) {
    return Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: this.timeZone }).format(date));
  }

  /** Nightly: squads with automatic updates move to the latest version, at `hour` local time. */
  autoUpdate(date = new Date()) {
    if (this.localHour(date) !== this.hour) return [];
    const queued = [];
    for (const { id } of this.db.prepare('SELECT id FROM servers').all()) {
      for (const { app, latest } of this.behind(id)) {
        if (!app.auto_update || this.pending(app.id) || this.failedBefore(app.id, latest)) continue;
        const recent = this.db.prepare("SELECT 1 FROM tasks WHERE app_id = ? AND action = 'update_app' AND created_at > ?").get(app.id, this.now() - 20 * 3600);
        if (recent) continue;
        this.request(app.id, latest, { by: 'automatico', auto: true });
        queued.push(app.name);
      }
    }
    return queued;
  }

  /** Task results from the agent. */
  ack(task, ok, result, message) {
    const payload = JSON.parse(task.payload || '{}');
    const t = this.now();
    if (task.action === 'list_versions') {
      if (result && Array.isArray(result.available)) {
        const versions = { available: result.available.filter(isVersion), latest: isVersion(result.latest) ? result.latest : null };
        this.db.prepare('UPDATE servers SET versions = ?, versions_at = ?, versions_error = NULL WHERE id = ?').run(JSON.stringify(versions), t, task.server_id);
      } else if (!ok) {
        this.db.prepare('UPDATE servers SET versions_error = ? WHERE id = ?').run((message || 'errore').slice(-300), task.server_id);
      }
      if (task.app_id && result && isVersion(result.current)) this.setVersion(task.app_id, result.current);
    } else if (task.action === 'update_app' && task.app_id) {
      // after a roll back "version" is the one running again: always the truth
      if (result && isVersion(result.version)) this.setVersion(task.app_id, result.version);
      return { version: result && result.version, rolled_back: !!(result && result.rolled_back), attempted: payload.version };
    }
    return null;
  }

  setVersion(appId, version) {
    this.db.prepare('UPDATE apps SET version = ?, version_at = ? WHERE id = ?').run(version, this.now(), appId);
    // A portal running something newer than the server's "latest" (typically production just
    // released): the list is stale, ask again now instead of waiting for the next round.
    const app = this.db.prepare('SELECT server_id FROM apps WHERE id = ?').get(appId);
    const s = app && this.db.prepare('SELECT * FROM servers WHERE id = ?').get(app.server_id);
    if (!s) return;
    const v = serverVersions(s);
    const stale = !v.latest || cmpVersion(version, v.latest) > 0;
    if (stale && (!s.versions_at || s.versions_at < this.now() - 600)) this.refresh(s.id, { force: true });
  }

  /** For the UI: running update, last result and newest version available on the server. */
  decorate(app, server) {
    if (!(app.type === 'portal' && app.provisioned)) return null;
    const v = serverVersions(server);
    const pending = this.pending(app.id);
    const last = this.db
      .prepare("SELECT id, payload, status, message, result, updated_at FROM tasks WHERE app_id = ? AND action = 'update_app' AND status IN ('done', 'failed') ORDER BY id DESC LIMIT 1")
      .get(app.id);
    const lastResult = last && last.result ? JSON.parse(last.result) : null;
    return {
      latest: v.latest,
      checked_at: v.at,
      behind: !!(v.latest && app.version && cmpVersion(app.version, v.latest) < 0),
      auto: !!app.auto_update,
      running: pending ? { version: JSON.parse(pending.payload).version, status: pending.status } : null,
      last: last && {
        version: JSON.parse(last.payload).version,
        ok: last.status === 'done',
        rolled_back: !!(lastResult && lastResult.rolled_back),
        at: last.updated_at,
        message: last.status === 'done' ? null : (last.message || '').slice(-300),
      },
    };
  }

  history(appId, limit = 10) {
    return this.db
      .prepare("SELECT id, payload, status, message, result, created_at, updated_at FROM tasks WHERE app_id = ? AND action = 'update_app' ORDER BY id DESC LIMIT ?")
      .all(appId, limit)
      .map((t) => {
        const p = JSON.parse(t.payload);
        const r = t.result ? JSON.parse(t.result) : null;
        return {
          id: t.id, version: p.version, from: (r && r.previous) || p.from || null, by: p.by, auto: !!p.auto, status: t.status,
          rolled_back: !!(r && r.rolled_back), created_at: t.created_at, finished_at: ['done', 'failed'].includes(t.status) ? t.updated_at : null,
          message: t.status === 'failed' ? (t.message || '').slice(-600) : null,
        };
      });
  }
}

module.exports = { Updates, cmpVersion, isVersion, serverVersions };
