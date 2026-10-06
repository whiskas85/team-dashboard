'use strict';
// Users, password hashing (scrypt) and stateless signed sessions.

const crypto = require('node:crypto');

const ROLES = ['admin', 'viewer'];
const USERNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._@-]{1,62}$/;
const MIN_PASSWORD = 8;

const USERS_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash   TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'viewer',
  session_ver INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  last_login  INTEGER
);
`;

const now = () => Math.floor(Date.now() / 1000);

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [algo, saltHex, hashHex] = String(stored || '').split('$');
  if (algo !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(actual, expected);
}

function validateUsername(u) {
  if (!USERNAME_RE.test(String(u || ''))) return 'Nome utente non valido (2-63 caratteri: lettere, numeri, . _ @ -)';
  return null;
}
function validatePassword(p) {
  if (String(p || '').length < MIN_PASSWORD) return `La password deve avere almeno ${MIN_PASSWORD} caratteri`;
  return null;
}

class Users {
  constructor(db) {
    this.db = db;
    db.exec(USERS_SCHEMA);
  }

  count() {
    return this.db.prepare('SELECT COUNT(*) n FROM users').get().n;
  }
  adminCount() {
    return this.db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin'").get().n;
  }
  get(id) {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
  }
  byName(username) {
    return this.db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '')) || null;
  }
  list() {
    return this.db.prepare('SELECT id, username, role, created_at, last_login FROM users ORDER BY username').all();
  }

  create(username, password, role = 'viewer') {
    const err = validateUsername(username) || validatePassword(password);
    if (err) throw Object.assign(new Error(err), { status: 400 });
    if (!ROLES.includes(role)) throw Object.assign(new Error('Ruolo non valido'), { status: 400 });
    if (this.byName(username)) throw Object.assign(new Error('Nome utente già in uso'), { status: 409 });
    const r = this.db.prepare('INSERT INTO users (username, pass_hash, role, created_at) VALUES (?, ?, ?, ?)').run(username, hashPassword(password), role, now());
    return this.get(Number(r.lastInsertRowid));
  }

  // Any password change or role change bumps session_ver, which logs out every open session of that user.
  update(id, { username, password, role } = {}) {
    const user = this.get(id);
    if (!user) throw Object.assign(new Error('Utente non trovato'), { status: 404 });
    if (username !== undefined && username !== user.username) {
      const err = validateUsername(username);
      if (err) throw Object.assign(new Error(err), { status: 400 });
      const other = this.byName(username);
      if (other && other.id !== user.id) throw Object.assign(new Error('Nome utente già in uso'), { status: 409 });
      this.db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, id);
    }
    if (role !== undefined && role !== user.role) {
      if (!ROLES.includes(role)) throw Object.assign(new Error('Ruolo non valido'), { status: 400 });
      if (user.role === 'admin' && this.adminCount() <= 1) throw Object.assign(new Error("Deve restare almeno un amministratore"), { status: 400 });
      this.db.prepare('UPDATE users SET role = ?, session_ver = session_ver + 1 WHERE id = ?').run(role, id);
    }
    if (password !== undefined) {
      const err = validatePassword(password);
      if (err) throw Object.assign(new Error(err), { status: 400 });
      this.db.prepare('UPDATE users SET pass_hash = ?, session_ver = session_ver + 1 WHERE id = ?').run(hashPassword(password), id);
    }
    return this.get(id);
  }

  remove(id) {
    const user = this.get(id);
    if (!user) throw Object.assign(new Error('Utente non trovato'), { status: 404 });
    if (user.role === 'admin' && this.adminCount() <= 1) throw Object.assign(new Error("Deve restare almeno un amministratore"), { status: 400 });
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
  }

  authenticate(username, password) {
    const user = this.byName(username);
    // Hash anyway on unknown users so response time does not reveal which usernames exist.
    const ok = verifyPassword(password, user ? user.pass_hash : 'scrypt$00$00');
    if (!user || !ok) return null;
    this.db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(now(), user.id);
    return user;
  }

  // First start: create "admin" with the bootstrap password (ADMIN_PASSWORD), only when no user exists yet.
  bootstrap(password) {
    if (this.count() > 0) return null;
    // Bypasses the length policy on purpose: the bootstrap password comes from the operator's .env.
    const r = this.db.prepare("INSERT INTO users (username, pass_hash, role, created_at) VALUES ('admin', ?, 'admin', ?)").run(hashPassword(password), now());
    return this.get(Number(r.lastInsertRowid));
  }
}

function sessionCookie(secret, user, ttl) {
  const exp = now() + ttl;
  const payload = `${user.id}.${user.session_ver}.${exp}`;
  return `${payload}.${crypto.createHmac('sha256', secret).update(payload).digest('hex')}`;
}

function sessionUser(secret, users, cookie) {
  if (!cookie) return null;
  const parts = cookie.split('.');
  if (parts.length !== 4) return null;
  const [id, ver, exp, sig] = parts;
  if (!(Number(exp) > now())) return null;
  const expected = crypto.createHmac('sha256', secret).update(`${id}.${ver}.${exp}`).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const user = users.get(Number(id));
  return user && String(user.session_ver) === ver ? user : null;
}

const publicUser = (u) => u && { id: u.id, username: u.username, role: u.role, created_at: u.created_at, last_login: u.last_login };

module.exports = { Users, ROLES, hashPassword, verifyPassword, sessionCookie, sessionUser, publicUser, MIN_PASSWORD };
