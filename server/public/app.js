/* global lineChart, fmt */
'use strict';

const $app = document.getElementById('app');
const state = { me: null, range: '24h', days: 30, headroom: 80, n: 5, selectedApp: null, timer: null };
const C = { s1: 'var(--s1)', s2: 'var(--s2)', s3: 'var(--s3)', s4: 'var(--s4)' };

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/api/login')) {
    state.me = { authenticated: false };
    renderLogin();
    throw new Error('Sessione scaduta');
  }
  if (!res.ok) throw new Error(data.error || `Errore ${res.status}`);
  return data;
}

function ago(ts) {
  if (!ts) return 'mai';
  const s = Math.floor(Date.now() / 1000) - ts;
  if (s < 60) return `${s}s fa`;
  if (s < 3600) return `${Math.floor(s / 60)} min fa`;
  if (s < 86400) return `${Math.floor(s / 3600)} h fa`;
  return `${Math.floor(s / 86400)} g fa`;
}

const STATUS_LABEL = {
  ok: 'OK', info: 'Info', warning: 'Attenzione', critical: 'Critico', offline: 'Offline', online: 'Online',
  active: 'Attiva', pending: 'In coda', provisioning: 'In creazione', error: 'Errore', removing: 'In rimozione',
  queued: 'In coda', sent: 'Inviato', done: 'Completato', failed: 'Fallito', archived: 'Archiviata', purging: 'In eliminazione', unmonitored: 'Non monitorata',
};
const badge = (st, label) => `<span class="badge st-${esc(st)}"><i class="dot"></i>${esc(label || STATUS_LABEL[st] || st)}</span>`;

function meter(label, value, max, format, opts = {}) {
  const pct = max ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  const cls = pct >= (opts.crit ?? 90) ? 'crit' : pct >= (opts.warn ?? 75) ? 'warn' : '';
  const right = value == null ? '–' : `<b>${format(value)}</b>${max && !opts.hideMax ? ` / ${format(max)}` : ''}`;
  const mark = opts.mark != null ? `<i class="mark" style="left:${opts.mark}%"></i>` : '';
  return `<div><div class="meter-label"><span>${esc(label)}</span><span class="num">${right}</span></div>
    <div class="meter ${cls}" role="meter" aria-label="${esc(label)}" aria-valuenow="${Math.round(pct)}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span>${mark}</div></div>`;
}

function modal(html, onMount) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  const close = () => bg.remove();
  bg.addEventListener('click', (e) => e.target === bg && close());
  bg.addEventListener('keydown', (e) => e.key === 'Escape' && close());
  document.body.appendChild(bg);
  bg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  const first = bg.querySelector('input, select, button');
  if (first) first.focus();
  onMount && onMount(bg.querySelector('.modal'), close);
  return close;
}

function shell(active, content) {
  $app.innerHTML = `
    <header class="topbar">
      <a class="brand" href="#/"><span class="logo">Z</span><span>ZeroDark Console</span></a>
      ${versionBadge()}
      <nav class="nav">
        <a href="#/" class="${active === 'servers' ? 'active' : ''}">Dashboard</a>
        <a href="#/analysis" class="${active === 'analysis' ? 'active' : ''}">Capacità & combinazioni</a>
        ${isAdmin() ? `<a href="#/users" class="${active === 'users' ? 'active' : ''}">Utenti</a>` : ''}
      </nav>
      <div class="spacer"></div>
      <a class="user-chip ${active === 'account' ? 'active' : ''}" href="#/account" title="Il mio account"><span class="avatar" aria-hidden="true">${esc((state.me.user?.username || '?')[0].toUpperCase())}</span><span class="uname">${esc(state.me.user?.username || '')}</span></a>
      <button class="small" id="theme" title="Tema chiaro/scuro" aria-label="Cambia tema">◐</button>
      <button class="small" id="logout">Esci</button>
    </header>
    <main id="main">${content}</main>`;
  document.body.classList.toggle('role-viewer', !isAdmin());
  document.getElementById('logout').onclick = async () => {
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    state.me = { authenticated: false };
    renderLogin();
  };
  document.getElementById('theme').onclick = () => {
    const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('zdt-theme', next); } catch { /* ignore */ }
    route();
  };
  return document.getElementById('main');
}

const isAdmin = () => state.me?.user?.role === 'admin';

// "v0.2.0 · 4aafec6": version + deployed commit, links to the commit on GitHub.
function versionBadge() {
  const b = state.me?.build || { version: state.me?.version };
  if (!b.version) return '';
  const sha = b.commit ? b.commit.slice(0, 7) : 'manuale';
  const when = b.built_at ? new Date(b.built_at).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : null;
  const title = [`Versione ${b.version}`, b.commit ? `commit ${b.commit}` : 'installazione manuale', when && `rilasciata il ${when}`, b.run && `deploy #${b.run}`].filter(Boolean).join(' · ');
  const inner = `<span class="v">v${esc(b.version)}</span><span class="sha">${esc(sha)}</span>`;
  return b.commit && b.repo
    ? `<a class="version-badge" href="https://github.com/${esc(b.repo)}/commit/${esc(b.commit)}" target="_blank" rel="noopener" title="${esc(title)}">${inner}</a>`
    : `<span class="version-badge" title="${esc(title)}">${inner}</span>`;
}

// Auto-refresh every `ms`; while `fast()` is true (an app is being archived, deleted or created by
// the agent) refresh every few seconds, so the change shows up without reloading the page.
const BUSY = ['pending', 'provisioning', 'removing', 'purging'];
const anyBusy = (apps) => apps.some((a) => BUSY.includes(a.status));
function setRefresh(fn, ms = 60000, fast = null) {
  clearInterval(state.timer);
  if (!fn) { state.timer = null; return; }
  let last = Date.now();
  let running = false;
  state.timer = setInterval(async () => {
    if (running || document.visibilityState !== 'visible') return;
    if (Date.now() - last < ms && !(fast && fast())) return;
    running = true;
    last = Date.now();
    try { await fn(); } catch { /* next tick retries */ } finally { running = false; }
  }, 3000);
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------
function renderLogin() {
  setRefresh(null);
  $app.innerHTML = `
    <div class="login"><form class="card" id="login">
      <div class="brand" style="margin-bottom:18px"><span class="logo">Z</span><span>ZeroDark Console</span></div>
      <h1>Accedi</h1><p class="muted" style="margin:4px 0 18px">Monitoraggio server e capacità</p>
      <div class="field"><label for="un">Nome utente</label><input id="un" autocomplete="username" required value="admin"></div>
      <div class="field"><label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" required></div>
      <button class="primary" style="width:100%;justify-content:center">Entra</button>
      <div class="err" id="err"></div>
      <div style="margin-top:14px;display:flex;justify-content:center">${versionBadge()}</div>
    </form></div>`;
  document.getElementById('pw').focus();
  document.getElementById('login').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/api/login', { method: 'POST', body: { username: document.getElementById('un').value.trim(), password: document.getElementById('pw').value } });
      state.me = await api('/api/me');
      route();
    } catch (err) {
      document.getElementById('err').textContent = err.message;
    }
  };
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------
const VERDICT = {
  ok: ['✓', 'Distribuzione adeguata'],
  optimize: ['↻', 'Ottimizzazione possibile'],
  rebalance: ['⚠', 'Ribilanciamento consigliato'],
  expand: ['⬆', 'Serve allargare il servizio'],
  no_data: ['…', 'In attesa di dati'],
};

async function renderOverview() {
  const main = shell('servers', '<div class="loading">Caricamento…</div>');
  const load = async () => {
    const [servers, analysis] = await Promise.all([api('/api/servers'), api('/api/analysis?days=7&n=1').catch(() => null)]);
    const statusOf = Object.fromEntries((analysis?.servers || []).map((s) => [s.id, s]));
    const v = analysis && VERDICT[analysis.fleet.verdict];
    main.innerHTML = `
      ${homeTabs('overview')}
      <div class="page-head">
        <div><h1>Server</h1><p>${servers.length} server monitorati · aggiornamento automatico ogni minuto</p></div>
        <button class="primary admin-only" id="add">+ Aggiungi server</button>
      </div>
      ${v ? `<div class="banner"><div class="icon" aria-hidden="true">${v[0]}</div><div><b>${v[1]}</b> <span class="muted">(ultimi 7 giorni)</span>
        <p>${analysis.fleet.advice.map(esc).join(' ')} <a href="#/analysis">Vedi analisi →</a></p></div></div>` : ''}
      ${servers.length ? `<div class="grid cards">${servers.map((s) => serverCard(s, statusOf[s.id])).join('')}</div>`
        : `<div class="card empty-state"><h2>Nessun server</h2><p>Aggiungi il primo server e installa l'agent con un solo comando.</p><button class="primary admin-only" id="add2">+ Aggiungi server</button></div>`}`;
    main.querySelectorAll('[data-server]').forEach((c) => {
      c.onclick = () => (location.hash = `#/server/${c.dataset.server}`);
      c.onkeydown = (e) => e.key === 'Enter' && c.click();
    });
    for (const id of ['add', 'add2']) { const b = document.getElementById(id); if (b) b.onclick = () => addServerModal(load); }
  };
  await load();
  setRefresh(load);
}

