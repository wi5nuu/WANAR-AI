#!/usr/bin/env bash
# Mengaktifkan Cloudflare Tunnel di VPS (koneksi KELUAR ke Cloudflare, tanpa jabat tangan masuk).
# Token diminta lewat prompt tersembunyi: tidak tampil, tidak masuk riwayat shell, tidak lewat chat.
#
# Sebelum menjalankan, di dashboard Cloudflare:
#   Zero Trust -> Networks -> Tunnels -> Create tunnel (Cloudflared) -> beri nama "wanar-vps"
#   -> salin TOKEN (string panjang berawalan "eyJ"), lalu di tab "Public Hostname" tambahkan:
#        Hostname : wanarai.ashargrosirparfum.com
#        Service  : HTTPS  ->  localhost:443
#        Additional settings -> TLS -> "Origin Server Name" = wanarai.ashargrosirparfum.com
#      (nginx tetap di depan aplikasi sehingga login basic-auth tetap berlaku)
#
# Pakai:  ssh -t USER@VPS "bash /tmp/setup-tunnel.sh"
set -euo pipefail

command -v cloudflared >/dev/null 2>&1 || { echo "cloudflared belum terpasang."; exit 1; }

read -rsp "Token tunnel Cloudflare: " TOKEN; echo
TOKEN="$(printf '%s' "$TOKEN" | tr -d '[:cntrl:][:space:]')"
[ -n "$TOKEN" ] || { echo "Kosong. Tidak ada yang diubah."; exit 1; }
# a pasted `cloudflared service install <token>` command is fine: keep only the token
TOKEN="${TOKEN##*install}"
if [[ ! "$TOKEN" =~ ^eyJ[A-Za-z0-9_=-]{40,}$ ]]; then
  echo "Ini bukan token tunnel (harus berawalan 'eyJ' dan panjang). Tidak ada yang diubah."; exit 1
fi

sudo cloudflared service uninstall >/dev/null 2>&1 || true
sudo cloudflared service install "$TOKEN"
sleep 6
echo "layanan cloudflared: $(systemctl is-active cloudflared)"
sudo journalctl -u cloudflared --since '-1 min' --no-pager | grep -iE 'Registered tunnel|connection|error|ERR' | tail -5 | cut -c1-160 || true
echo
echo "Langkah berikutnya (di dashboard Cloudflare):"
echo "  - DNS: record wanarai.ashargrosirparfum.com harus mengarah ke tunnel (dibuat otomatis oleh Public Hostname)."
echo "  - Setelah tes https://wanarai.ashargrosirparfum.com stabil, port 80/443 'Anywhere' di UFW boleh ditutup."
