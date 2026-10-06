#!/usr/bin/env bash
# One-shot, idempotent installer for ZeroDark Console. Run as root from the deploy/ directory:
#   cd /opt/zerodark-console/deploy && bash setup.sh
#
# - installs Docker if missing
# - creates .env with random ADMIN_PASSWORD / EXPORT_TOKEN (only the first time)
# - if ports 80/443 are free: starts console + Caddy (automatic HTTPS)
# - if nginx or Apache already serve 80/443 (e.g. the main website): starts the console on 127.0.0.1
#   and adds a virtual host + Let's Encrypt certificate to the existing web server
set -euo pipefail

cd "$(dirname "$0")"
DOMAIN="${DOMAIN:-console.zerodarkteam.it}"
CONSOLE_PORT="${CONSOLE_PORT:-8088}"
EMAIL="${EMAIL:-}"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mERRORE: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "esegui come root"

# --- Docker -----------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  say "Installo Docker"
  curl -fsSL https://get.docker.com | sh
fi
if ! docker compose version >/dev/null 2>&1; then
  say "Installo il plugin docker compose"
  (apt-get update -qq && apt-get install -y -qq docker-compose-plugin) || (dnf install -y docker-compose-plugin) || die "installa docker compose a mano"
fi
systemctl enable --now docker >/dev/null 2>&1 || true

# --- .env ---------------------------------------------------------------------
rnd() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' | cut -c1-40; }
if [ ! -f .env ]; then
  say "Creo .env con password e token casuali"
  sed -e "s/^DOMAIN=.*/DOMAIN=$DOMAIN/" \
      -e "s/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=$(rnd)/" \
      -e "s/^EXPORT_TOKEN=.*/EXPORT_TOKEN=$(rnd)/" .env.example > .env
  chmod 600 .env
fi
grep -q '^CONSOLE_PORT=' .env || echo "CONSOLE_PORT=$CONSOLE_PORT" >> .env
CONSOLE_PORT="$(grep '^CONSOLE_PORT=' .env | cut -d= -f2)"
DOMAIN="$(grep '^DOMAIN=' .env | cut -d= -f2)"

# --- Who owns 80/443? -----------------------------------------------------------
owner="$(ss -ltnpH 2>/dev/null | awk '$4 ~ /:(80|443)$/' | grep -o 'users:(("[^"]*"' | head -1 | cut -d'"' -f2 || true)"
# our own Caddy from a previous run counts as "free"
if [ -n "$owner" ] && docker compose ps --status running --services 2>/dev/null | grep -qx caddy; then owner=""; fi
[ -d /usr/local/psa ] && owner="plesk"
say "Porte 80/443: ${owner:-libere}"

proxy_mode() {
  say "Avvio la console su 127.0.0.1:$CONSOLE_PORT"
  docker compose down --remove-orphans >/dev/null 2>&1 || true
  local files=(-f docker-compose.proxy.yml)
  # Re-join the existing reverse proxy's network (kept in .env) so updates do not break the published site
  if grep -q '^PROXY_NETWORK=.' .env; then
    files+=(-f docker-compose.network.yml)
    say "Collego la console alla rete del proxy: $(grep '^PROXY_NETWORK=' .env | tail -1 | cut -d= -f2)"
  fi
  docker compose "${files[@]}" up -d --build
}

health() {
  for _ in $(seq 1 30); do
    curl -fsS "http://127.0.0.1:$CONSOLE_PORT/healthz" >/dev/null 2>&1 && return 0
    sleep 2
  done
  docker compose -f docker-compose.proxy.yml logs --tail 50 console
  die "la console non risponde su 127.0.0.1:$CONSOLE_PORT"
}

certbot_for() { # $1 = nginx | apache
  if ! command -v certbot >/dev/null 2>&1; then
    say "Installo certbot"
    apt-get update -qq && apt-get install -y -qq certbot "python3-certbot-$1" || die "installa certbot a mano"
  elif ! certbot plugins 2>/dev/null | grep -q "^\* $1"; then
    apt-get install -y -qq "python3-certbot-$1" || true
  fi
  say "Richiedo il certificato HTTPS per $DOMAIN"
  if [ -n "$EMAIL" ]; then
    certbot "--$1" -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect
  else
    certbot "--$1" -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect
  fi
}

case "$owner" in
  "")
    say "Avvio console + Caddy (HTTPS automatico)"
    docker compose -f docker-compose.proxy.yml down >/dev/null 2>&1 || true
    if command -v ufw >/dev/null 2>&1 && ufw status | grep -q active; then ufw allow 80,443/tcp; fi
    docker compose up -d --build
    ;;
  nginx)
    proxy_mode; health
    conf=/etc/nginx/conf.d/zerodark-console.conf
    [ -d /etc/nginx/sites-enabled ] && conf=/etc/nginx/sites-available/zerodark-console
    if [ ! -f "$conf" ]; then
      say "Aggiungo il virtual host nginx $conf"
      sed -e "s/__DOMAIN__/$DOMAIN/g" -e "s/__PORT__/$CONSOLE_PORT/g" nginx-console.conf > "$conf"
      [ -d /etc/nginx/sites-enabled ] && ln -sf "$conf" /etc/nginx/sites-enabled/zerodark-console
    fi
    nginx -t && systemctl reload nginx
    certbot_for nginx
    ;;
  apache2|httpd)
    proxy_mode; health
    dir=/etc/apache2/sites-available
    [ -d "$dir" ] || dir=/etc/httpd/conf.d
    conf="$dir/zerodark-console.conf"
    if [ ! -f "$conf" ]; then
      say "Aggiungo il virtual host Apache $conf"
      sed -e "s/__DOMAIN__/$DOMAIN/g" -e "s/__PORT__/$CONSOLE_PORT/g" apache-console.conf > "$conf"
    fi
    if command -v a2enmod >/dev/null 2>&1; then
      a2enmod -q proxy proxy_http headers
      a2ensite -q zerodark-console
      apachectl configtest && systemctl reload apache2
    else
      apachectl configtest && systemctl reload httpd
    fi
    certbot_for apache
    ;;
  *)
    proxy_mode; health
    if grep -q '^PROXY_NETWORK=.' .env; then
      say "Console collegata al proxy esistente ($owner): nessuna modifica alla sua configurazione"
    else
    cat <<MSG

Le porte 80/443 sono gestite da "$owner": non modifico la sua configurazione.
La console è attiva su http://127.0.0.1:$CONSOLE_PORT. Per pubblicarla:
  - Plesk: crea il sottodominio $DOMAIN, attiva Let's Encrypt, poi in
    "Impostazioni Apache e nginx" > "Direttive nginx aggiuntive" incolla:
        location / {
            proxy_pass http://127.0.0.1:$CONSOLE_PORT;
            proxy_set_header Host \$host;
            proxy_set_header X-Forwarded-Proto \$scheme;
            proxy_set_header X-Forwarded-For \$remote_addr;
        }
  - altri proxy: inoltra $DOMAIN a http://127.0.0.1:$CONSOLE_PORT con l'header X-Forwarded-Proto.
MSG
    fi
    ;;
esac

say "Fatto"
echo "URL:             https://$DOMAIN"
echo "Primo accesso:   utente admin, password $(grep '^ADMIN_PASSWORD=' .env | cut -d= -f2)"
echo "                 (vale solo finché non la cambi da 'Il mio account')"
echo "Token export AI: $(grep '^EXPORT_TOKEN=' .env | cut -d= -f2)"
echo "Password dimenticata: docker exec -it zerodark-console-console-1 node server/cli.js reset-password <utente>"