function serverCard(s, report) {
  const m = s.latest || {};
  const st = !s.online ? 'offline' : report?.status || 'ok';
  const memMax = m.mem_total_mb || s.mem_total_mb;
  const diskMax = m.disk_total_gb || s.disk_total_gb;
  return `<div class="card server-card" data-server="${s.id}" tabindex="0" role="link" aria-label="Apri ${esc(s.name)}">
    <div class="card-head"><div><h2>${esc(s.name)}</h2><div class="muted" style="font-size:12px">${esc(s.hostname || 'agent non ancora collegato')}</div></div>${badge(st)}</div>
    <div class="meters">
      ${meter('CPU', m.cpu_pct, 100, fmt.pct, { hideMax: true })}
      ${meter('RAM', m.mem_used_mb, memMax, fmt.mb)}
      ${meter('Disco', m.disk_used_gb, diskMax, fmt.gb, { warn: 80 })}
    </div>
    ${s.online ? adviceList(report?.advice, 2) : ''}
    <div class="meta"><span>${s.cpu_cores ? `${s.cpu_cores} vCPU · ` : ''}${s.apps} app</span><span>${s.last_seen ? `visto ${ago(s.last_seen)}` : 'mai visto'}</span></div>
  </div>`;
}

// Why a server is flagged: the analysis' advice, most serious first.
const LEVEL_ORDER = { critical: 0, offline: 0, warning: 1, info: 2 };
function adviceList(advice, max = Infinity) {
  const items = (advice || []).filter((a) => a.level !== 'offline').sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
  if (!items.length) return '';
  const shown = items.slice(0, max);
  const more = items.length - shown.length;
  return `<ul class="advice card-advice">${shown.map((a) => `<li class="st-${a.level === 'critical' ? 'critical' : a.level === 'warning' ? 'warning' : 'info'}"><i class="dot"></i><span>${esc(a.text)}</span></li>`).join('')}
    ${more > 0 ? `<li class="muted">+${more} ${more === 1 ? 'altra indicazione' : 'altre indicazioni'}: apri il server</li>` : ''}</ul>`;
}

function addServerModal(onDone) {
  modal(`
    <h2>Aggiungi server</h2>
    <form id="f">
      <div class="field"><label for="n">Nome</label><input id="n" required pattern="[a-zA-Z0-9][a-zA-Z0-9._\\-]{0,62}" placeholder="es. ops-prod-01"></div>
      <div class="field"><label for="no">Note (opzionale)</label><input id="no" placeholder="es. Hetzner CX41, Falkenstein"></div>
      <div class="err" id="e"></div>
      <div class="modal-actions"><button type="button" data-close>Annulla</button><button class="primary">Crea</button></div>
    </form>`, (m, close) => {
    m.querySelector('#f').onsubmit = async (e) => {
      e.preventDefault();
      try {
        const r = await api('/api/servers', { method: 'POST', body: { name: m.querySelector('#n').value.trim(), notes: m.querySelector('#no').value } });
        close();
        installModal(r, 'Server creato');
        onDone && onDone();
      } catch (err) { m.querySelector('#e').textContent = err.message; }
    };
  });
}

function installModal(r, title) {
  modal(`
    <h2>${esc(title)}</h2>
    <p class="ink2">Esegui questo comando sul server <b>${esc(r.name || '')}</b> (richiede Python 3 e systemd). Il token è mostrato <b>una sola volta</b>.</p>
    <pre class="copy" id="cmd">${esc(r.install)}</pre>
    <p class="muted" style="font-size:13px">Per monitorare le app definite localmente modifica <code>/etc/zdt-agent/config.json</code>; per creare app dalla console installa gli hook in <code>/etc/zdt-agent/hooks/</code>.</p>
    <div class="modal-actions"><button id="cp">Copia</button><button class="primary" data-close>Fatto</button></div>`, (m) => {
    m.querySelector('#cp').onclick = async (e) => {
      try { await navigator.clipboard.writeText(r.install); e.target.textContent = 'Copiato ✓'; } catch { e.target.textContent = 'Seleziona e copia'; }
    };
  });
}

