#!/usr/bin/env bash
# ZeroDark Console agent installer.
#   curl -fsSL __ZDT_URL__/install.sh | sudo ZDT_URL=__ZDT_URL__ ZDT_TOKEN=<token> bash
set -euo pipefail

ZDT_URL="${ZDT_URL:-__ZDT_URL__}"
: "${ZDT_TOKEN:?Imposta ZDT_TOKEN (lo trovi nella console quando aggiungi il server)}"

[ "$(id -u)" -eq 0 ] || { echo "Esegui come root (sudo)"; exit 1; }
command -v python3 >/dev/null || { echo "python3 richiesto"; exit 1; }

install -d -m 0755 /opt/zdt-agent /etc/zdt-agent /etc/zdt-agent/hooks /etc/zdt-agent/templates /var/lib/zdt-agent
curl -fsSL "$ZDT_URL/agent/zdt-agent.py" -o /opt/zdt-agent/zdt-agent.py
chmod 0755 /opt/zdt-agent/zdt-agent.py

if [ ! -f /etc/zdt-agent/config.json ]; then
  cat > /etc/zdt-agent/config.json <<JSON
{
  "url": "$ZDT_URL",
  "token": "$ZDT_TOKEN",
  "disk_paths": ["/"],
  "hooks_dir": "/etc/zdt-agent/hooks",
  "apps": []
}
JSON
else
  python3 - "$ZDT_URL" "$ZDT_TOKEN" <<'PY'
import json, sys
p = "/etc/zdt-agent/config.json"
c = json.load(open(p)); c["url"], c["token"] = sys.argv[1], sys.argv[2]
json.dump(c, open(p, "w"), indent=2)
PY
fi
chmod 0600 /etc/zdt-agent/config.json

cat > /etc/systemd/system/zdt-agent.service <<UNIT
[Unit]
Description=ZeroDark Console agent
After=network-online.target docker.service
Wants=network-online.target

[Service]
ExecStart=/usr/bin/env python3 /opt/zdt-agent/zdt-agent.py
Restart=always
RestartSec=10
Nice=10

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now zdt-agent
systemctl restart zdt-agent
echo "zdt-agent installato. Log: journalctl -u zdt-agent -f"
echo "Hook di provisioning (creazione app): /etc/zdt-agent/hooks/create_app"
