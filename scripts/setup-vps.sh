#!/usr/bin/env bash
# One-shot provisioning for VPS #2 (Ubuntu 22.04, 768 MB RAM, 1 CPU, 10 GB).
# Idempotent: safe to re-run. Run as root or with sudo.
set -euo pipefail

APP_USER="bptf"
APP_DIR="/home/${APP_USER}/tf2-bptf-bot"
NODE_MAJOR=20

log() { echo -e "\033[1;32m[setup]\033[0m $*"; }

if [[ $EUID -ne 0 ]]; then echo "run as root (sudo)"; exit 1; fi

log "apt update + base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates gnupg git build-essential ufw logrotate

# --- 1 GB swap (the box only has 768 MB RAM) ---
if [[ ! -f /swapfile ]]; then
  log "creating 1G swap"
  fallocate -l 1G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=1024
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -w vm.swappiness=10
  echo 'vm.swappiness=10' > /etc/sysctl.d/99-swappiness.conf
fi

# --- Node 20 LTS via NodeSource ---
if ! command -v node >/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -ne "$NODE_MAJOR" ]]; then
  log "installing Node ${NODE_MAJOR}"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi

log "installing pnpm + pm2"
corepack enable
corepack prepare pnpm@9.12.0 --activate
npm install -g pm2

# --- Redis: 60 MB cap, LRU eviction, NO persistence (coordination cache only) ---
log "installing redis"
apt-get install -y redis-server
REDIS_CONF=/etc/redis/redis.conf
sed -i 's/^# *maxmemory .*/maxmemory 60mb/' "$REDIS_CONF" || true
grep -q '^maxmemory ' "$REDIS_CONF" || echo 'maxmemory 60mb' >> "$REDIS_CONF"
sed -i 's/^# *maxmemory-policy .*/maxmemory-policy allkeys-lru/' "$REDIS_CONF" || true
grep -q '^maxmemory-policy ' "$REDIS_CONF" || echo 'maxmemory-policy allkeys-lru' >> "$REDIS_CONF"
# disable RDB + AOF persistence
sed -i 's/^save /# save /g' "$REDIS_CONF" || true
grep -q '^appendonly no' "$REDIS_CONF" || echo 'appendonly no' >> "$REDIS_CONF"
echo 'save ""' >> "$REDIS_CONF"
systemctl enable redis-server
systemctl restart redis-server

# --- app user ---
if ! id "$APP_USER" >/dev/null 2>&1; then
  log "creating app user ${APP_USER}"
  adduser --disabled-password --gecos "" "$APP_USER"
fi
mkdir -p /var/log/bptf
chown -R "$APP_USER":"$APP_USER" /var/log/bptf

# --- log rotation ---
cat > /etc/logrotate.d/bptf <<'EOF'
/var/log/bptf/*.log {
  daily
  rotate 7
  compress
  delaycompress
  missingok
  notifempty
  copytruncate
}
EOF

# --- Tailscale (private network to the laptop dashboard) ---
if ! command -v tailscale >/dev/null; then
  log "installing tailscale"
  curl -fsSL https://tailscale.com/install.sh | sh
fi
log "run 'tailscale up' manually to authenticate this node"

# --- UFW firewall: SSH + Tailscale only, no public app ports ---
log "configuring ufw"
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow in on tailscale0
ufw --force enable

log "done. Next: clone repo to ${APP_DIR} as ${APP_USER}, create .env, then scripts/deploy.sh"
