#!/usr/bin/env bash
# ============================================================================
# setup-vps.sh — Setup VPS Ubuntu/Debian RINGAN untuk Wanar AI
#
# Cara pakai (dari Windows PowerShell, tanpa < redirect):
#   .\scripts\deploy\deploy.ps1 -Remote user@103.197.189.21          # deploy + setup
#   ssh user@ip "sudo bash -s" < scripts/deploy/setup-vps.sh          # cmd.exe
#   Get-Content scripts/deploy/setup-vps.sh -Raw | ssh user@ip "sudo bash -s"
#
# Opsi:
#   --dir PATH        direktori aplikasi   (default: /opt/wanar-ai)
#   --port N          port aplikasi        (default: 3000)
#   --with-browser    PASANG Playwright + Chromium (±350 MB) untuk job agent
#   --no-firewall     jangan sentuh ufw
#
# Yang dilakukan (semua idempotent, aman diulang):
#   1. Install Node.js 22 LTS bila belum ada
#   2. Buat swap 2G bila RAM < 2 GB dan belum ada swap
#   3. Install dependensi PRODUKSI saja (tanpa devDep, tanpa Playwright)
#   4. Pasang systemd service (auto-restart, log ke journald + rotasi)
#   5. Batas ukuran journald + logrotate untuk logs/*.log
#   6. Buka port di ufw (hanya bila ufw sudah aktif)
# ============================================================================
set -euo pipefail

APP_DIR="/opt/wanar-ai"
PORT="3000"
APP_USER="wanar"
WITH_BROWSER=0
TOUCH_FIREWALL=1

log()  { printf '\033[1;36m[WANAR]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[WARN ]\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[ERR  ]\033[0m %s\n' "$*" >&2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)          APP_DIR="$2"; shift 2 ;;
    --port)         PORT="$2"; shift 2 ;;
    --with-browser) WITH_BROWSER=1; shift ;;
    --no-firewall)  TOUCH_FIREWALL=0; shift ;;
    -h|--help)      grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) warn "argumen tidak dikenal: $1"; shift ;;
  esac
done

if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO="sudo"; fi
if ! command -v sudo >/dev/null 2>&1 && [ -n "$SUDO" ]; then
  err "Butuh root atau sudo untuk setup"; exit 1
fi

# ── 1. Node.js ─────────────────────────────────────────────────────────────
install_node() {
  log "Install Node.js 22 LTS (NodeSource)..."
  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq ca-certificates curl gnupg >/dev/null
  curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash - >/dev/null 2>&1
  $SUDO apt-get install -y -qq nodejs
}

if ! command -v node >/dev/null 2>&1; then
  install_node
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 18 ]; then
  warn "Node $NODE_MAJOR terlalu tua (butuh >= 18) — reinstall"
  install_node
fi
log "Node $(node -v) + npm $(npm -v)"

# ── 2. Swap (penyelamat VPS RAM kecil) ─────────────────────────────────────
MEM_KB=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
SWAP_KB=$(awk '/SwapTotal/ {print $2}' /proc/meminfo)
if [ "$MEM_KB" -lt 2000000 ] && [ "$SWAP_KB" -eq 0 ]; then
  log "RAM $((MEM_KB/1024))MB tanpa swap → buat swap 2G"
  $SUDO fallocate -l 2G /swapfile 2>/dev/null || $SUDO dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  $SUDO chmod 600 /swapfile
  $SUDO mkswap /swapfile >/dev/null
  $SUDO swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | $SUDO tee -a /etc/fstab >/dev/null
elif [ "$SWAP_KB" -gt 0 ]; then
  log "Swap sudah ada: $((SWAP_KB/1024))MB"
else
  log "RAM $((MEM_KB/1024))MB + swap $((SWAP_KB/1024))MB — cukup"
fi

# ── 3. User sistem + direktori ─────────────────────────────────────────────
if ! id "$APP_USER" >/dev/null 2>&1; then
  log "Buat user sistem '$APP_USER'"
  $SUDO useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
fi
mkdir -p "$APP_DIR"
$SUDO chown -R "$APP_USER:$APP_USER" "$APP_DIR"

if [ ! -f "$APP_DIR/package.json" ]; then
  err "package.json tidak ada di $APP_DIR — jalankan deploy.ps1 dulu"
  exit 1
fi

