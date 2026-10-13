#!/usr/bin/env bash
# Mengatur email Wanar AI di VPS: Brevo (kirim) + IMAP (pantau balasan).
# Nilai diketik langsung di terminal ini — tidak disimpan di riwayat shell,
# tidak ditampilkan, dan hanya ditulis ke /opt/wanar-ai/.env (chmod 600).
#
# Pakai (dari laptop):
#   scp scripts/deploy/set-mail.sh legionasharparfum@103.197.189.21:/tmp/
#   ssh -t legionasharparfum@103.197.189.21 "bash /tmp/set-mail.sh; rm -f /tmp/set-mail.sh"
set -euo pipefail

ENV_FILE="${ENV_FILE:-/opt/wanar-ai/.env}"
SERVICE="${SERVICE:-wanar}"

[ -f "$ENV_FILE" ] || { echo "File $ENV_FILE tidak ditemukan"; exit 1; }
SUDO=""; [ -w "$ENV_FILE" ] || SUDO="sudo"

ask() { # ask VAR "Pertanyaan" secret(0|1) [default]
  local var="$1" prompt="$2" secret="$3" def="${4:-}" val=""
  if [ "$secret" = "1" ]; then
    read -rsp "$prompt: " val; echo
  else
    read -rp "$prompt${def:+ [$def]}: " val
  fi
  val="${val:-$def}"
  printf -v "$var" '%s' "$val"
}

ask BREVO_KEY  "Brevo API key (xkeysib-...)"                     1
ask GMAIL      "Alamat Gmail pengirim & mailbox (mis. nama@gmail.com)" 0
ask FROM_NAME  "Nama pengirim"                                    0 "Wisnu Alfian Nur Ashar"
ask APP_PASS   "Sandi aplikasi Google (16 huruf, spasi boleh)"   1
APP_PASS="${APP_PASS// /}"

case "$BREVO_KEY" in xkeysib-*) ;; *) echo "API key Brevo harus diawali xkeysib-"; exit 1;; esac
case "$GMAIL" in *@*.*) ;; *) echo "Alamat email tidak valid"; exit 1;; esac
[ "${#APP_PASS}" -eq 16 ] || { echo "Sandi aplikasi harus 16 karakter (sekarang ${#APP_PASS})"; exit 1; }

TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
# Buang entri lama untuk key yang akan diatur, lalu tambahkan yang baru.
$SUDO grep -vE '^(BREVO_API_KEY|MAIL_FROM|IMAP_HOST|IMAP_PORT|IMAP_USER|IMAP_PASS|EMAIL_WATCH)=' "$ENV_FILE" > "$TMP" || true
{
  echo "BREVO_API_KEY=$BREVO_KEY"
  echo "MAIL_FROM=\"$FROM_NAME <$GMAIL>\""
  echo "IMAP_HOST=imap.gmail.com"
  echo "IMAP_PORT=993"
  echo "IMAP_USER=$GMAIL"
  echo "IMAP_PASS=$APP_PASS"
} >> "$TMP"

$SUDO cp "$ENV_FILE" "$ENV_FILE.bak.$(date +%Y%m%d%H%M%S)"
OWN="$(stat -c "%U:%G" "$ENV_FILE")"
$SUDO install -m 600 -o "${OWN%%:*}" -g "${OWN##*:}" "$TMP" "$ENV_FILE"
echo "✓ .env diperbarui (cadangan: $ENV_FILE.bak.*)"

sudo systemctl restart "$SERVICE"
sleep 6
echo "--- status ---"
systemctl is-active "$SERVICE"
journalctl -u "$SERVICE" -n 60 --no-pager | grep -E "Email Desk|Telegram   :|rror" | tail -5 || true
echo
echo "Langkah di Brevo yang masih perlu kamu cek:"
echo "  1) Senders: $GMAIL sudah terverifikasi"
echo "  2) SMTP & API > Authorized IPs: $(curl -s -m 5 https://api.ipify.org 2>/dev/null || echo 103.197.189.21) sudah ditambahkan"
