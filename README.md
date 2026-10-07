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

   Su zerodarkserver la console sta dietro il Caddy del gestionale (`zd-proxy`, rete `gestionale_default`, `PROXY_NETWORK` nel `.env`).
   Il suo sito è in **`/opt/gestionale/siti/locale.caddy`**, non nel Caddyfile del gestionale: se va cambiato, si cambia lì (poi `zd restart proxy`).
3. **Deploy automatico (opzionale)**: il workflow `.github/workflows/deploy.yml` esegue i test e, a ogni push su `main`,
   sincronizza il codice via SSH e rilancia `setup.sh`, se sono presenti i secret `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY` (opz. `DEPLOY_PATH`, default `/opt/zerodark-console`).

Senza Docker: `ADMIN_PASSWORD=... PUBLIC_URL=https://console.zerodarkteam.it npm start` dietro un reverse proxy HTTPS.

### Variabili d'ambiente

| Variabile | Default | |
|---|---|---|
| `ADMIN_PASSWORD` | generata e stampata nei log al primo avvio | password iniziale dell'utente `admin`, usata solo al primo avvio |
| `EXPORT_TOKEN` | — | token Bearer per il tool AI (`/api/v1/export`) |
| `RETENTION_DAYS` | `30` | finestra rolling dei dati |
| `AGENT_INTERVAL` | `60` | secondi tra un invio e l'altro (comunicato agli agent) |
| `HEADROOM` | `0.8` | soglia dei picchi usata dal motore delle combinazioni |
| `OFFLINE_AFTER` | `300` | secondi senza dati prima di segnare un server offline |
| `PUBLIC_URL` | dall'header Host | URL usato nei comandi di installazione |
| `DB_FILE` | `data/console.db` | percorso del database SQLite |
| `PORTAL_DOMAIN` | `zerodarkteam.it` | dominio dei portali creati senza dominio esplicito |
| `CREDENTIALS_KEY` | creata da `setup.sh` | chiave di cifratura delle password del primo accesso: non cambiarla mai |
| `HEALTH_INTERVAL` | `300` | secondi tra i controlli `https://<dominio>/login` dei portali (0 = spento) |
| `UPDATE_HOUR` | `4` | ora locale degli aggiornamenti automatici dei gestionali |
| `TIME_ZONE` | `Europe/Rome` | fuso orario di `UPDATE_HOUR` |
| `VERSIONS_INTERVAL` | `3600` | secondi tra una richiesta `list_versions` e l'altra a ogni server |
| `RELEASES_URL` | `https://github.com/whiskas85/team-management/releases/tag/v` | link alle novità di una versione |
| `TZ` | — | fuso orario per i profili orari (es. `Europe/Rome`) |

## Utenti

Al primo avvio viene creato l'utente **admin** con la password `ADMIN_PASSWORD`. Da lì in poi gli utenti vivono nel database:

- **Il mio account** (clic sul proprio nome in alto): cambio di nome utente e password, sempre con conferma della password attuale.
- **Utenti** (solo amministratori): crea utenti, cambia ruolo, reimposta password, elimina.
- Ruoli: **Amministratore** (gestisce server, app e utenti) e **Sola lettura** (vede dashboard e analisi).
- Un cambio di password disconnette le altre sessioni di quell'utente. Deve sempre restare almeno un amministratore.

Password dimenticata, dal server:

```bash
docker exec -it zerodark-console-console-1 node server/cli.js reset-password <utente>   # stampa una password nuova
docker exec -it zerodark-console-console-1 node server/cli.js list-users
```

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

### Portali del gestionale

Gli script veri stanno nel repository del gestionale (`whiskas85/team-management`, cartella `deploy/console-hooks/`, dettagli in `deploy/DEPLOY.md` → «Dalla console ZeroDark»). Sul server si installano una volta:

```bash
ln -sf /opt/gestionale/deploy/console-hooks/create_app /etc/zdt-agent/hooks/create_app
ln -sf /opt/gestionale/deploy/console-hooks/remove_app /etc/zdt-agent/hooks/remove_app
ln -sf /opt/gestionale/deploy/console-hooks/purge_app /etc/zdt-agent/hooks/purge_app
ln -sf /opt/gestionale/deploy/console-hooks/set_admin_password /etc/zdt-agent/hooks/set_admin_password
```

