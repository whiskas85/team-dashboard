'use strict';
// Fills the DB with 30 days of realistic demo data (3 servers, 9 apps) to try the console without agents.
//   DB_FILE=./data/demo.db npm run seed

const path = require('node:path');
const crypto = require('node:crypto');
const { open, tx } = require('../server/db');

const file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'console.db');
const days = Number(process.env.SEED_DAYS || 30);
const step = 300;
const db = open(file);

const servers = [
  { name: 'ops-prod-01', cores: 8, mem: 16384, disk: 160, diskUsed: 70, diskGrowth: 0.4, base: { cpu: 0.35, mem: 1800 } },
  { name: 'ops-prod-02', cores: 4, mem: 8192, disk: 80, diskUsed: 58, diskGrowth: 0.55, base: { cpu: 0.25, mem: 1200 } },
  { name: 'ops-prod-03', cores: 4, mem: 8192, disk: 80, diskUsed: 22, diskGrowth: 0.1, base: { cpu: 0.2, mem: 900 } },
];
// cpu in cores at peak, mem in MB; peakHour = local hour of maximum load
const apps = [
  { server: 0, name: 'ops-acme', cpu: 1.6, mem: 2600, peakHour: 10, growth: 6 },
  { server: 0, name: 'ops-globex', cpu: 1.1, mem: 1900, peakHour: 15, growth: 2 },
  { server: 0, name: 'ops-initech', cpu: 0.6, mem: 1200, peakHour: 11, growth: 0 },
  { server: 1, name: 'ops-umbrella', cpu: 1.5, mem: 2300, peakHour: 10, growth: 9 },
  { server: 1, name: 'ops-hooli', cpu: 1.2, mem: 2100, peakHour: 11, growth: 5 },
  { server: 1, name: 'ops-batch', cpu: 0.9, mem: 900, peakHour: 2, growth: 0 },
  { server: 2, name: 'ops-wayne', cpu: 0.5, mem: 900, peakHour: 16, growth: 1 },
  { server: 2, name: 'ops-stark', cpu: 0.4, mem: 700, peakHour: 9, growth: 0 },
  { server: 2, name: 'reporting', cpu: 0.7, mem: 600, peakHour: 3, growth: 0 },
];

let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const noise = (a) => (rnd() - 0.5) * 2 * a;

function shape(ts, peakHour) {
  const d = new Date(ts * 1000);
  const h = d.getHours() + d.getMinutes() / 60;
  const dist = Math.min(Math.abs(h - peakHour), 24 - Math.abs(h - peakHour));
  const weekend = d.getDay() === 0 || d.getDay() === 6;
  const daily = Math.exp(-(dist * dist) / 8);
  return (0.15 + 0.85 * daily) * (weekend && peakHour > 6 && peakHour < 20 ? 0.45 : 1);
}

const now = Math.floor(Date.now() / 1000 / step) * step;
const from = now - days * 86400;

tx(db, () => {
  db.exec('DELETE FROM app_metrics; DELETE FROM server_metrics; DELETE FROM tasks; DELETE FROM apps; DELETE FROM servers;');
  const insS = db.prepare('INSERT INTO servers (name, token_hash, hostname, os, agent_version, cpu_cores, mem_total_mb, disk_total_gb, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  servers.forEach((s) => {
    s.id = Number(insS.run(s.name, crypto.randomBytes(16).toString('hex'), `${s.name}.zerodarkteam.it`, 'Ubuntu 24.04 LTS', 'demo', s.cores, s.mem, s.disk, from, now).lastInsertRowid);
  });
  const insA = db.prepare("INSERT INTO apps (server_id, name, type, kind, match, domain, status, created_at, last_seen) VALUES (?, ?, 'portal', 'docker', ?, ?, 'active', ?, ?)");
  apps.forEach((a) => {
    a.id = Number(insA.run(servers[a.server].id, a.name, `^${a.name}-`, `${a.name.replace('ops-', '')}.zerodarkteam.it`, from, now).lastInsertRowid);
  });

  const insSM = db.prepare('INSERT INTO server_metrics (server_id, ts, cpu_pct, load1, load5, load15, mem_used_mb, mem_total_mb, swap_used_mb, disk_used_gb, disk_total_gb, net_rx_bps, net_tx_bps, procs, uptime_s) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insAM = db.prepare('INSERT INTO app_metrics (app_id, server_id, ts, cpu_pct, mem_mb, procs) VALUES (?, ?, ?, ?, ?, ?)');
  for (let ts = from; ts <= now; ts += step) {
    const dayN = (ts - from) / 86400;
    const totals = servers.map((s) => ({ cpu: s.base.cpu + Math.abs(noise(0.1)), mem: s.base.mem + noise(60) }));
    for (const a of apps) {
      const k = shape(ts, a.peakHour);
      const cpu = Math.max(0.01, a.cpu * k + noise(a.cpu * 0.12));
      const mem = a.mem * (0.6 + 0.4 * k) + a.growth * dayN + noise(a.mem * 0.03);
      totals[a.server].cpu += cpu;
      totals[a.server].mem += mem;
      insAM.run(a.id, servers[a.server].id, ts, cpu * 100, mem, 4);
    }
    servers.forEach((s, i) => {
      const t = totals[i];
      const cpuPct = Math.min(100, (t.cpu / s.cores) * 100);
      const mem = Math.min(s.mem * 0.98, t.mem);
      const swap = t.mem > s.mem * 0.95 ? (t.mem - s.mem * 0.95) * 0.5 : 0;
      insSM.run(s.id, ts, cpuPct, t.cpu * 1.1, t.cpu, t.cpu * 0.9, mem, s.mem, swap, s.diskUsed + s.diskGrowth * dayN + noise(0.05), s.disk,
        2e5 + t.cpu * 4e5 + noise(5e4), 8e5 + t.cpu * 1.5e6 + noise(1e5), 180 + Math.round(t.cpu * 10), Math.round(ts - from + 86400 * 12));
    });
  }
});
console.log(`Demo: ${servers.length} server, ${apps.length} app, ${days} giorni di metriche ogni ${step / 60} min -> ${file}`);
