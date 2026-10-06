'use strict';
// Initial admin credentials of portals created by the console.
//
// The console *chooses* the first-access password when it creates a portal and hands it to the
// gestionale's create_app (ZDT_APP_ADMIN_PASSWORD). It is stored encrypted (AES-256-GCM), never
// written into task payloads or messages, and shown only to console admins, only if create_app
// confirmed it applied it. The key comes from CREDENTIALS_KEY (deploy/.env, outside the database);
// without it a key is derived from the session secret.

const crypto = require('node:crypto');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS app_credentials (
  app_id      INTEGER PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  username    TEXT,
  ciphertext  TEXT NOT NULL,
  iv          TEXT NOT NULL,
  tag         TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',   -- pending | applied | unsupported
  created_at  INTEGER NOT NULL,
  revealed_at INTEGER,
  revealed_by TEXT
);
`;

// Unambiguous characters (no 0/O, 1/l/I): the password is read and typed by a person.
const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generatePassword(length = 16) {
  const out = [];
  while (out.length < length) {
    for (const b of crypto.randomBytes(length * 2)) {
      if (b < 256 - (256 % ALPHABET.length) && out.length < length) out.push(ALPHABET[b % ALPHABET.length]);
    }
  }
  return out.join('');
}

function keyFrom(env, fallbackSecret) {
  const raw = (env || '').trim();
  if (raw) {
    const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : crypto.createHash('sha256').update(raw).digest();
    return buf;
  }
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(fallbackSecret), Buffer.alloc(0), 'zdt-app-credentials', 32));
}

class Credentials {
  constructor(db, key) {
    this.db = db;
    this.key = key;
    db.exec(SCHEMA);
  }

  encrypt(text) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([c.update(text, 'utf8'), c.final()]);
    return { ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64') };
  }

  decrypt(row) {
    const d = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(row.iv, 'base64'));
    d.setAuthTag(Buffer.from(row.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(row.ciphertext, 'base64')), d.final()]).toString('utf8');
  }

  /** New random initial password for an app; returns nothing (the plaintext only leaves via take/reveal). */
  create(appId, username, now) {
    const enc = this.encrypt(generatePassword());
    this.db
      .prepare('INSERT OR REPLACE INTO app_credentials (app_id, username, ciphertext, iv, tag, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(appId, username || null, enc.ciphertext, enc.iv, enc.tag, 'pending', now);
  }

  /** Plaintext for the create_app delivery, only while the portal has not been created yet. */
  forProvisioning(appId) {
    const row = this.db.prepare("SELECT * FROM app_credentials WHERE app_id = ? AND status = 'pending'").get(appId);
    return row ? this.decrypt(row) : null;
  }

  setStatus(appId, status) {
    this.db.prepare('UPDATE app_credentials SET status = ? WHERE app_id = ?').run(status, appId);
  }

  status(appId) {
    const row = this.db.prepare('SELECT status, username, revealed_at, revealed_by FROM app_credentials WHERE app_id = ?').get(appId);
    return row || null;
  }

  /** Admin view: plaintext only when create_app confirmed it used this password. Records who looked. */
  reveal(appId, who, now) {
    const row = this.db.prepare('SELECT * FROM app_credentials WHERE app_id = ?').get(appId);
    if (!row) return null;
    if (row.status !== 'applied') return { status: row.status, username: row.username };
    this.db.prepare('UPDATE app_credentials SET revealed_at = ?, revealed_by = ? WHERE app_id = ?').run(now, who, appId);
    return { status: row.status, username: row.username, password: this.decrypt(row) };
  }
}

module.exports = { Credentials, keyFrom, generatePassword };