# ── 4. .env minimal bila belum ada ─────────────────────────────────────────
if [ ! -f "$APP_DIR/.env" ]; then
  warn ".env belum ada — membuat dari .env.example + JWT_SECRET acak"
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  SECRET=$($SUDO openssl rand -hex 32 2>/dev/null || head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n')
  printf '\nNODE_ENV=production\nPORT=%s\nJWT_SECRET=%s\n' "$PORT" "$SECRET" >> "$APP_DIR/.env"
fi

# VPS tidak punya layar — mode browser "visible" pasti gagal & boros.
if grep -q '^BROWSER_VISIBLE=true' "$APP_DIR/.env" 2>/dev/null; then
  warn "BROWSER_VISIBLE=true → dinonaktifkan (VPS headless)"
  $SUDO sed -i 's/^BROWSER_VISIBLE=true/BROWSER_VISIBLE=false/' "$APP_DIR/.env"
fi

# ── 5. Install dependensi PRODUKSI (ringan) ────────────────────────────────
# Jalankan sebagai user aplikasi (atau apa adanya bila sudah root)
run_as_app() {
  if [ "$(id -u)" -eq 0 ]; then
    sudo -u "$APP_USER" env HOME=/tmp "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo -u "$APP_USER" env HOME=/tmp "$@"
  else
    env HOME=/tmp "$@"
  fi
}

log "npm ci --omit=dev --omit=optional (tanpa Playwright/tesseract/pdf-parse)"
cd "$APP_DIR"
if ! run_as_app env PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
     npm ci --omit=dev --omit=optional --no-audit --no-fund; then
  warn "Gagal — kemungkinan prebuild better-sqlite3 tidak tersedia. Install toolchain lalu ulangi."
  $SUDO apt-get install -y -qq build-essential python3 >/dev/null
  run_as_app env PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --omit=dev --omit=optional --no-audit --no-fund
fi

mkdir -p "$APP_DIR/data" "$APP_DIR/logs"
$SUDO chown -R "$APP_USER:$APP_USER" "$APP_DIR/data" "$APP_DIR/logs"

# ── 5b. Opsional: browser untuk job agent ──────────────────────────────────
if [ "$WITH_BROWSER" -eq 1 ]; then
  log "Pasang Playwright + Chromium (opsional, ±350MB)..."
  $SUDO apt-get install -y -qq libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
    libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2 >/dev/null || true
  run_as_app npm i --no-audit --no-fund playwright playwright-core
  run_as_app npx playwright install chromium || warn "playwright install gagal"
fi

# ── 6. systemd service ─────────────────────────────────────────────────────
log "Pasang systemd service: wanar.service"
cat > /tmp/wanar.service <<EOF
[Unit]
Description=Wanar AI - Professional Multi-Provider AI Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
Environment=PORT=$PORT
# .env dibaca sendiri oleh aplikasi (dotenv) — tidak perlu EnvironmentFile
ExecStart=$(command -v node) src/server.js
Restart=on-failure
RestartSec=3
StartLimitIntervalSec=0

# Log ke journald (dirotasi otomatis oleh systemd, tidak memenuhi disk)
StandardOutput=journal
StandardError=journal
SyslogIdentifier=wanar

# Ringan & aman
Nice=5
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=full
ReadWritePaths=$APP_DIR

[Install]
WantedBy=multi-user.target
EOF
$SUDO mv /tmp/wanar.service /etc/systemd/system/wanar.service
$SUDO systemctl daemon-reload
$SUDO systemctl enable wanar >/dev/null 2>&1 || true
$SUDO systemctl restart wanar

# ── 7. Batas log journald (VPS tetap ringan) ───────────────────────────────
$SUDO mkdir -p /etc/systemd/journald.conf.d
cat > /tmp/jwanar.conf <<'EOF'
[Journal]
SystemMaxUse=200M
SystemMaxFileSize=20M
EOF
$SUDO mv /tmp/jwanar.conf /etc/systemd/journald.conf.d/wanar.conf
$SUDO systemctl restart systemd-journald 2>/dev/null || true

# ── 8. Logrotate untuk log file aplikasi ───────────────────────────────────
cat > /tmp/logrotate-wanar <<EOF
$APP_DIR/logs/*.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
EOF
$SUDO mv /tmp/logrotate-wanar /etc/logrotate.d/wanar

# ── 9. Firewall (hanya bila ufw sudah aktif — jangan ubah kebijakan lain) ──
if [ "$TOUCH_FIREWALL" -eq 1 ] && command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then
  log "ufw aktif → izinkan port $PORT"
  $SUDO ufw allow "$PORT/tcp" >/dev/null 2>&1 || true
fi

# ── 10. Verifikasi ─────────────────────────────────────────────────────────
sleep 2
if systemctl is-active --quiet wanar; then
  log "STATUS: aktif ✓"
else
  warn "STATUS: belum aktif — cek: journalctl -u wanar -n 50"
fi

USED=$(du -sh "$APP_DIR" 2>/dev/null | cut -f1)
NODE_MODULES=$(du -sh "$APP_DIR/node_modules" 2>/dev/null | cut -f1)
cat <<EOF

────────────────────────────────────────────────────────
  Wanar AI siap di VPS
  Dir      : $APP_DIR  (total $USED, node_modules $NODE_MODULES)
  URL      : http://$(hostname -I 2>/dev/null | awk '{print $1}'):$PORT
  Service  : sudo systemctl status wanar | restart | stop
  Log      : journalctl -u wanar -f
  RAM      : free -h
  Tambah fitur browser (job agent):
            sudo bash /tmp/setup-vps.sh --with-browser   (jalankan ulang deploy dulu)
────────────────────────────────────────────────────────
EOF
