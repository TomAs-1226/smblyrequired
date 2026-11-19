#!/usr/bin/env bash
# Sets up (or updates) the Cycle Rush leaderboard on a fresh Oracle Cloud
# Always Free VM running Ubuntu 24.04. Safe to run again: that is how you deploy
# a new version of server.mjs.
#
#   git clone https://github.com/TomAs-1226/smblyrequired.git
#   cd smblyrequired/server/arcade
#   sudo bash deploy/setup.sh api.example.com     # your API hostname
#   sudo bash deploy/setup.sh                     # no domain yet: uses <ip>.sslip.io
#
# Full walkthrough, including the Oracle console steps: docs/ARCADE.md.
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "run with sudo"; exit 1; }
HERE="$(cd "$(dirname "$0")/.." && pwd)"
DOMAIN="${1:-}"
export DEBIAN_FRONTEND=noninteractive

echo "== packages"
apt-get update -q
apt-get install -yq curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https sqlite3 iptables-persistent

if ! command -v node >/dev/null || ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'; then
  echo "== node 24"
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -yq nodejs
fi
node --version

if ! command -v caddy >/dev/null; then
  echo "== caddy"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -yq caddy
fi

echo "== app"
id arcade >/dev/null 2>&1 || useradd --system --home /var/lib/arcade --shell /usr/sbin/nologin arcade
install -d -o root -g root -m 755 /opt/arcade
install -d -o arcade -g arcade -m 750 /var/lib/arcade /var/lib/arcade/backups
install -m 644 "$HERE/server.mjs" "$HERE/main.mjs" "$HERE/package.json" /opt/arcade/
install -m 644 "$HERE/deploy/arcade.service" /etc/systemd/system/arcade.service
systemctl daemon-reload
systemctl enable --now arcade
systemctl restart arcade

echo "== firewall"
# Oracle's Ubuntu images ship iptables rules that REJECT everything but ssh.
# Opening the port in the VCN security list is not enough on its own.
for port in 80 443; do
  if ! iptables -C INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT 2>/dev/null; then
    line=$(iptables -L INPUT --line-numbers | awk '/REJECT/ {print $1; exit}')
    iptables -I INPUT "${line:-1}" -p tcp --dport "$port" -m state --state NEW -j ACCEPT
  fi
done
netfilter-persistent save

echo "== tls"
if [[ -z "$DOMAIN" ]]; then
  ip=$(curl -fsS4 https://ifconfig.me)
  DOMAIN="${ip}.sslip.io"
  echo "no domain given; using $DOMAIN"
fi
sed "s/__DOMAIN__/$DOMAIN/" "$HERE/deploy/Caddyfile.template" > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl reload caddy || systemctl restart caddy

echo "== nightly database copy (keeps 14)"
cat > /etc/cron.daily/arcade-backup <<'CRON'
#!/bin/sh
set -e
sqlite3 /var/lib/arcade/arcade.db ".backup /var/lib/arcade/backups/arcade-$(date +%F).db"
chown arcade:arcade /var/lib/arcade/backups/*.db
ls -1t /var/lib/arcade/backups/arcade-*.db | tail -n +15 | xargs -r rm --
CRON
chmod 755 /etc/cron.daily/arcade-backup

echo "== check"
sleep 2
curl -fsS http://127.0.0.1:8787/api/health && echo
echo
echo "Done. Build the site with:  VITE_ARCADE_API=https://$DOMAIN"
echo "If https://$DOMAIN/api/health does not answer from outside, open TCP 80 and 443"
echo "in the VCN security list (docs/ARCADE.md, step 3)."