// ---------------------------------------------------------------------------
// Server detail
// ---------------------------------------------------------------------------
async function renderServer(id) {
  const main = shell('servers', '<div class="loading">Caricamento…</div>');
  let busy = false;
  const load = async () => {
    const [s, metrics, analysis] = await Promise.all([api(`/api/servers/${id}`), api(`/api/servers/${id}/metrics?range=${state.range}`), api('/api/analysis?days=7&n=1').catch(() => null)]);
    busy = anyBusy(s.apps);
    const report = analysis?.servers.find((x) => x.id === s.id);
    const m = s.latest || {};
    const extra = m.extra || {};
    const memMax = m.mem_total_mb || s.mem_total_mb;
    const diskMax = m.disk_total_gb || s.disk_total_gb;
    main.innerHTML = `
      <div class="page-head">
        <div>
          <div class="muted" style="font-size:13px"><a href="#/">Server</a> /</div>
          <div class="row"><h1>${esc(s.name)}</h1>${badge(s.online ? 'online' : 'offline')}</div>
          <p>${esc([s.hostname, s.os, s.cpu_cores && `${s.cpu_cores} vCPU`, s.mem_total_mb && fmt.mb(s.mem_total_mb) + ' RAM', s.disk_total_gb && fmt.gb(s.disk_total_gb) + ' disco'].filter(Boolean).join(' · ') || 'Agent non ancora collegato')}
          ${s.last_seen ? ` · visto ${ago(s.last_seen)}` : ''}${s.agent_version ? ` · agent ${esc(s.agent_version)}` : ''}</p>
          ${s.notes ? `<p class="muted">${esc(s.notes)}</p>` : ''}
        </div>
        <div class="row">
          <button class="primary admin-only" id="newapp">+ Nuova app (portale)</button>
          <button class="admin-only" id="token">Installa agent</button>
          <button class="danger admin-only" id="del">Elimina</button>
        </div>
      </div>
      ${s.online && report && report.advice.length ? `<div class="banner"><div class="icon" aria-hidden="true">${report.status === 'critical' ? '⚠' : report.status === 'warning' ? '!' : 'i'}</div>
        <div style="min-width:0"><b>${esc({ critical: 'Critico', warning: 'Attenzione', info: 'Da sapere' }[report.status] || 'Indicazioni')}</b> <span class="muted">(ultimi 7 giorni)</span>${adviceList(report.advice)}</div></div>` : ''}

      <div class="grid cards">
        <div class="card"><div class="meters">
          ${meter('CPU', m.cpu_pct, 100, fmt.pct, { hideMax: true })}
          ${meter('RAM', m.mem_used_mb, memMax, fmt.mb)}
          ${meter('Disco', m.disk_used_gb, diskMax, fmt.gb, { warn: 80 })}
        </div></div>
        <div class="card"><table><tbody>
          <tr><td class="muted">Load (1/5/15)</td><td class="r">${[m.load1, m.load5, m.load15].map((v) => (v == null ? '–' : v.toFixed(2))).join(' / ')}</td></tr>
          <tr><td class="muted">Swap</td><td class="r">${fmt.mb(m.swap_used_mb)}</td></tr>
          <tr><td class="muted">Rete ↓ / ↑</td><td class="r">${fmt.bps(m.net_rx_bps)} / ${fmt.bps(m.net_tx_bps)}</td></tr>
          <tr><td class="muted">iowait / steal</td><td class="r">${fmt.pct(extra.iowait_pct)} / ${fmt.pct(extra.steal_pct)}</td></tr>
          <tr><td class="muted">Connessioni TCP · processi</td><td class="r">${extra.tcp_established ?? '–'} · ${m.procs ?? '–'}</td></tr>
          <tr><td class="muted">Uptime</td><td class="r">${m.uptime_s ? `${Math.floor(m.uptime_s / 86400)} g ${Math.floor((m.uptime_s % 86400) / 3600)} h` : '–'}</td></tr>
        </tbody></table></div>
      </div>

      <div class="section">
        <div class="row" style="justify-content:space-between;margin-bottom:12px"><h2>Andamento</h2>${rangeSeg()}</div>
        <div class="grid two">
          ${chartCard('c-cpu', 'CPU', fmt.pct(m.cpu_pct))}
          ${chartCard('c-mem', 'RAM utilizzata', fmt.mb(m.mem_used_mb))}
          ${chartCard('c-disk', 'Disco utilizzato', fmt.gb(m.disk_used_gb))}
          ${chartCard('c-net', 'Traffico di rete', '')}
          ${chartCard('c-load', 'Load average (1 min)', m.load1 == null ? '–' : m.load1.toFixed(2))}
        </div>
      </div>

      <div class="section">
        <h2>App ospitate</h2>
        <div class="card">${appsTable(s.apps)}</div>
        <div id="app-detail"></div>
      </div>

      ${s.tasks.length ? `<div class="section"><h2>Operazioni recenti</h2><div class="card table-wrap"><table>
        <thead><tr><th>#</th><th>Operazione</th><th>App</th><th>Stato</th><th>Esito</th><th>Aggiornato</th></tr></thead><tbody>
        ${s.tasks.map((t) => `<tr><td class="muted">${t.id}</td><td>${esc({ create_app: 'Creazione', remove_app: 'Archiviazione', purge_app: 'Eliminazione definitiva' }[t.action] || t.action)}</td><td>${esc(t.app_name || JSON.parse(t.payload).name)}</td>
          <td>${badge(t.status)}</td><td class="mono" style="max-width:420px;white-space:pre-wrap">${esc((t.message || '').slice(-300))}</td><td class="muted">${ago(t.updated_at)}</td></tr>`).join('')}
        </tbody></table></div></div>` : ''}`;

    const rows = metrics.rows;
    const ts = rows.map((r) => r.t);
    const span = { from: metrics.from, to: metrics.to };
    lineChart(document.getElementById('c-cpu'), { ...span, ts, series: [{ name: 'CPU', values: rows.map((r) => r.cpu_pct), color: C.s1 }], yMax: 100, format: fmt.pct, limit: { value: 85, label: 'saturazione 85%' } });
    lineChart(document.getElementById('c-mem'), { ...span, ts, series: [{ name: 'RAM', values: rows.map((r) => r.mem_used_mb), color: C.s1 }], yMax: memMax || undefined, format: fmt.mb, limit: memMax ? { value: memMax * 0.9, label: '90%' } : null });
    lineChart(document.getElementById('c-disk'), { ...span, ts, series: [{ name: 'Disco', values: rows.map((r) => r.disk_used_gb), color: C.s1 }], yMax: diskMax || undefined, format: fmt.gb });
    lineChart(document.getElementById('c-net'), { ...span, ts, series: [{ name: 'In entrata', values: rows.map((r) => r.net_rx_bps), color: C.s1 }, { name: 'In uscita', values: rows.map((r) => r.net_tx_bps), color: C.s2 }], format: fmt.bps });
    lineChart(document.getElementById('c-load'), { ...span, ts, series: [{ name: 'Load 1m', values: rows.map((r) => r.load1), color: C.s1 }], format: fmt.num, limit: s.cpu_cores ? { value: s.cpu_cores, label: `${s.cpu_cores} core` } : null });

    main.querySelectorAll('[data-range]').forEach((b) => (b.onclick = () => { state.range = b.dataset.range; load(); }));
    document.getElementById('newapp').onclick = () => newAppModal(s, load);
    document.getElementById('token').onclick = async () => {
      if (!confirm('Generare un nuovo token? Il token attuale smetterà di funzionare e andrà reinstallato l\'agent.')) return;
      const r = await api(`/api/servers/${id}/token`, { method: 'POST' });
      installModal({ ...r, name: s.name }, 'Installa / reinstalla agent');
    };
    document.getElementById('del').onclick = async () => {
      if (!confirm(`Eliminare ${s.name} e tutte le sue metriche? L'operazione è irreversibile.`)) return;
      await api(`/api/servers/${id}`, { method: 'DELETE' });
      location.hash = '#/';
    };
    main.querySelectorAll('[data-app]').forEach((tr) => (tr.onclick = (e) => {
      if (e.target.closest('button')) return;
      state.selectedApp = Number(tr.dataset.app);
      main.querySelectorAll('[data-app]').forEach((x) => x.classList.toggle('selected', x === tr));
      showApp(s.apps.find((a) => a.id === state.selectedApp));
    }));
    main.querySelectorAll('[data-health]').forEach((b) => (b.onclick = async () => {
      b.disabled = true;
      b.textContent = 'Verifico…';
      try { await api(`/api/apps/${b.dataset.health}/health`, { method: 'POST' }); } catch (e) { alert(e.message); }
      load();
    }));
    main.querySelectorAll('details[data-cred]').forEach((d) => d.addEventListener('toggle', () => d.open && loadCredentials(d)));
    main.querySelectorAll('[data-edit-app]').forEach((b) => (b.onclick = () => editAppModal(s.apps.find((a) => a.id === Number(b.dataset.editApp)), load)));
    main.querySelectorAll('[data-del-app]').forEach((b) => (b.onclick = () => removeAppModal(s.apps.find((a) => a.id === Number(b.dataset.delApp)), load)));
    const sel = s.apps.find((a) => a.id === state.selectedApp);
    if (sel) { main.querySelector(`[data-app="${sel.id}"]`)?.classList.add('selected'); showApp(sel); }
  };
  await load();
  setRefresh(load, 60000, () => busy);
}

const rangeSeg = () => `<div class="seg" role="group" aria-label="Periodo">${['1h', '6h', '24h', '7d', '30d'].map((r) => `<button data-range="${r}" class="${state.range === r ? 'on' : ''}">${r.replace('d', 'g')}</button>`).join('')}</div>`;
const chartCard = (id, title, now) => `<div class="card"><div class="chart-title"><h3>${esc(title)}</h3><span class="now num">${esc(now)}</span></div><div id="${id}"></div></div>`;

function appsTable(apps) {
  if (!apps.length) return `<div class="empty-state"><p>Nessuna app. Crea un portale con <b>+ Nuova app</b> oppure definiscile in <code>/etc/zdt-agent/config.json</code>: l'agent le registra in automatico.</p></div>`;
  return `<div class="table-wrap"><table>
    <thead><tr><th>App</th><th>Tipo</th><th>Stato</th><th class="r">CPU ora</th><th class="r">RAM ora</th><th class="r">CPU media 24h</th><th class="r">RAM max 24h</th><th>Dominio</th><th></th></tr></thead>
    <tbody>${apps.map((a) => `<tr class="clickable" data-app="${a.id}">
      <td><b>${esc(a.name)}</b><div class="muted mono" style="font-size:11.5px">${esc(a.kind)}: ${esc(a.match || '')}</div></td>
      <td>${esc({ portal: 'Portale', service: 'Servizio', other: 'Altro' }[a.type] || a.type)}</td>
      <td>${badge(a.status)}${a.status === 'error' && a.status_msg ? `<div class="muted" style="font-size:12px;max-width:240px">${esc(a.status_msg.slice(-120))}</div>` : ''}</td>
      <td class="r">${a.latest ? fmt.cores(a.latest.cpu_pct / 100) : '–'}</td>
      <td class="r">${a.latest ? fmt.mb(a.latest.mem_mb) : '–'}</td>
      <td class="r">${a.last24h.cpu_avg == null ? '–' : fmt.cores(a.last24h.cpu_avg / 100)}</td>
      <td class="r">${fmt.mb(a.last24h.mem_max)}</td>
      <td>${a.domain ? (a.type === 'portal' ? `<a href="https://${esc(a.domain)}" target="_blank" rel="noopener">${esc(a.domain)}</a>` : esc(a.domain)) : '<span class="muted">–</span>'}${a.port ? `<span class="muted">:${a.port}</span>` : ''}${healthBadge(a)}</td>
      <td class="r"><div class="row" style="justify-content:flex-end;flex-wrap:nowrap"><button class="small admin-only" data-edit-app="${a.id}" aria-label="Modifica ${esc(a.name)}">Modifica</button><button class="small danger admin-only" data-del-app="${a.id}" aria-label="Rimuovi ${esc(a.name)}">Rimuovi</button></div></td>
    </tr>${credentialsRow(a)}`).join('')}</tbody></table></div>
    <p class="muted" style="font-size:12px;margin:10px 0 0">CPU in core (1,00 = un core pieno). Clicca su un'app per vederne l'andamento.</p>`;
}

// Portals only: result of the periodic GET https://<domain>/login (must be 200).
function healthBadge(a) {
  if (a.type !== 'portal' || a.status !== 'active' || !a.domain) return '';
  const when = a.health_at ? ` · verificato ${ago(a.health_at)}` : '';
  let b;
  if (!a.health) b = badge('pending', 'Sito: in verifica');
  else if (a.health === 'ok' && a.health_code === 401) b = `<span title="Il sito risponde ma chiede una password (401)${esc(when)}">${badge('ok', 'Sito raggiungibile · protetto')}</span>`;
  else if (a.health === 'ok') b = `<span title="/login risponde 200${esc(when)}">${badge('ok', 'Sito raggiungibile')}</span>`;
  else b = `<span title="${esc((a.health_error || 'non raggiungibile') + when)}">${badge('critical', a.health_code ? `Sito: errore ${a.health_code}` : 'Sito non raggiungibile')}</span>`;
  const why = a.health === 'down' && a.health_error ? `<div class="muted" style="font-size:12px;max-width:260px">${esc(a.health_error)}</div>` : '';
  // "Verifica ora" only while there is something to wait for: a healthy site needs no button.
  const retry = a.health === 'ok' ? '' : `<button class="small" data-health="${a.id}" title="Ricontrolla adesso">Verifica ora</button>`;
  return `<div class="row" style="gap:6px;margin-top:4px">${b}${retry}</div>${why}`;
}