Dalla console, **Nuova app → Portale**: nome (minuscole, numeri, trattini; `ops`, `test*` e `www` sono riservati, per una prova `demo`), dominio (vuoto = `<nome>.zerodarkteam.it`, configurabile con `PORTAL_DOMAIN`) e il **proprietario**, cioè il primo amministratore: nome, cognome, data di nascita, telefono ed email (all'hook come `ZDT_APP_FIRST_NAME`, `ZDT_APP_LAST_NAME`, `ZDT_APP_BIRTH_DATE` in formato `AAAA-MM-GG`, `ZDT_APP_PHONE`, `ZDT_APP_EMAIL`, e nel JSON su stdin). Si possono correggere da **Modifica**. L'app viene monitorata da subito sui container `^zd-sq-<nome>-`. La password dell'admin resta sul server in `/opt/squadra-<nome>/ACCESSO.txt`. Ogni 5 minuti (`HEALTH_INTERVAL`) la console verifica che `https://<dominio>/login` risponda 200 e lo mostra nella tabella delle app.

#### Password del primo accesso

Per i portali creati dalla console, la password iniziale dell'admin la **sceglie la console**: 16 caratteri senza simboli ambigui, salvati cifrati (AES-256-GCM, chiave `CREDENTIALS_KEY` nel `.env`, fuori dal database). Arriva a `create_app` come `ZDT_APP_ADMIN_PASSWORD` (e nel JSON su stdin come `admin_password`), aggiunta solo al momento della consegna: non è mai nei task, nei messaggi o nei log.

Contratto per `create_app`: usare `ZDT_APP_ADMIN_PASSWORD`, se presente, come password dell'admin di partenza (utente `ZDT_APP_EMAIL`), non stamparla mai, e confermarlo nell'ultima riga JSON con `"admin_password": "applied"`. Senza la conferma la console non mostra nessuna password, perché potrebbe essere sbagliata.

In console il pulsante **🔑 Accesso iniziale** del portale (solo amministratori; ogni visualizzazione viene registrata) mostra indirizzo, utente e password con *Mostra*, *Copia password* e *Copia messaggio per il cliente*. Quando il proprietario è entrato si preme **Accesso fatto**: la password sparisce dalla console e il pulsante diventa **🔑 Recupera password**.

**Recupera password** serve quando la console non conosce la password (portale creato prima di questo contratto, `create_app` che ha scelto la sua) o il proprietario l'ha persa. La console genera una password nuova e mette in coda l'hook `set_admin_password` con `ZDT_APP_NAME`, `ZDT_APP_DOMAIN`, `ZDT_APP_EMAIL` e `ZDT_APP_ADMIN_PASSWORD`; la finestra si aggiorna da sola e la mostra appena il server l'ha applicata, con un messaggio di recupero per il cliente. Contratto: impostare quella password all'utente admin della squadra (e solo a lui), non stamparla mai, e confermarlo nell'ultima riga JSON con `{"admin_password": "applied"}`. Senza la conferma la console mostra l'errore e non la password.

#### Aggiornamenti dei gestionali

Ogni squadra ha la sua versione del gestionale. Il lavoro rischioso lo fa il server (hook `update_app` → `squadra-server.sh aggiorna`: backup, cambio, controllo, ritorno automatico alla versione di prima se non risponde); la console decide **cosa e quando**.

- **Versione in uso**: dal controllo del sito (`GET https://<dominio>/api/stato`, dal gestionale 3.25) oppure, per le squadre più vecchie, da `list_versions <nome>`.
- **Versioni pronte sul server**: hook `list_versions`, chiesto da sola dalla console ogni ora (`VERSIONS_INTERVAL`), subito dopo ogni aggiornamento e appena un portale (di solito la produzione appena rilasciata) gira una versione più nuova di quelle note.
- **Aggiorna** (riga del portale): scegli la versione (anche una precedente), con il link alle novità. **Aggiorna tutti** porta alla più recente ogni squadra indietro.
- **Aggiornamento** (colonna nella scheda Portali): *Automatico* o *Manuale*, si cambia dalla finestra **Aggiorna**.
- **Aggiornamento automatico** (per portale): ogni notte alle `UPDATE_HOUR` alla versione più recente. Una versione che è già tornata indietro non viene ritentata da sola.
- Un aggiornamento alla volta per server. Storico per portale, con l'output dello script quando non riesce.

Solo i gestionali delle squadre (`zd-sq-*`); gli ambienti di test seguono il loro rilascio.

#### Il nostro gestionale: «zerodark»

Dal gestionale 3.29.0 anche `ops.zerodarkteam.it` è una squadra ospitata, **`zerodark`** (container `zd-sq-zerodark-*`), con gli stessi hook (versioni, aggiornamenti, password). Il database di tutte le squadre sta nel Postgres comune `zd-sq-pg`, monitorato come servizio **postgres-squadre**. All'avvio la console crea da sola l'app `zerodark` sul server dove girava la vecchia produzione (`zd-app`/`zd-db`) e sposta quella vecchia nell'Archivio come *non monitorata*.

`zerodark` è segnata **Produzione** e dalla console non si archivia né si elimina: anche gli script del server lo rifiutano senza `FORZA=1`. Il nome è riservato (`OWN_SQUAD`, dominio `OWN_DOMAIN`, default `ops.<PORTAL_DOMAIN>`).

#### Rimozione, archivio ed eliminazione definitiva

- **Rimuovi → Archivia** (solo portali creati dalla console, scrivendo il nome per conferma): esegue `remove_app` (`squadra-server.sh rimuovi`: backup finale, container tolti, sito staccato, cartella in `/opt/archivio`, volumi conservati). Il portale passa nella scheda **Archivio**, con la cartella letta dall'output dello script.
- **Archivio → Elimina definitivamente** (nome da riscrivere): esegue l'hook `purge_app` con `ZDT_APP_NAME` e `ZDT_APP_ARCHIVE_PATH`. Contratto: cancellare i volumi `gestionale-sq-<nome>_*` e la cartella archiviata, rifiutare i nomi riservati (`ops`, `test*`, `www`), uscire con 0 solo se ha cancellato tutto. Se l'hook manca o fallisce, il portale resta nell'archivio e niente viene toccato.
- Le app non create dalla console si possono solo smettere di monitorare.

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
