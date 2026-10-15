#!/usr/bin/env bash
# Mengisi satu nilai rahasia di /opt/wanar-ai/.env LANGSUNG di terminal (tidak tampil,
# tidak masuk riwayat shell, tidak lewat chat), lalu me-restart layanan.
#
# Pakai:  bash set-secret.sh CLOUVIA_API_KEY [pola-awalan-yang-diharapkan]
#   mis.  bash set-secret.sh CLOUVIA_API_KEY clv_live_
#
#   scp scripts/deploy/set-secret.sh legionasharparfum@103.197.189.21:/tmp/
#   ssh -t legionasharparfum@103.197.189.21 "bash /tmp/set-secret.sh CLOUVIA_API_KEY clv_live_; rm -f /tmp/set-secret.sh"
set -euo pipefail

NAME="${1:-}"; PREFIX="${2:-}"
ENV_FILE="${ENV_FILE:-/opt/wanar-ai/.env}"
SERVICE="${SERVICE:-wanar}"

[[ "$NAME" =~ ^[A-Z][A-Z0-9_]{2,60}$ ]] || { echo "Nama variabel tidak valid. Contoh: CLOUVIA_API_KEY"; exit 1; }
# Folder aplikasi hanya bisa dibuka user layanan (izin 750), jadi semua akses file lewat sudo.
SUDO="sudo"
$SUDO test -f "$ENV_FILE" || { echo "File $ENV_FILE tidak ditemukan"; exit 1; }

read -rsp "$NAME: " VAL; echo
VAL="$(printf '%s' "$VAL" | tr -d '[:cntrl:][:space:]')"   # buang karakter tak terlihat / spasi
[ -n "$VAL" ] || { echo "Kosong. Tidak ada yang diubah."; exit 1; }
if [ -n "$PREFIX" ] && [[ "$VAL" != "$PREFIX"* ]]; then
  echo "Nilai tidak diawali \"$PREFIX\". Tidak ada yang diubah."; exit 1
fi

TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
$SUDO grep -vE "^${NAME}=" "$ENV_FILE" > "$TMP" || true
printf '%s=%s\n' "$NAME" "$VAL" >> "$TMP"

$SUDO cp "$ENV_FILE" "$ENV_FILE.bak.$(date +%Y%m%d%H%M%S)"
OWN="$($SUDO stat -c '%U:%G' "$ENV_FILE")"
$SUDO install -m 600 -o "${OWN%%:*}" -g "${OWN##*:}" "$TMP" "$ENV_FILE"
echo "OK: $NAME disimpan (panjang ${#VAL} karakter)."

sudo systemctl restart "$SERVICE"
sleep 6
echo "layanan: $(systemctl is-active "$SERVICE")"