// First-access credentials of portals created by the console: collapsed, admins only, fetched on open.
function credentialsRow(a) {
  if (!a.credentials || !isAdmin()) return '';
  const c = a.credentials;
  let body;
  if (c.status === 'pending') body = '<p class="muted">Il portale è in creazione: la password sarà disponibile quando lo script avrà finito.</p>';
  else if (c.status === 'unsupported') body = `<p class="muted">Lo script del gestionale ha scelto una sua password e non quella della console. La trovi sul server in <code>/opt/squadra-${esc(a.name)}/ACCESSO.txt</code>.</p>`;
  else body = '<div class="cred-body" data-cred-body><p class="muted">Caricamento…</p></div>';
  const seen = c.revealed_at ? ` · vista da ${esc(c.revealed_by || '?')} ${ago(c.revealed_at)}` : '';
  return `<tr class="cred-row"><td colspan="9"><details data-cred="${a.id}" data-cred-status="${esc(c.status)}">
    <summary>🔑 Accesso iniziale<span class="muted" style="font-weight:400">${seen}</span></summary>${body}</details></td></tr>`;
}

async function loadCredentials(details) {
  const box = details.querySelector('[data-cred-body]');
  if (!box || box.dataset.loaded) return;
  try {
    const c = await api(`/api/apps/${details.dataset.cred}/credentials`);
    box.dataset.loaded = '1';
    const user = c.username || 'admin';
    const message = `Ciao,\nil tuo gestionale è pronto.\n\nIndirizzo: ${c.login_url}\nUtente: ${user}\nPassword: ${c.password}\n\nAl primo accesso cambia la password con una scelta da te.`;
    box.innerHTML = `
      <div class="cred-grid">
        <span class="muted">Indirizzo</span><span><a href="${esc(c.login_url)}" target="_blank" rel="noopener">${esc(c.login_url)}</a></span>
        <span class="muted">Utente</span><span class="mono">${esc(user)}</span>
        <span class="muted">Password</span><span class="row" style="gap:8px"><code class="pw" data-pw>••••••••••••••••</code>
          <button type="button" class="small" data-pw-toggle>Mostra</button><button type="button" class="small" data-copy="pw">Copia password</button></span>
      </div>
      <div class="row" style="margin-top:10px"><button type="button" class="small primary" data-copy="msg">Copia messaggio per il cliente</button>
        <span class="muted" style="font-size:12px">Indirizzo, utente e password pronti da inviare. Consiglia di cambiarla al primo accesso.</span></div>`;
    const pw = box.querySelector('[data-pw]');
    box.querySelector('[data-pw-toggle]').onclick = (e) => {
      const show = pw.textContent.startsWith('•');
      pw.textContent = show ? c.password : '••••••••••••••••';
      e.target.textContent = show ? 'Nascondi' : 'Mostra';
    };
    box.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = async () => {
      const text = b.dataset.copy === 'pw' ? c.password : message;
      try { await navigator.clipboard.writeText(text); b.textContent = 'Copiato ✓'; } catch { b.textContent = 'Copia non riuscita'; }
    }));
  } catch (e) {
    box.innerHTML = `<p class="err">${esc(e.message)}</p>`;
  }
}

async function showApp(app) {
  const box = document.getElementById('app-detail');
  if (!box || !app) return;
  const d = await api(`/api/apps/${app.id}/metrics?range=${state.range}`);
  const ts = d.rows.map((r) => r.t);
  box.innerHTML = `<div class="grid two" style="margin-top:16px">${chartCard('a-cpu', `${app.name} · CPU`, '')}${chartCard('a-mem', `${app.name} · RAM`, '')}</div>`;
  lineChart(document.getElementById('a-cpu'), { from: d.from, to: d.to, ts, series: [{ name: 'CPU', values: d.rows.map((r) => (r.cpu_pct == null ? null : r.cpu_pct / 100)), color: C.s1 }], format: fmt.cores });
  lineChart(document.getElementById('a-mem'), { from: d.from, to: d.to, ts, series: [{ name: 'RAM', values: d.rows.map((r) => r.mem_mb), color: C.s1 }], format: fmt.mb });
}

