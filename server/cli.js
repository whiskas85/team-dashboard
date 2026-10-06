'use strict';
// Account recovery and user management from the server shell.
//   docker exec -it zerodark-console-console-1 node server/cli.js reset-password admin
//   node server/cli.js list-users | create-user <name> <admin|viewer> [password] | reset-password <name> [password]

const crypto = require('node:crypto');
const path = require('node:path');
const { open } = require('./db');
const { Users } = require('./auth');

const db = open(process.env.DB_FILE || path.join(__dirname, '..', 'data', 'console.db'));
const users = new Users(db);
const [cmd, ...args] = process.argv.slice(2);
const randomPassword = () => crypto.randomBytes(9).toString('base64url');

function fail(msg) {
  console.error(`Errore: ${msg}`);
  process.exit(1);
}

try {
  switch (cmd) {
    case 'list-users':
      for (const u of users.list()) console.log(`${u.username}\t${u.role}\tultimo accesso: ${u.last_login ? new Date(u.last_login * 1000).toLocaleString('it-IT') : 'mai'}`);
      break;
    case 'reset-password': {
      const [name, pw = randomPassword()] = args;
      const u = users.byName(name);
      if (!u) fail(`utente "${name}" non trovato. Utenti: ${users.list().map((x) => x.username).join(', ') || 'nessuno'}`);
      users.update(u.id, { password: pw });
      console.log(`Nuova password per "${u.username}": ${pw}`);
      console.log('Cambiala da Account dopo l\'accesso.');
      break;
    }
    case 'create-user': {
      const [name, role = 'viewer', pw = randomPassword()] = args;
      const u = users.create(name, pw, role);
      console.log(`Creato "${u.username}" (${u.role}) con password: ${pw}`);
      break;
    }
    default:
      console.log('Uso: node server/cli.js list-users | reset-password <utente> [password] | create-user <utente> <admin|viewer> [password]');
      process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  fail(e.message);
}
