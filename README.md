# ZeroDark Console

Console leggera per monitorare i server e le app ospitate (OPS), capire se serve **allargare il servizio** e ottenere le
**N combinazioni ideali** di distribuzione app → server. Espone lo stesso input in JSON per il tool AI esterno che si occupa
del riassortimento.

- **Zero dipendenze npm**: Node ≥ 22.13 (`node:http` + `node:sqlite` integrato).
- **Agent senza dipendenze**: Python 3 standard library, legge `/proc` e cgroup v2 (Docker e systemd).
- **Rolling retention**: i dati più vecchi di `RETENTION_DAYS` (default 30) vengono cancellati ogni ora, quindi il DB non cresce oltre la finestra.

```
┌──────────── server 1..N ────────────┐          ┌──────── console.zerodarkteam.it ────────┐
│ zdt-agent (systemd, ogni 60s)       │  HTTPS   │ Caddy (TLS) → console (Node + SQLite)   │
│  • CPU, RAM, swap, disco, rete,     │ ───────▶ │  • dashboard server/app                 │
│    load, iowait, steal, TCP …       │          │  • analisi capacità + combinazioni      │
│  • CPU/RAM per app (docker/systemd/ │ ◀─────── │  • coda task (crea/rimuovi app)         │
│    processo)                        │  config  │  • /api/v1/export  ──▶  tool AI         │
│  • esegue hook create_app/remove_app│  + task  └─────────────────────────────────────────┘
└─────────────────────────────────────┘
```

## Funzionalità

| Area | Cosa fa |
|---|---|
| **Server** | Card con CPU/RAM/disco e stato, dettaglio con grafici 1h → 30g (CPU, RAM, disco, rete, load), swap, iowait/steal, connessioni TCP, uptime. |
| **App** | CPU (in core) e RAM per app, attuali e ultime 24h, grafici per app. Le app definite nell'agent si registrano da sole. |
| **Crea app (portale)** | Dal dettaglio server → *Nuova app*: nome, tipo, Docker/systemd/processo, dominio, porta, template. La console mette in coda un task, l'agent esegue l'hook `create_app` sul server e riporta l'esito. |
| **Capacità** | Per server: p95 CPU/RAM, disco e crescita giornaliera, giorni alla saturazione (regressione sul p95 giornaliero), consumo "base" non attribuito alle app, indicazioni (aggiungi vCPU/RAM, disco pieno, swap, sottoutilizzo). |
| **Combinazioni** | Simula le distribuzioni app → server **sommando le serie storiche** (non i singoli picchi: app con picchi in orari diversi possono convivere), più il consumo base di ogni server. Ordina per picco massimo, bilanciamento e numero di spostamenti. Se nessuna distribuzione resta sotto soglia, riprova con un **server aggiuntivo** e stima le risorse mancanti → verdetto *serve allargare*. |
| **Export AI** | `GET /api/v1/export?days=30&headroom=0.8&n=5` con `Authorization: Bearer $EXPORT_TOKEN`: server, app, percentili, trend, profili orari 0–23, distribuzione attuale e combinazioni. Schema `zerodark.console.capacity/v1`. |

## Avvio rapido in locale

```bash
npm run seed   # opzionale: 30 giorni di dati demo (3 server, 9 app)
npm run dev    # http://localhost:8080  password: admin
npm test
```

## Pubblicazione su console.zerodarkteam.it