function editAppModal(app, onDone) {
  modal(`
    <h2>Modifica ${esc(app.name)}</h2>
    <form id="f">
      <div class="field"><label for="et">Tipo</label><select id="et">${[['portal', 'Portale (gestionale)'], ['service', 'Servizio'], ['other', 'Altro']].map(([v, l]) => `<option value="${v}" ${app.type === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="field"><label for="ed">Dominio</label><input id="ed" autocomplete="off" value="${esc(app.domain || '')}" placeholder="es. ops.zerodarkteam.it"><small>Per un portale: la console controlla che <code>https://&lt;dominio&gt;/login</code> risponda.</small></div>
      <div class="field"><label for="em2">Criterio di monitoraggio</label><input id="em2" autocomplete="off" value="${esc(app.match || '')}"><small>${app.kind === 'systemd' ? 'Unit systemd.' : `Espressione regolare sui nomi ${app.kind === 'docker' ? 'dei container' : 'dei processi'}.`} Se l'app è definita nella configurazione dell'agent, vale quella.</small></div>
      <p class="muted" style="font-size:13px;margin:0">Cambia solo come la console mostra e controlla l'app: sul server non viene toccato nulla.</p>
      <div class="err" id="e"></div>
      <div class="modal-actions"><button type="button" data-close>Annulla</button><button class="primary">Salva</button></div>
    </form>`, (m, close) => {
    m.querySelector('#f').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api(`/api/apps/${app.id}`, { method: 'PATCH', body: { type: m.querySelector('#et').value, domain: m.querySelector('#ed').value.trim() || null, match: m.querySelector('#em2').value.trim() || null } });
        close();
        onDone();
      } catch (err) { m.querySelector('#e').textContent = err.message; }
    };
  });
}

function newAppModal(server, onDone) {
  const suffix = state.me.portal_domain || 'zerodarkteam.it';
  modal(`
    <h2>Nuova app su ${esc(server.name)}</h2>
    <form id="f">
      <div class="field"><label for="t">Tipo</label><select id="t"><option value="portal">Portale (gestionale)</option><option value="service">Servizio</option><option value="other">Altro</option></select></div>
      <div class="field"><label for="n">Nome</label><input id="n" required autocomplete="off" placeholder="es. rossi"><small id="n-hint"></small></div>
      <div class="portal-only">
        <div class="field"><label for="d">Dominio</label><input id="d" autocomplete="off"><small>Vuoto = <code id="d-default"></code>. Se il DNS non punta ancora al server, il portale nasce lo stesso e il sito si attiva quando il record c'è.</small></div>
        <div class="field"><label for="em">Email dell'amministratore</label><input id="em" type="email" autocomplete="off" placeholder="admin@cliente.it"><small>È l'utente con cui il nuovo proprietario entra la prima volta.</small></div>
        <p class="muted" style="font-size:13px;margin:0 0 14px">Crea database, app e WhatsApp del gestionale con le immagini della produzione, partendo da un database vuoto. La password del primo accesso la genera la console: la trovi nella riga del portale, sotto <b>Accesso iniziale</b>, pronta da consegnare.</p>
      </div>
      <div class="other-only" hidden>
        <div class="inline-fields" style="margin-bottom:14px">
          <div class="field" style="flex:1"><label for="k">Esecuzione</label><select id="k"><option value="docker">Docker</option><option value="systemd">Servizio systemd</option><option value="process">Processo</option></select></div>
          <div class="field" style="flex:1"><label for="p">Porta</label><input id="p" type="number" min="1" max="65535"></div>
        </div>
        <div class="field"><label for="d2">Dominio (opzionale)</label><input id="d2" autocomplete="off"></div>
        <div class="field"><label for="mt">Criterio di monitoraggio (opzionale)</label><input id="mt" placeholder="regex su nome container / processo, oppure unit systemd"><small>Vuoto = nome dell'app.</small></div>
      </div>
      <div class="field"><label style="display:flex;gap:8px;align-items:center;color:var(--ink)"><input id="pv" type="checkbox" checked style="width:auto"> Crea sul server (lo script <code>create_app</code> viene eseguito dall'agent)</label>
        <small>Se disattivato, l'app viene solo registrata e monitorata.</small></div>
      <div class="err" id="e"></div>
      <div class="modal-actions"><button type="button" data-close>Annulla</button><button class="primary">Crea</button></div>
    </form>`, (m, close) => {
    const $ = (id) => m.querySelector(id);
    const v = (id) => $(id).value.trim();
    const isPortal = () => $('#t').value === 'portal';
    const refresh = () => {
      const portal = isPortal();
      m.querySelector('.portal-only').hidden = !portal;
      m.querySelector('.other-only').hidden = portal;
      const name = v('#n').toLowerCase();
      $('#d-default').textContent = `${name || '<nome>'}.${suffix}`;
      $('#d').placeholder = `${name || '<nome>'}.${suffix}`;
      let hint = '';
      if (portal && name) {
        if (/^(ops|www|test.*)$/.test(name)) hint = 'Nome riservato (ops, test*, www). Per una prova usa "demo".';
        else if (!/^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/.test(name)) hint = 'Solo minuscole, numeri e trattini: diventa il sottodominio.';
      }
      $('#n-hint').textContent = hint;
      $('#n-hint').style.color = hint ? 'var(--crit-ink)' : '';
    };
    $('#t').onchange = refresh;
    $('#n').oninput = refresh;
    refresh();
    $('#f').onsubmit = async (e) => {
      e.preventDefault();
      const portal = isPortal();
      if (portal && !v('#em')) { $('#e').textContent = "Indica l'email dell'amministratore: sarà il suo utente."; return; }
      const body = portal
        ? { type: 'portal', name: v('#n').toLowerCase(), domain: v('#d') || null, email: v('#em') || null, provision: $('#pv').checked }
        : { type: v('#t'), name: v('#n'), kind: v('#k'), port: v('#p') ? Number(v('#p')) : null, domain: v('#d2') || null, match: v('#mt') || null, provision: $('#pv').checked };
      try {
        await api(`/api/servers/${server.id}/apps`, { method: 'POST', body });
        close();
        onDone();
      } catch (err) { $('#e').textContent = err.message; }
    };
  });
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------
async function renderAnalysis() {
  const main = shell('analysis', '<div class="loading">Calcolo in corso…</div>');
  const q = () => `days=${state.days}&headroom=${state.headroom / 100}&n=${state.n}`;
  const load = async () => {
    main.querySelector('#results')?.setAttribute('aria-busy', 'true');
    const a = await api(`/api/analysis?${q()}`);
    const v = VERDICT[a.fleet.verdict];
    main.innerHTML = `
      <div class="page-head">
        <div><h1>Capacità & combinazioni</h1><p>Percentile 95 su ${a.params.days} giorni · soglia di sicurezza ${Math.round(a.params.headroom * 100)}% · calcolato ${new Date(a.generated_at).toLocaleTimeString('it-IT')}</p></div>
        <form class="inline-fields" id="params">
          <div class="field"><label for="days">Finestra</label><select id="days">${[1, 7, 14, 30, 60, 90].map((d) => `<option value="${d}" ${d === state.days ? 'selected' : ''}>${d} giorni</option>`).join('')}</select></div>
          <div class="field"><label for="hr">Soglia picchi</label><select id="hr">${[60, 70, 75, 80, 85, 90].map((h) => `<option value="${h}" ${h === state.headroom ? 'selected' : ''}>${h}%</option>`).join('')}</select></div>
          <div class="field"><label for="nn">Combinazioni</label><select id="nn">${[3, 5, 10].map((n) => `<option ${n === state.n ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
        </form>
      </div>
      <div id="results">
      <div class="banner"><div class="icon" aria-hidden="true">${v[0]}</div><div><b>${v[1]}</b><p>${a.fleet.advice.map(esc).join(' ')}</p>
        <p class="muted num">Flotta: ${fmt.cores(a.fleet.usage_p95.cpu_cores)} su ${a.fleet.capacity.cpu_cores} vCPU · ${fmt.mb(a.fleet.usage_p95.mem_mb)} su ${fmt.mb(a.fleet.capacity.mem_mb)} RAM (p95)</p></div></div>

      <div class="section"><h2>Server</h2><div class="card table-wrap"><table>
        <thead><tr><th>Server</th><th>Stato</th><th class="r">CPU p95</th><th class="r">RAM p95</th><th class="r">Disco</th><th class="r">Crescita disco</th><th class="r">Base (non-app)</th><th>Indicazioni</th></tr></thead>
        <tbody>${a.servers.map((s) => `<tr>
          <td><a href="#/server/${s.id}"><b>${esc(s.name)}</b></a><div class="muted" style="font-size:12px">${s.capacity.cpu_cores ?? '?'} vCPU · ${fmt.mb(s.capacity.mem_mb)}</div></td>
          <td>${badge(s.status)}</td>
          <td class="r">${fmt.pct(s.cpu.p95_pct)}</td>
          <td class="r">${fmt.pct(s.mem.p95_pct)}<div class="muted" style="font-size:12px">${fmt.mb(s.mem.p95_mb)}</div></td>
          <td class="r">${fmt.pct(s.disk.pct)}${s.disk.days_to_full != null ? `<div class="muted" style="font-size:12px">pieno in ~${s.disk.days_to_full} g</div>` : ''}</td>
          <td class="r">${s.disk.growth_gb_per_day == null ? '–' : `${s.disk.growth_gb_per_day > 0 ? '+' : ''}${s.disk.growth_gb_per_day.toFixed(2)} GB/g`}</td>
          <td class="r">${fmt.cores(s.base.cpu_p95_cores)}<div class="muted" style="font-size:12px">${fmt.mb(s.base.mem_p95_mb)}</div></td>
          <td>${s.advice.length ? `<ul class="advice">${s.advice.map((x) => `<li><i class="dot st-${x.level}" style="background:var(--${x.level === 'critical' || x.level === 'offline' ? 'critical' : x.level === 'warning' ? 'warning' : 'accent'})"></i><span>${esc(x.text)}</span></li>`).join('')}</ul>` : '<span class="muted">Nessuna criticità</span>'}</td>
        </tr>`).join('')}</tbody></table></div></div>

      <div class="section"><h2>App</h2><div class="card table-wrap"><table>
        <thead><tr><th>App</th><th>Server</th><th class="r">CPU media</th><th class="r">CPU p95</th><th class="r">RAM media</th><th class="r">RAM p95</th><th class="r">Trend RAM</th><th>Profilo orario CPU</th></tr></thead>
        <tbody>${a.apps.map((x) => `<tr>
          <td><b>${esc(x.name)}</b></td><td>${esc(a.servers.find((s) => s.id === x.server_id)?.name || '')}</td>
          <td class="r">${fmt.cores(x.cpu.avg_cores)}</td><td class="r">${fmt.cores(x.cpu.p95_cores)}</td>
          <td class="r">${fmt.mb(x.mem.avg_mb)}</td><td class="r">${fmt.mb(x.mem.p95_mb)}</td>
          <td class="r">${x.trend.mem_mb_per_day == null ? '–' : `${x.trend.mem_mb_per_day > 0 ? '+' : ''}${x.trend.mem_mb_per_day.toFixed(1)} MB/g`}</td>
          <td>${sparkBars(x.profile_hourly.cpu_cores)}</td>
        </tr>`).join('') || '<tr><td colspan="8" class="muted">Nessuna app con metriche.</td></tr>'}</tbody></table></div>
        <p class="muted" style="font-size:12px">Il profilo orario (0–23) mostra quando ogni app consuma: app con picchi in orari diversi possono condividere lo stesso server.</p></div>

      <div class="section"><h2>Combinazioni proposte</h2>
        <p class="ink2" style="margin-top:-6px">Il motore simula ogni distribuzione sommando le serie storiche delle app (non i singoli picchi) più il consumo di base di ogni server, e ordina per picco massimo, bilanciamento e numero di spostamenti.</p>
        ${a.current ? combo(a.current, 'Distribuzione attuale', false) : ''}
        <div class="grid" style="margin-top:16px">${a.combinations.map((c, i) => combo(c, `#${c.rank}${i === 0 ? ' · consigliata' : ''}`, i === 0)).join('') || '<div class="card muted">Servono metriche delle app per proporre combinazioni.</div>'}</div>
      </div>

      <div class="section"><h2>Export per il tool AI</h2><div class="card">
        <p class="ink2" style="margin-top:0">Il tool di riassortimento può leggere lo stesso input (server, app, percentili, profili orari, combinazioni) in JSON:</p>
        <pre class="copy">curl -H "Authorization: Bearer $EXPORT_TOKEN" "${esc(location.origin)}/api/v1/export?${esc(q())}"</pre>
        <div class="row" style="margin-top:12px"><button id="dl">Scarica JSON</button><span class="muted" style="font-size:12px">Il token si imposta con la variabile d'ambiente <code>EXPORT_TOKEN</code> del server.</span></div>
      </div></div>
      </div>`;
    const p = main.querySelector('#params');
    p.onchange = () => {
      state.days = Number(p.querySelector('#days').value);
      state.headroom = Number(p.querySelector('#hr').value);
      state.n = Number(p.querySelector('#nn').value);
      load();
    };
    main.querySelector('#dl').onclick = async () => {
      const data = await api(`/api/v1/export?${q()}`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const link = Object.assign(document.createElement('a'), { href: url, download: `capacity-${new Date().toISOString().slice(0, 10)}.json` });
      link.click();
      URL.revokeObjectURL(url);
    };
  };
  await load();
  setRefresh(null);
}

function sparkBars(values) {
  const max = Math.max(...values.filter((v) => v != null), 0);
  if (!max) return '<span class="muted">–</span>';
  const w = 4;
  const gap = 1;
  const h = 22;
  const bars = values.map((v, i) => {
    const bh = v == null ? 0 : Math.max(1, (v / max) * h);
    return `<rect x="${i * (w + gap)}" y="${h - bh}" width="${w}" height="${bh}" rx="1" fill="var(--s1)"><title>${String(i).padStart(2, '0')}:00 · ${fmt.cores(v)}</title></rect>`;
  });
  return `<svg width="${24 * (w + gap)}" height="${h}" role="img" aria-label="Profilo orario CPU">${bars.join('')}</svg>`;
}

function combo(c, title, best) {
  const hr = state.headroom;
  return `<div class="combo ${best ? 'best' : ''}">
    <div class="combo-head"><h3>${esc(title)}</h3>
      <div class="row">${c.requires_new_server ? badge('info', 'richiede nuovo server') : ''}${badge(c.feasible ? 'ok' : 'critical', c.feasible ? `entro soglia ${hr}%` : 'oltre soglia')}
      <span class="muted num" style="font-size:12px">picco ${fmt.pct(c.peak_util_pct)} · ${c.moves.length} spostamenti</span></div></div>
    <div class="combo-servers">${c.servers.map((s) => `<div class="combo-server ${s.virtual ? 'virtual' : ''}">
      <div class="row" style="justify-content:space-between;margin-bottom:8px"><b>${esc(s.name)}</b><span class="muted" style="font-size:12px">${s.capacity.cpu_cores} vCPU · ${fmt.mb(s.capacity.mem_mb)}</span></div>
      <div class="meters">
        ${meter('CPU p95', s.cpu_p95_pct, 100, fmt.pct, { warn: hr - 10, crit: hr, mark: hr, hideMax: true })}
        ${meter('RAM p95', s.mem_p95_pct, 100, fmt.pct, { warn: hr - 10, crit: hr, mark: hr, hideMax: true })}
      </div>
      <div class="chips">${s.apps.map((n) => `<span class="chip ${c.moves.some((m) => m.app === n) ? 'moved' : ''}">${esc(n)}</span>`).join('') || '<span class="muted" style="font-size:12px">nessuna app</span>'}</div>
    </div>`).join('')}</div>
    ${c.moves.length ? `<ul class="moves">${c.moves.map((m) => `<li>Sposta <b>${esc(m.app)}</b> → ${esc(m.to_name)}</li>`).join('')}</ul>` : ''}
  </div>`;
}

// ---------------------------------------------------------------------------
// Home tabs: Panoramica · Portali · App · Archivio
// ---------------------------------------------------------------------------
function homeTabs(active) {
  const tabs = [['overview', '#/', 'Panoramica'], ['portals', '#/portali', 'Portali'], ['apps', '#/app', 'App'], ['archive', '#/archivio', 'Archivio']];
  return `<nav class="tabs" aria-label="Sezioni">${tabs.map(([k, href, label]) => `<a href="${href}" class="${k === active ? 'on' : ''}" ${k === active ? 'aria-current="page"' : ''}>${label}</a>`).join('')}</nav>`;
}

const TYPE_LABEL = { portal: 'Portale', service: 'Servizio', other: 'Altro' };
const domainLink = (a) => (a.domain ? `<a href="https://${esc(a.domain)}" target="_blank" rel="noopener">${esc(a.domain)}</a>` : '<span class="muted">–</span>');
const usage = (a) => (a.latest ? `${fmt.cores(a.latest.cpu_pct / 100)} · ${fmt.mb(a.latest.mem_mb)}` : '–');

// Shared wiring for the action buttons rendered by the lists below.
function wireAppActions(main, apps, reload) {
  const byId = (id) => apps.find((a) => a.id === Number(id));
  main.querySelectorAll('[data-edit-app]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); editAppModal(byId(b.dataset.editApp), reload); }));
  main.querySelectorAll('[data-del-app]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); removeAppModal(byId(b.dataset.delApp), reload); }));
  main.querySelectorAll('[data-purge]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); purgeAppModal(byId(b.dataset.purge), reload); }));
  main.querySelectorAll('[data-cred-open]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); credentialsModal(byId(b.dataset.credOpen)); }));
  main.querySelectorAll('[data-health]').forEach((b) => (b.onclick = async (e) => {
    e.stopPropagation();
    b.disabled = true;
    b.textContent = 'Verifico…';
    try { await api(`/api/apps/${b.dataset.health}/health`, { method: 'POST' }); } catch (err) { b.textContent = err.message; }
    reload();
  }));
  main.querySelectorAll('[data-goto-server]').forEach((r) => (r.onclick = (e) => {
    if (e.target.closest('button, a')) return;
    location.hash = `#/server/${r.dataset.gotoServer}`;
  }));
}

const appActions = (a) => `<div class="row actions">
  ${a.credentials && a.credentials.status === 'applied' ? `<button class="small admin-only" data-cred-open="${a.id}">🔑 Accesso</button>` : ''}
  <button class="small admin-only" data-edit-app="${a.id}">Modifica</button>
  <button class="small danger admin-only" data-del-app="${a.id}">Rimuovi</button></div>`;

async function renderPortals() {
  const main = shell('servers', '<div class="loading">Caricamento…</div>');
  let busy = false;
  const load = async () => {
    const apps = await api('/api/apps?view=portals');
    busy = anyBusy(apps);
    main.innerHTML = `${homeTabs('portals')}
      <div class="page-head"><div><h1>Portali</h1><p>${apps.length} portali attivi · per crearne uno: apri un server → <b>+ Nuova app</b></p></div></div>
      ${!apps.length ? '<div class="card empty-state"><p>Nessun portale. Apri un server e usa <b>+ Nuova app → Portale</b>.</p></div>' : `
      <div class="card table-wrap desktop-only"><table>
        <thead><tr><th>Portale</th><th>Server</th><th>Stato</th><th>Sito</th><th class="r">CPU · RAM ora</th><th></th></tr></thead>
        <tbody>${apps.map((a) => `<tr class="clickable" data-goto-server="${a.server_id}">
          <td><b>${esc(a.name)}</b><div>${domainLink(a)}</div></td>
          <td>${esc(a.server_name)}</td>
          <td>${badge(a.status)}</td>
          <td>${healthBadge(a) || '<span class="muted">–</span>'}</td>
          <td class="r">${usage(a)}</td>
          <td class="r">${appActions(a)}</td></tr>`).join('')}</tbody></table></div>
      <div class="grid mobile-only">${apps.map((a) => `<div class="card portal-card" data-goto-server="${a.server_id}">
          <div class="card-head"><div><h2>${esc(a.name)}</h2><div style="font-size:13px">${domainLink(a)}</div></div>${badge(a.status)}</div>
          ${healthBadge(a)}
          <div class="meta"><span>${esc(a.server_name)}</span><span>${usage(a)}</span></div>
          ${appActions(a)}</div>`).join('')}</div>`}`;
    wireAppActions(main, apps, load);
  };
  await load();
  setRefresh(load, 60000, () => busy);
}

async function renderAllApps() {
  const main = shell('servers', '<div class="loading">Caricamento…</div>');
  let busy = false;
  const load = async () => {
    const apps = await api('/api/apps?view=all');
    busy = anyBusy(apps);
    main.innerHTML = `${homeTabs('apps')}
      <div class="page-head"><div><h1>App ospitate</h1><p>${apps.length} app su tutti i server · clicca per aprire il server</p></div></div>
      ${!apps.length ? '<div class="card empty-state"><p>Nessuna app monitorata.</p></div>' : `
      <div class="card table-wrap desktop-only"><table>
        <thead><tr><th>App</th><th>Tipo</th><th>Server</th><th>Stato</th><th class="r">CPU ora</th><th class="r">RAM ora</th><th class="r">RAM max 24h</th><th>Dominio</th><th></th></tr></thead>
        <tbody>${apps.map((a) => `<tr class="clickable" data-goto-server="${a.server_id}">
          <td><b>${esc(a.name)}</b><div class="muted mono" style="font-size:11.5px">${esc(a.kind)}: ${esc(a.match || '')}</div></td>
          <td>${esc(TYPE_LABEL[a.type] || a.type)}</td>
          <td>${esc(a.server_name)}</td>
          <td>${badge(a.status)}</td>
          <td class="r">${a.latest ? fmt.cores(a.latest.cpu_pct / 100) : '–'}</td>
          <td class="r">${a.latest ? fmt.mb(a.latest.mem_mb) : '–'}</td>
          <td class="r">${fmt.mb(a.last24h.mem_max)}</td>
          <td>${domainLink(a)}</td>
          <td class="r">${appActions(a)}</td></tr>`).join('')}</tbody></table></div>
      <div class="grid mobile-only">${apps.map((a) => `<div class="card portal-card" data-goto-server="${a.server_id}">
          <div class="card-head"><div><h2>${esc(a.name)}</h2><div class="muted" style="font-size:12px">${esc(TYPE_LABEL[a.type] || a.type)} · ${esc(a.server_name)}</div></div>${badge(a.status)}</div>
          <div class="meta"><span>${domainLink(a)}</span><span>${usage(a)}</span></div>
          ${appActions(a)}</div>`).join('')}</div>`}`;
    wireAppActions(main, apps, load);
  };
  await load();
  setRefresh(load, 60000, () => busy);
}

async function renderArchive() {
  const main = shell('servers', '<div class="loading">Caricamento…</div>');
  let busy = false;
  const load = async () => {
    const apps = await api('/api/apps?view=archive');
    busy = anyBusy(apps);
    const when = (a) => (a.archived_at ? `${esc(fmt.dateTime(a.archived_at))}${a.archived_by ? ` · ${esc(a.archived_by)}` : ''}` : '–');
    const note = (a) => (a.status === 'archived' && a.status_msg && /errore|fallit|non /i.test(a.status_msg) ? `<div class="err" style="font-size:12px">${esc(a.status_msg.slice(-200))}</div>` : '');
    const purge = (a) => {
      if (a.status === 'unmonitored') return `<div class="row actions"><button class="small primary admin-only" data-reattach="${a.id}">Ricollega</button><button class="small danger admin-only" data-purge="${a.id}">Togli dalla console</button></div>`;
      return a.status === 'archived' ? `<button class="small danger admin-only" data-purge="${a.id}">Elimina definitivamente</button>` : '';
    };
    main.innerHTML = `${homeTabs('archive')}
      <div class="page-head"><div><h1>Archivio</h1><p><b>Archiviate</b>: portali rimossi dal server (container fermati, sito staccato, dati conservati in <code>/opt/archivio</code> e nei volumi). <b>Non monitorate</b>: app ancora accese sul server che la console non segue più, da ricollegare con un clic.</p></div></div>
      ${!apps.length ? '<div class="card empty-state"><p>L\'archivio è vuoto.</p></div>' : `
      <div class="card table-wrap desktop-only"><table>
        <thead><tr><th>Portale</th><th>Server</th><th>Archiviato</th><th>Cartella</th><th>Stato</th><th></th></tr></thead>
        <tbody>${apps.map((a) => `<tr>
          <td><b>${esc(a.name)}</b><div class="muted" style="font-size:12px">${esc(a.domain || '')}</div></td>
          <td>${esc(a.server_name)}</td>
          <td>${when(a)}</td>
          <td class="mono" style="font-size:12px">${esc(a.archive_path || '–')}</td>
          <td>${badge(a.status)}${note(a)}</td>
          <td class="r">${purge(a)}</td></tr>`).join('')}</tbody></table></div>
      <div class="grid mobile-only">${apps.map((a) => `<div class="card portal-card">
          <div class="card-head"><div><h2>${esc(a.name)}</h2><div class="muted" style="font-size:12px">${esc(a.domain || '')} · ${esc(a.server_name)}</div></div>${badge(a.status)}</div>
          <div class="muted" style="font-size:12px">Archiviato ${when(a)}</div>
          <div class="mono" style="font-size:12px;word-break:break-all">${esc(a.archive_path || '')}</div>${note(a)}
          <div class="row actions">${purge(a)}</div></div>`).join('')}</div>`}`;
    wireAppActions(main, apps, load);
    main.querySelectorAll('[data-reattach]').forEach((b) => (b.onclick = async () => {
      b.disabled = true;
      try { await api(`/api/apps/${b.dataset.reattach}/reattach`, { method: 'POST' }); } catch (e) { b.textContent = e.message; return; }
      load();
    }));
  };
  await load();
  setRefresh(load, 60000, () => busy);
}

// ---------------------------------------------------------------------------
// Remove / purge / credentials dialogs
// ---------------------------------------------------------------------------
function removeAppModal(app, onDone) {
  if (!app) return;
  const canArchive = !!app.provisioned;
  modal(`
    <h2>Rimuovi ${esc(app.name)}</h2>
    ${canArchive ? `
    <div class="choice danger-choice">
      <h3>Archivia: rimuovi dal server</h3>
      <p class="ink2">Backup finale, container fermati, sito staccato (${esc(app.domain || 'nessun dominio')} smette di rispondere), cartella spostata in <code>/opt/archivio</code>. I dati restano nei volumi: dall'<b>Archivio</b> potrai eliminarlo definitivamente.</p>
      <div class="field"><label for="cf">Per confermare scrivi <b>${esc(app.name)}</b></label><input id="cf" autocomplete="off"></div>
      <button class="primary danger-btn" id="arch" disabled>Archivia ${esc(app.name)}</button>
    </div>` : `
    <p class="ink2">Quest'app non è stata creata dalla console: dalla console si può solo smettere di monitorarla, il server non viene toccato.${app.type === 'portal' ? '' : ''}</p>`}
    <div class="choice">
      <h3>Smetti solo di monitorare</h3>
      <p class="ink2">L'app resta accesa sul server: la console smette di seguirla e la sposta nell'<b>Archivio</b>, da dove puoi <b>ricollegarla</b> quando vuoi.</p>
      <button id="mon">Smetti di monitorare</button>
    </div>
    <div class="err" id="e"></div>
    <div class="modal-actions"><button type="button" data-close>Annulla</button></div>`, (m, close) => {
    const err = (t) => (m.querySelector('#e').textContent = t);
    if (canArchive) {
      const cf = m.querySelector('#cf');
      const btn = m.querySelector('#arch');
      cf.oninput = () => (btn.disabled = cf.value.trim() !== app.name);
      btn.onclick = async () => {
        try { await api(`/api/apps/${app.id}?deprovision=1&confirm=${encodeURIComponent(cf.value.trim())}`, { method: 'DELETE' }); close(); onDone(); } catch (e) { err(e.message); }
      };
    }
    m.querySelector('#mon').onclick = async () => {
      try { await api(`/api/apps/${app.id}`, { method: 'DELETE' }); close(); onDone(); } catch (e) { err(e.message); }
    };
  });
}

function purgeAppModal(app, onDone) {
  if (!app) return;
  modal(`
    <h2>${app.status === 'unmonitored' ? 'Togli dalla console' : 'Elimina definitivamente'} ${esc(app.name)}</h2>
    <p class="ink2">${app.provisioned && app.status !== 'unmonitored'
      ? `Sul server vengono cancellati i <b>volumi dei dati</b> (database, allegati, WhatsApp) e la cartella archiviata${app.archive_path ? ` <code>${esc(app.archive_path)}</code>` : ''}. <b>Non si può annullare.</b>`
      : 'Viene tolta solo dalla console: sul server non c\'è nulla da cancellare.'}</p>
    <div class="field"><label for="cf">Per confermare scrivi <b>${esc(app.name)}</b></label><input id="cf" autocomplete="off"></div>
    <div class="err" id="e"></div>
    <div class="modal-actions"><button type="button" data-close>Annulla</button><button class="primary danger-btn" id="go" disabled>Elimina definitivamente</button></div>`, (m, close) => {
    const cf = m.querySelector('#cf');
    const go = m.querySelector('#go');
    cf.oninput = () => (go.disabled = cf.value.trim() !== app.name);
    go.onclick = async () => {
      try { await api(`/api/apps/${app.id}/purge`, { method: 'POST', body: { confirm: cf.value.trim() } }); close(); onDone(); } catch (e) { m.querySelector('#e').textContent = e.message; }
    };
  });
}

function credentialsModal(app) {
  if (!app) return;
  modal(`<h2>Accesso iniziale · ${esc(app.name)}</h2>
    <details data-cred="${app.id}" open style="border:0;padding:0"><summary hidden></summary><div class="cred-body" data-cred-body><p class="muted">Caricamento…</p></div></details>
    <div class="modal-actions"><button type="button" data-close>Chiudi</button></div>`, (m) => loadCredentials(m.querySelector('details')));
}

// ---------------------------------------------------------------------------
// Account & users
// ---------------------------------------------------------------------------
const ROLE_LABEL = { admin: 'Amministratore', viewer: 'Sola lettura' };

function renderAccount() {
  setRefresh(null);
  const me = state.me.user;
  const main = shell('account', `
    <div class="page-head"><div><h1>Il mio account</h1><p>${esc(ROLE_LABEL[me.role] || me.role)}${me.last_login ? ` · ultimo accesso ${esc(fmt.dateTime(me.last_login))}` : ''}</p></div></div>
    <div class="grid two">
      <form class="card" id="f-name">
        <h2 style="margin-bottom:14px">Nome utente</h2>
        <div class="field"><label for="a-un">Nuovo nome utente</label><input id="a-un" autocomplete="username" required value="${esc(me.username)}"></div>
        <div class="field"><label for="a-cur1">Password attuale</label><input id="a-cur1" type="password" autocomplete="current-password" required></div>
        <div class="row"><button class="primary">Salva nome utente</button><span class="status-msg" id="m-name" role="status"></span></div>
      </form>
      <form class="card" id="f-pw">
        <h2 style="margin-bottom:14px">Password</h2>
        <div class="field"><label for="a-cur2">Password attuale</label><input id="a-cur2" type="password" autocomplete="current-password" required></div>
        <div class="field"><label for="a-new">Nuova password</label><input id="a-new" type="password" autocomplete="new-password" minlength="8" required><small>Almeno 8 caratteri. Gli altri dispositivi collegati verranno disconnessi.</small></div>
        <div class="field"><label for="a-new2">Ripeti la nuova password</label><input id="a-new2" type="password" autocomplete="new-password" minlength="8" required></div>
        <div class="row"><button class="primary">Cambia password</button><span class="status-msg" id="m-pw" role="status"></span></div>
      </form>
    </div>`);
  const msg = (id, text, ok) => { const el = main.querySelector(id); el.textContent = text; el.className = `status-msg ${ok ? 'ok' : 'bad'}`; };
  main.querySelector('#f-name').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api('/api/me', { method: 'PATCH', body: { username: main.querySelector('#a-un').value.trim(), current_password: main.querySelector('#a-cur1').value } });
      state.me.user = r.user;
      renderAccount();
      msg('#m-name', 'Nome utente aggiornato', true);
    } catch (err) { msg('#m-name', err.message); }
  };
  main.querySelector('#f-pw').onsubmit = async (e) => {
    e.preventDefault();
    const n1 = main.querySelector('#a-new').value;
    if (n1 !== main.querySelector('#a-new2').value) return msg('#m-pw', 'Le due password non coincidono');
    try {
      await api('/api/me', { method: 'PATCH', body: { new_password: n1, current_password: main.querySelector('#a-cur2').value } });
      e.target.reset();
      msg('#m-pw', 'Password cambiata', true);
    } catch (err) { msg('#m-pw', err.message); }
  };
}

async function renderUsers() {
  setRefresh(null);
  const main = shell('users', '<div class="loading">Caricamento…</div>');
  if (!isAdmin()) { main.innerHTML = '<div class="card empty-state"><h2>Accesso riservato</h2><p>Solo gli amministratori possono gestire gli utenti.</p></div>'; return; }
  const load = async () => {
    const { users, roles } = await api('/api/users');
    const me = state.me.user;
    const roleSelect = (u) => `<select data-role="${u.id}" aria-label="Ruolo di ${esc(u.username)}">${roles.map((r) => `<option value="${r}" ${r === u.role ? 'selected' : ''}>${esc(ROLE_LABEL[r] || r)}</option>`).join('')}</select>`;
    main.innerHTML = `
      <div class="page-head"><div><h1>Utenti</h1><p>Gli amministratori gestiscono server, app e utenti. Gli utenti in sola lettura vedono dashboard e analisi.</p></div>
        <button class="primary" id="newuser">+ Nuovo utente</button></div>
      <div class="card table-wrap"><table>
        <thead><tr><th>Utente</th><th>Ruolo</th><th>Ultimo accesso</th><th>Creato</th><th></th></tr></thead>
        <tbody>${users.map((u) => `<tr>
          <td><b>${esc(u.username)}</b>${u.id === me.id ? ' <span class="muted">(tu)</span>' : ''}</td>
          <td style="max-width:200px">${roleSelect(u)}</td>
          <td class="muted">${u.last_login ? esc(fmt.dateTime(u.last_login)) : 'mai'}</td>
          <td class="muted">${esc(fmt.dateTime(u.created_at))}</td>
          <td class="r"><div class="row" style="justify-content:flex-end">
            <button class="small" data-reset="${u.id}" data-name="${esc(u.username)}">Reimposta password</button>
            ${u.id === me.id ? '' : `<button class="small danger" data-deluser="${u.id}" data-name="${esc(u.username)}">Elimina</button>`}
          </div></td></tr>`).join('')}</tbody></table></div>
      <div class="err" id="u-err" role="status"></div>`;
    const err = (t) => (main.querySelector('#u-err').textContent = t || '');
    main.querySelector('#newuser').onclick = () => userModal(roles, load);
    main.querySelectorAll('[data-role]').forEach((sel) => (sel.onchange = async () => {
      try { await api(`/api/users/${sel.dataset.role}`, { method: 'PATCH', body: { role: sel.value } }); err(); state.me = await api('/api/me'); route(); }
      catch (e) { err(e.message); load(); }
    }));
    main.querySelectorAll('[data-reset]').forEach((b) => (b.onclick = () => resetModal(b.dataset.reset, b.dataset.name)));
    main.querySelectorAll('[data-deluser]').forEach((b) => (b.onclick = async () => {
      if (!confirm(`Eliminare l'utente "${b.dataset.name}"?`)) return;
      try { await api(`/api/users/${b.dataset.deluser}`, { method: 'DELETE' }); load(); } catch (e) { err(e.message); }
    }));
  };
  await load();
}

