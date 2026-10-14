#!/usr/bin/env bash
# Mengatur ulang login (username + password) untuk https://wanarai.ashargrosirparfum.com
# dan LANGSUNG mengujinya, sehingga kamu tahu pasti login-nya berhasil.
#
# Password diketik di terminal ini: tidak tampil, tidak masuk riwayat shell,
# tidak dikirim ke mana pun selain disimpan sebagai hash di /etc/nginx/.htpasswd-wanar.
#
# Pakai (dari laptop):
#   scp scripts/deploy/reset-web-login.sh legionasharparfum@103.197.189.21:/tmp/
#   ssh -t legionasharparfum@103.197.189.21 "bash /tmp/reset-web-login.sh; rm -f /tmp/reset-web-login.sh"
set -euo pipefail

FILE="${HTPASSWD_FILE:-/etc/nginx/.htpasswd-wanar}"
HOST="${WEB_HOST:-wanarai.ashargrosirparfum.com}"

command -v openssl >/dev/null || { echo "openssl tidak ditemukan"; exit 1; }

read -rp "Username [wanar]: " USER_NAME
USER_NAME="${USER_NAME:-wanar}"
case "$USER_NAME" in *[!A-Za-z0-9._-]*) echo "Username hanya boleh huruf, angka, titik, minus, underscore."; exit 1;; esac

read -rsp "Password baru (min 10 karakter): " P1; echo
read -rsp "Ulangi password: " P2; echo
P1="${P1%$'\r'}"; P2="${P2%$'\r'}"
[ "$P1" = "$P2" ] || { echo "Password tidak sama. Tidak ada yang diubah."; exit 1; }
[ "${#P1}" -ge 10 ] || { echo "Password terlalu pendek (min 10). Tidak ada yang diubah."; exit 1; }

HASH="$(printf '%s' "$P1" | openssl passwd -apr1 -stdin)"
case "$HASH" in '$apr1$'*) ;; *) echo "Gagal membuat hash"; exit 1;; esac

TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
printf '%s:%s\n' "$USER_NAME" "$HASH" > "$TMP"

[ -f "$FILE" ] && sudo cp "$FILE" "$FILE.bak.$(date +%Y%m%d%H%M%S)"
sudo install -m 640 -o root -g www-data "$TMP" "$FILE"
sudo nginx -t 2>&1 | tail -1
sudo systemctl reload nginx
echo "File login diperbarui dan nginx dimuat ulang."

# --- uji sungguhan lewat nginx (bukan sekadar menebak) ---------------------
probe() { # probe user pass -> http code
  local u="$1" p="$2"
  p="${p//\\/\\\\}"; p="${p//\"/\\\"}"
  printf 'user = "%s:%s"\n' "$u" "$p" | curl -sk -K - -o /dev/null -m 15 -w '%{http_code}' \
    --resolve "$HOST:443:127.0.0.1" "https://$HOST/api/health" || true
}

OK="$(probe "$USER_NAME" "$P1")"
BAD="$(probe "$USER_NAME" "${P1}x")"
echo "Uji password benar : HTTP $OK  (harus 200)"
echo "Uji password salah : HTTP $BAD  (harus 401)"
if [ "$OK" = "200" ] && [ "$BAD" = "401" ]; then
  echo
  echo "BERHASIL. Masuk di https://$HOST dengan username \"$USER_NAME\" dan password yang barusan kamu ketik."
  echo "Jika browser masih menolak, hapus data login tersimpan: buka halaman dalam jendela Incognito."
else
  echo
  echo "Ada yang tidak sesuai harapan. Kirim 3 baris hasil uji di atas ke Claude."
  exit 1
fi