1. **DNS**: record `A` `console.zerodarkteam.it` → IP del server.
2. Copia il codice sul server (es. in `/opt/zerodark-console`) ed esegui come root:
   ```bash
   cd /opt/zerodark-console/deploy && bash setup.sh
   ```
   Lo script è idempotente: installa Docker se manca, crea `.env` con password e token casuali, e sceglie da solo la modalità:
   - **porte 80/443 libere** → console + Caddy con HTTPS automatico;
   - **nginx o Apache già attivi** (es. il sito principale sullo stesso server) → console su `127.0.0.1:8088`,
     virtual host aggiunto al web server esistente e certificato Let's Encrypt con certbot;
   - **Plesk o altro** → console su `127.0.0.1:8088` e istruzioni per il proxy.

   Variabili opzionali: `DOMAIN`, `CONSOLE_PORT`, `EMAIL` (per Let's Encrypt).
3. **Deploy automatico (opzionale)**: il workflow `.github/workflows/deploy.yml` esegue i test e, a ogni push su `main`,
   sincronizza il codice via SSH e rilancia `setup.sh`, se sono presenti i secret `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY` (opz. `DEPLOY_PATH`, default `/opt/zerodark-console`).

Senza Docker: `ADMIN_PASSWORD=... PUBLIC_URL=https://console.zerodarkteam.it npm start` dietro un reverse proxy HTTPS.

### Variabili d'ambiente

| Variabile | Default | |
|---|---|---|
| `ADMIN_PASSWORD` | generata e stampata nei log al primo avvio | password della dashboard |
| `EXPORT_TOKEN` | — | token Bearer per il tool AI (`/api/v1/export`) |
| `RETENTION_DAYS` | `30` | finestra rolling dei dati |
| `AGENT_INTERVAL` | `60` | secondi tra un invio e l'altro (comunicato agli agent) |
| `HEADROOM` | `0.8` | soglia dei picchi usata dal motore delle combinazioni |
| `OFFLINE_AFTER` | `300` | secondi senza dati prima di segnare un server offline |
| `PUBLIC_URL` | dall'header Host | URL usato nei comandi di installazione |
| `DB_FILE` | `data/console.db` | percorso del database SQLite |
| `TZ` | — | fuso orario per i profili orari (es. `Europe/Rome`) |

## Agent

Nella console: **Aggiungi server** → copia il comando mostrato (il token compare una sola volta) ed eseguilo sul server:

```bash
curl -fsSL https://console.zerodarkteam.it/install.sh | sudo ZDT_URL=https://console.zerodarkteam.it ZDT_TOKEN=<token> bash
```

Installa `/opt/zdt-agent/zdt-agent.py` come servizio systemd `zdt-agent`. Se la console non è raggiungibile l'agent
accumula fino a 24h di campioni e li reinvia. Configurazione in `/etc/zdt-agent/config.json`:

```json
{
  "url": "https://console.zerodarkteam.it",
  "token": "…",
  "disk_paths": ["/", "/srv"],
  "hooks_dir": "/etc/zdt-agent/hooks",
  "apps": [
    { "name": "ops-acme", "kind": "docker",  "match": "^ops-acme-" },
    { "name": "ops-api",  "kind": "systemd", "match": "ops-api.service" },
    { "name": "ops-job",  "kind": "process", "match": "java .*ops-job\\.jar" }
  ]
}
```

- `docker`: regex sui nomi dei container (somma di tutti i container che corrispondono)
- `systemd`: nome della unit (cgroup v2)
- `process`: regex sulla command line dei processi

Test locale senza inviare nulla: `python3 zdt-agent.py --print`.

### Creazione app (hook)

Quando crei un'app dalla console con *Crea l'app sul server* attivo, l'agent esegue `/etc/zdt-agent/hooks/create_app`
(e `remove_app` alla rimozione) con queste variabili: `ZDT_APP_NAME`, `ZDT_APP_TYPE`, `ZDT_APP_KIND`, `ZDT_APP_MATCH`,
`ZDT_APP_DOMAIN`, `ZDT_APP_PORT`, `ZDT_APP_TEMPLATE`. Exit code 0 = successo, l'output viene mostrato nella console.
Un'ultima riga JSON opzionale (`{"kind":"docker","match":"^nome-"}`) aggiorna come l'app viene monitorata.

La console **non invia mai comandi arbitrari**: esegue solo gli hook che hai installato sul server.
In `agent/hooks/` e `agent/templates/portal/` c'è un esempio basato su `docker compose`. Sostituisci l'immagine con quella del portale OPS:

```bash
sudo cp agent/hooks/* /etc/zdt-agent/hooks/ && sudo chmod +x /etc/zdt-agent/hooks/*
sudo cp -r agent/templates/portal /etc/zdt-agent/templates/
```

## API

| Metodo | Percorso | Auth | |
|---|---|---|---|
| POST | `/api/agent/report` | token server | metriche (`samples[]`) → risposta con `interval`, `apps`, `tasks` |
| POST | `/api/agent/tasks/:id` | token server | esito task `{status: done\|failed, message, app?}` |
| GET | `/api/v1/export` | `EXPORT_TOKEN` o sessione | input per il tool AI |
| GET | `/api/analysis` | sessione | stessa analisi usata dalla dashboard |
| GET/POST/DELETE | `/api/servers…`, `/api/apps…` | sessione | gestione server e app |

## Struttura

```
server/index.js       HTTP, auth, API, ingest, coda task
server/db.js          schema SQLite + retention rolling
server/analytics.js   capacità, trend, motore delle combinazioni
server/public/        dashboard (HTML/CSS/JS vanilla, grafici SVG)
agent/                agent Python, installer, hook e template di esempio
deploy/               setup.sh, docker compose (Caddy o dietro nginx/Apache)
scripts/seed-demo.js  dati demo
test/                 test (node --test)
```