function userModal(roles, onDone) {
  modal(`
    <h2>Nuovo utente</h2>
    <form id="f">
      <div class="field"><label for="nu">Nome utente</label><input id="nu" required autocomplete="off" placeholder="es. mario.rossi"></div>
      <div class="field"><label for="np">Password iniziale</label><input id="np" type="text" minlength="8" required autocomplete="off"><small>Almeno 8 caratteri. Comunicala all'utente: potrà cambiarla da "Il mio account".</small></div>
      <div class="field"><label for="nr">Ruolo</label><select id="nr">${roles.map((r) => `<option value="${r}" ${r === 'viewer' ? 'selected' : ''}>${esc(ROLE_LABEL[r] || r)}</option>`).join('')}</select></div>
      <div class="err" id="e"></div>
      <div class="modal-actions"><button type="button" data-close>Annulla</button><button class="primary">Crea utente</button></div>
    </form>`, (m, close) => {
    m.querySelector('#np').value = randomPassword();
    m.querySelector('#f').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('/api/users', { method: 'POST', body: { username: m.querySelector('#nu').value.trim(), password: m.querySelector('#np').value, role: m.querySelector('#nr').value } });
        close(); onDone();
      } catch (err) { m.querySelector('#e').textContent = err.message; }
    };
  });
}

function resetModal(id, name) {
  modal(`
    <h2>Nuova password per ${esc(name)}</h2>
    <form id="f">
      <div class="field"><label for="rp">Nuova password</label><input id="rp" type="text" minlength="8" required autocomplete="off"><small>L'utente verrà disconnesso da tutti i dispositivi.</small></div>
      <div class="err" id="e"></div>
      <div class="modal-actions"><button type="button" data-close>Annulla</button><button class="primary">Imposta password</button></div>
    </form>`, (m, close) => {
    m.querySelector('#rp').value = randomPassword();
    m.querySelector('#f').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api(`/api/users/${id}`, { method: 'PATCH', body: { password: m.querySelector('#rp').value } });
        if (Number(id) === state.me.user.id) state.me = await api('/api/me');
        close();
      } catch (err) { m.querySelector('#e').textContent = err.message; }
    };
  });
}

function randomPassword() {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const a = new Uint32Array(14);
  crypto.getRandomValues(a);
  return Array.from(a, (n) => chars[n % chars.length]).join('');
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
async function route() {
  try {
    if (!state.me) state.me = await api('/api/me');
    if (!state.me.authenticated) return renderLogin();
    const h = location.hash || '#/';
    let m;
    if ((m = h.match(/^#\/server\/(\d+)/))) {
      if (state.lastServer !== m[1]) { state.selectedApp = null; state.lastServer = m[1]; }
      return await renderServer(m[1]);
    }
    if (h.startsWith('#/analysis')) return await renderAnalysis();
    if (h.startsWith('#/portali')) return await renderPortals();
    if (h.startsWith('#/app')) return await renderAllApps();
    if (h.startsWith('#/archivio')) return await renderArchive();
    if (h.startsWith('#/account')) return renderAccount();
    if (h.startsWith('#/users')) return await renderUsers();
    return await renderOverview();
  } catch (e) {
    if (e.message !== 'Sessione scaduta') {
      const main = document.getElementById('main') || $app;
      main.innerHTML = `<div class="card empty-state"><h2>Qualcosa è andato storto</h2><p>${esc(e.message)}</p><button onclick="location.reload()">Riprova</button></div>`;
    }
  }
}

try { const t = localStorage.getItem('zdt-theme'); if (t) document.documentElement.dataset.theme = t; } catch { /* ignore */ }
window.addEventListener('hashchange', route);
route();
