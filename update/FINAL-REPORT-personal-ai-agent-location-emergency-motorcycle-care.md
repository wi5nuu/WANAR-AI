# LAPORAN AKHIR — Personal AI Agent: Location, Emergency Response & Motorcycle Care

Spec: `update/personal-ai-agent-location-emergency-motorcycle-care.md` · Tanggal laporan: 18 Oktober 2026
Repo: `D:\wanar-ai` (semua perubahan modul ini belum di-commit — lihat §2)

> Aturan yang dipegang di seluruh laporan ini: **tidak ada** API key palsu, data pabrikasi,
> hasil test karangan, atau klaim integrasi yang belum nyata. Status dibedakan tegas:
> Implemented / Tested / Ready for configuration / Blocked / Production-ready.

---

## 1. Ringkasan perubahan & arsitektur

Empat modul baru ditambahkan **mengikuti pola modul existing** (bukan menulis ulang aplikasi):

```
src/location/   store.js (SQLite) · service.js (state machine perjalanan) · geo.js · classify.js
                geocode.js (Nominatim+Overpass, cache+throttle) · quick.js · routes.js · index.js
src/emergency/  store.js · detect.js (skoring deterministik) · service.js (countdown+eskalasi+retry)
                routes.js · index.js
src/vehicle/    store.js · service.js (BBM/odometer/servis) · intervals.js · quick.js · routes.js · index.js
src/memory/     personal-store.js · personal.js · quick.js · routes.js · index.js  (+ tools/location.js)
client/src/components/  Tracking.jsx (dasbor 6 tab) · Tracker.jsx (halaman HP /track) · tracking.css
```

Alur data: **HP/browser menangkap GPS** → `POST /api/location/device/ingest` (token perangkat) →
`LocationService.ingest()` memfilter → state machine membuat perjalanan/berhenti → tiap batch juga
diumpankan ke `EmergencyService.feed()` (best-effort, throttled) → perubahan disiarkan ke dasbor
lewat **SSE `/api/location/events`** (`change`) → halaman memuat ulang data (SSE adalah pola yang
sudah dipakai modul lain di repo ini). Modul kendaraan & memori menyiarkan SSE sendiri
(`/api/vehicle/events`, `/api/memory/events`, `/api/emergency/events`).

Keputusan penting:
- **AI tidak diberi tool darurat apa pun.** Pemicu darurat hanya tombol pemilik (dasbor/`/track`),
  deteksi deterministik, atau balasan "butuh bantuan" atas kejadian berjalan. AI hanya membaca status.
- Deteksi kecelakaan **deterministik murni** (tanpa model AI di jalur keselamatan); tanpa data
  akselerometer, skor maksimum berhenti di tingkat "watch" dan itu dilaporkan apa adanya.
- Geocoding & peta memakai layanan gratis OSM (Nominatim/Overpass + Leaflet) — tanpa API key,
  dengan throttle + cache SQLite, bisa dimatikan (`LOCATION_GEOCODE=off`).

## 2. File baru & file yang diubah

**Baru (backend):** `src/location/{store,service,geo,classify,geocode,quick,routes,index}.js`,
`src/emergency/{store,detect,service,routes,index}.js`, `src/vehicle/{store,service,intervals,quick,routes,index}.js`,
`src/memory/{personal-store,personal,quick,routes,index}.js`, `src/tools/location.js`.

**Baru (frontend):** `client/src/components/Tracking.jsx`, `client/src/components/Tracker.jsx`,
`client/src/components/tracking.css`.

**Baru (test):** `tests/location.test.js` (27), `tests/emergency.test.js` (29), `tests/vehicle.test.js` (26),
`tests/personal-memory.test.js` (12).

**Diubah:** `src/server.js` (init + mount router + `onSamples→emergency.feed` + lifecycle),
`src/tools/registry.js` (10 tool lokasi), `src/memory/owner-context.js` (konteks owner),
`src/worklog/assistant.js` (balasan "aman"/"bantuan"), `src/worklog/self-knowledge.js`,
`tests/tools-registry.test.js` (hitung tool baru), `client/src/App.jsx` (route `/tracking`, `/track`),
`client/src/components/{DashboardLayout,Header,icons}.jsx` (nav "Pelacakan"), `client/package.json`
(+leaflet), `.env.example` (blok env baru), `README.md` (bagian "Pelacakan Lokasi, Darurat, Motor
& Memori Pribadi").

## 3. Migration & perubahan database

Tidak ada migration destruktif; semua tabel **aditif** dengan `CREATE TABLE IF NOT EXISTS` saat start
(pola yang sama dengan modul existing), hidup di database SQLite yang sama:

| Prefix | Tabel |
| --- | --- |
| `loc_` (10) | `loc_settings`, `loc_devices`, `loc_sessions`, `loc_samples`, `loc_trips`, `loc_trip_stops`, `loc_places`, `loc_geocode_cache`, `loc_events`, `loc_notices` |
| `emg_` (4) | `emg_settings`, `emg_contacts`, `emg_events`, `emg_attempts` |
| `veh_` (6) | `veh_vehicles`, `veh_fuel_logs`, `veh_odo_readings`, `veh_maint_items`, `veh_service_records`, `veh_notices` |
| `mem_` (2) | `mem_items`, `mem_history` |

Index dedup (`loc_notices.dedup_key`, `veh_notices.dedup_key` UNIQUE) mencegah notifikasi ganda;
`emg_attempts` unik per (kejadian, kontak, kanal, percobaan-ke).

## 4. Daftar endpoint & kontrak API

Semua route dasbor di balik `createAccessGuard` (loopback tanpa token / `AUTOMATION_TOKEN` bila diisi)
+ rate-limit `automation` (60 aksi/menit) untuk operasi tulis.

**`/api/location`** — `GET /overview /status /day?date= /range?from=&to= /where-was-i?date= /trips?date= /trips/:id /stops?date= /sessions /places /devices /settings /privacy /events(SSE)` ·
`POST /places`, `PATCH/DELETE /places/:id` · `POST /session/start|pause|resume|stop` · `POST /stops/:id/correct`
`{kind,label,note,savePlace,radiusM}` · `POST /devices` (token *sekali tampil*), `DELETE /devices/:id` ·
`PUT /settings` · `POST /privacy/purge {confirm:"HAPUS",olderThanDays}` · `POST /privacy/reset {confirm:"HAPUS SEMUA"}` ·
`POST /simulate/ride` (data sintetis) · **Route perangkat (token `x-device-token`):**
`POST /device/ingest {samples:[{lat,lon,ts,accuracy,speed,heading,battery,motion:{mag,rot}}],sessionId?}`,
`GET /device/hint`, `GET /device/status` (hint + tracking + info darurat), `POST /device/sos`, `POST /device/respond {answer}`.

**`/api/emergency`** — `GET /status /overview /contacts /history /history/:id /settings /stream-ticket /events(SSE)` ·
`POST /contacts` (selalu mulai *belum terverifikasi*; `consent` wajib), `POST /contacts/:id/verify`,
`POST /contacts/:id/test` (uji kanal), `POST /sos {note}`, `POST /respond {answer}`, `POST /resolve`,
`POST /test` (simulasi alur penuh; **tidak pernah mengirim apa pun di mode simulate**), `PUT /settings`.

**`/api/vehicle`** — `GET /status /overview /fuel /odometer /maintenance /services /health /calibration /events(SSE)` ·
`PUT /` (profil), `POST/DELETE /fuel(/:id)`, `POST /odometer`, `POST /maintenance/:key/log`,
`POST /services`, `DELETE /services/:id`, `POST /calibration/apply`.

**`/api/memory`** — `GET /overview /items?q=&kind=&all= /items/:id/history /about?q= /events(SSE)` ·
`POST /items {kind,key,value,tags}` (kind ∈ preference/fact/place/person/routine/note; `key` & `value` wajib) ·
`PATCH /items/:id`, `DELETE /items/:id`, `POST /forget {q}` atau `{all:true, confirm:"LUPA SEMUA"}`.

## 5. Flow event realtime & emergency escalation

**Realtime (sudah diverifikasi live, lihat §10):** subscribe `GET /api/location/events` → server menulis
`event: change` + `data {kind, ts, …}` pada `samples`, `trip_open|closed`, `stop_open|closed|classified`,
`session`, `sos` … → klien (Tracking.jsx) memuat ulang data dengan debounce 900 ms; reconnect otomatis
(mundur bertahap s/d 30 dtk).

**Eskalasi darurat:** pemicu (tombol SOS dasbor / `/track` / deteksi anomali / balasan "butuh bantuan")
→ hitung mundur bawaan 25 dtk (jawab **"Saya aman"** = batal; **"Butuh bantuan"** = langsung) → tanpa
jawaban, eskalasi otomatis → notifikasi kanal pemilik lebih dulu → kontak **terverifikasi** berurutan
menurut prioritas, maks 3 percobaan per kontak, jeda retry 60 dtk, lanjut ke kontak berikutnya setelah
2 percobaan gagal → setiap percobaan dicatat (`sent`/`failed`/`pending`/`unavailable`/`simulated`) →
status akhir jujur: `escalated` / `escalated_no_contacts` / `cancelled` / `resolved`, plus aksi pemulihan
("selesai"). Mode bawaan **simulate**: seluruh alur berjalan tanpa ada pesan yang benar-benar pergi.

## 6. Dependensi baru & alasan

| Dependensi | Sisi | Alasan |
| --- | --- | --- |
| `leaflet@^1.9.4` | klien | Peta interaktif gratis tanpa API key; tiles OSM raster. Alternatif berbayar (Mapbox/Google) ditolak karena tanpa anggaran & kredensial |
| *(tidak ada)* | server | Modul memakai `better-sqlite3`, `express`, `fetch` bawaan Node — sudah ada di repo |

Layanan eksternal (bukan paket): Nominatim + Overpass API (OSM) — gratis, rate-limited di sisi klien
(dipakai hanya untuk reverse-geocode/POI; bisa `off`).

## 7. Environment variables (contoh, tanpa secret nyata)

```env
LOCATION_GEOCODE=on                  # off = matikan nama jalan/POI OSM (geofence tetap jalan)
LOCATION_NOMINATIM_URL=              # opsional: instance sendiri
LOCATION_OVERPASS_URL=               # opsional: instance sendiri
LOCATION_GEOCODE_CONTACT=            # email user-agent (etika OSM)
EMERGENCY_MODE=simulate              # simulate | live
EMERGENCY_WEBHOOK_URL=               # webhook JSON saat eskalasi (opsional)
VEHICLE_NAME=Honda Vario 160 CBS
VEHICLE_FUEL=Pertamax
FUEL_BASELINE_KMPL=50                # acuan Anda — TIDAK pernah diubah diam-diam
VEHICLE_TANK_LITERS=                 # kosong → estimasi sisa liter "tidak tersedia"
FUEL_RESERVE_KM=60
FUEL_PRICE_PER_LITER=                # kosong → estimasi rupiah "tidak tersedia"
```
Kanal darurat memakai env yang sudah ada: `TELEGRAM_*`, `WHATSAPP_*`, `SMTP_*`
(hanya kanal yang benar-benar `live` yang dipakai; sisanya dilaporkan `unavailable`).

## 8. Instalasi & deployment

Tidak ada langkah baru di luar alur repo: `npm install` (root) dan `npm install` + `npm run build` di
`client/` (Leaflet masuk lewat `client/package.json`). Jalankan seperti biasa `node src/server.js`
(atau `npm run service:install` yang sudah ada). Halaman: `/tracking` (dasbor) & `/track` (HP).
Server E2E memakai `WANAR_DB_PATH` agar database asli tidak tersentuh — variabel itu berguna juga
untuk staging.

## 9. Permission mobile & keterbatasan platform

| Platform | Yang dibutuhkan | Keterbatasan nyata |
| --- | --- | --- |
| Android (Chrome) | Izin lokasi *presisi*; halaman `/track` terbuka | GPS latar belakang penuh oleh browser tidak dijamin OS; Wake Lock menahan layar, baterai terkuras; OEM battery manager bisa mematikan tab |
| iOS (Safari 16.4+) | Izin lokasi; izin **Motion & Orientation** diminta via tombol (wajib user-gesture); Wake Lock didukung | Sama: latar belakang penuh tidak mungkin dari web; DeviceMotion hanya setelah izin eksplisit |
| Apa pun | Token perangkat (dibuat sekali di dasbor) | **Tidak ada panggilan telepon otomatis** — browser tidak bisa; jangan berharap ada. Fallback: pesan kanal (WhatsApp/Telegram/email/webhook) |
| Klien eksternal | `POST /api/location/device/ingest` + `x-device-token` | Jalur ini yang disarankan untuk pelacakan latar belakang penuh (aplikasi native/Tasker dsb.) |

## 10. Hasil test (nyata, tercatat)

- **Unit/integration baru:** `tests/location.test.js` **27/27**, `tests/emergency.test.js` **29/29**,
  `tests/vehicle.test.js` **26/26**, `tests/personal-memory.test.js` **12/12**; `tests/tools-registry.test.js`
  **71/71** (termasuk 10 tool lokasi, dan test yang menegaskan **tidak ada tool darurat** untuk AI).
- **Suite penuh** `npx vitest run`: **1 file gagal | 48 lulus | 2 skip (51)**; **2 test gagal | 1.744 lulus | 62 skip (1.808)**; 277 dtk. Dua kegagalan itu keduanya di `tests/security-pentest.test.js` — test live `/api/chat` (payload XSS & SQLi) yang timeout 30 dtk karena **kuota provider model sedang habis** pada saat run ("[FAILOVER] … Kuota gratis … habis"); jalur chat/model tidak disentuh pekerjaan ini, dan baseline sebelum perubahan pun sudah flaky (5 kegagalan sejenis pada run awal). Tidak ada kegagalan di seluruh test modul baru.
- **Build klien:** `npm run build` (tsc + vite) sukses.
- **E2E live** (server nyata, DB sementara `WANAR_DB_PATH`, port 3210, mode darurat `simulate`) —
  **46/46 check lulus**, termasuk:
  - simpan/ubah/cari/lupakan memori + blok `/memory/about` + lupa-dengan-konfirmasi;
  - CRUD tempat, validasi koordinat/`kind`, koreksi titik berhenti → geofence tersimpan → memori pribadi;
  - ingest perangkat nyata (batch 3 hari lalu, batch bergerak, 24 heartbeat diam 25 menit, gerak lagi)
    → state machine membuka perjalanan → menutup → **stop terklasifikasi** (reverse-geocode Nominatim
    asli: "Jalan Rawa Tembaga, Margajaya, Bekasi") → durasi 26 menit → `kept`;
  - privasi: purge menua (sampel 3 hari lalu terhapus, yang baru tetap), reset total menghapus riwayat
    tapi **mempertahankan tempat & perangkat**;
  - darurat: `/emergency/test` → `escalated_no_contacts` (jujur: belum ada kontak), tanpa kejadian tersisa;
  - kendaraan: odometer, konsumsi full-to-full (51,28 km/L lalu 50,0), servis `oli_mesin` (sisa 4.200 km/91 hari), kalibrasi benar-benar menolak (< 3 pengisian penuh), laporan kesehatan memisahkan "data kurang" (11 item);
  - **SSE live**: subscribe `/api/location/events` → memicu `/simulate/ride` → 4 event `change` diterima
    (`session`, `trip_open`, `samples`×2).

> Catatan E2E darurat: seluruh uji memakai `EMERGENCY_MODE=simulate`; **tidak pernah ada pesan yang
> dikirim ke kontak nyata**. Jalur kirim nyata belum diuji karena kredensial belum ada (§11–12).

## 11. Fitur yang benar-benar berfungsi (Implemented + Tested)

| Fitur | Status |
| --- | --- |
| Tracking lokasi realtime (sesi + consent, ingest perangkat bertoken, SSE, kualitas GPS, posisi terakhir jujur) | **Implemented · Tested · Production-ready** (pemakaian halaman terbuka/browser; lihat §12 untuk latar belakang penuh) |
| Peta + riwayat (Leaflet/OSM, jalur, ringkasan harian, "di mana saya tadi", jarak = lintasan GPS) | **Implemented · Tested · Production-ready** |
| Klasifikasi tempat (geofence milik pengguna instan; reverse-geocode + POI OSM dengan cache+throttle; "belum teridentifikasi" bila ragu) | **Implemented · Tested · Production-ready** (geocoding OSM terverifikasi live) |
| Koreksi berhenti + pembuatan geofence + umpan ke memori pribadi | **Implemented · Tested · Production-ready** |
| Memori pribadi (CRUD+riwayat, sumber terlihat, redaksi, pratinjau prompt, lupa frasa/semua) | **Implemented · Tested · Production-ready** |
| Kendaraan: catatan isi BBM, konsumsi model (full-to-full & acuan 50 km/L), odometer, jadwal+riwayat servis, pengingat, laporan kesehatan, kalibrasi ≥3 pengisian | **Implemented · Tested · Production-ready** (interval servis: lihat §12) |
| Notifikasi proaktif internal (dedup, jam tenang 22.00–06.00 WIB) | **Implemented · Tested** (pengiriman ke chat mengikuti kanal yang sudah ada) |
| Deteksi darurat deterministik (skor sinyal; tanpa sensor → maks "watch") & prosedur hitung mundur/eskalasi/retry/audit/simulasi | **Implemented · Tested (simulasi)** |
| Privasi (purge/reset, persetujuan per sesi, hash token) & keamanan route (guard + rate limit) | **Implemented · Tested** |

## 12. Fitur yang belum berfungsi penuh + alasan teknis & dependensi

| Hal | Status | Alasan / yang kurang |
| --- | --- | --- |
| Kirim pesan darurat ke kontak nyata (Telegram/WhatsApp/email/webhook) | **Ready for configuration** | Kode kanal + retry + audit ada; belum ada kredensial (`TELEGRAM_*`/`WHATSAPP_*`/`SMTP_*`/`EMERGENCY_WEBHOOK_URL`) dan kontak terverifikasi. Mode `live` sengaja tidak diaktifkan tanpa uji nyata |
| Panggilan telepon otomatis | **Blocked** | Tidak mungkin dari browser/web tanpa layanan pihak ketiga berbayar; spec C.4 sudah mengantisipasi ini. Tidak ada klaim palsu di UI |
| GPS latar belakang penuh dari halaman web | **Blocked (platform)** | Batasan OS/browser; jalur resmi tersedia: klien eksternal → `/device/ingest`. Wake Lock + antrean offline adalah mitigasi, bukan solusi penuh |
| Akselerometer/gyroscope sebagai kanal sensor penuh | **Ready for configuration** | `/track` sudah mengirim `motion {mag,rot}` via DeviceMotion bila diizinkan (iOS butuh izin user-gesture). Tanpa perangkat yang benar-benar dipakai, skor dibatasi jujur di "watch" |
| Interval servis resmi Honda Vario 160 | **Ready for configuration** | Nilai bawaan = "usulan awal" berlabel `verified:false` (praktik umum; **bukan** angka resmi). Pemilik mengonfirmasi/mengubah di halaman Kendaraan. Sumber resmi Honda tidak dapat diakses dari lingkungan ini |
| Sisa liter & biaya rupiah BBM | **Ready for configuration** | Butuh `VEHICLE_TANK_LITERS` / `FUEL_PRICE_PER_LITER` dari pemilik; tanpa itu UI berkata "tidak tersedia" (tidak menebak) |
| Push notification OS saat halaman tertutup | **Blocked** | Memerlukan aplikasi native/PWA push berbayar-infra (VAPID + service worker persisten); di luar lingkup & anggaran. Notifikasi saat ini = in-page + kanal chat yang sudah ada |
| Uji darurat end-to-end lintas perangkat nyata (HP → server → kontak) | **Blocked sampai ada perangkat & kontak** | Perlu HP untuk GPS/tekan tombol, kontak nyata bersedia diuji, dan kanal live. Simulasi penuh sudah berjalan |

## 13. Estimasi biaya operasional bulanan (layanan pihak ketiga)

| Layanan | Biaya | Catatan |
| --- | --- | --- |
| Leaflet + tiles OpenStreetMap | **Rp 0** | Kebijakan *fair use*; pemakaian berat → pasang tile server/proxy sendiri |
| Nominatim/Overpass publik | **Rp 0** | Maks ±1 req/detik + cache lokal; pemakaian berat → instance sendiri |
| Server & database | **Rp 0 tambahan** | Jalan di mesin yang sudah ada (SQLite) |
| WhatsApp Cloud API (opsional, hanya bila mode live + kanal WA dipakai) | Bervariasi | Meta menagih per pesan setelah kuota layanan gratis 1.000/bulan/nomor (lihat bagian WhatsApp di README); Telegram tetap gratis penuh |

## 14. Panduan konfigurasi singkat

1. **Kontak darurat:** Pelacakan → Darurat → tambah kontak (nama, nomor/chat id/email, centang kanal) →
   **Verifikasi** (uji kanal). Kontak baru tanpa verifikasi **tidak** akan dipakai eskalasi live.
   Uji dulu dengan tombol uji saat `EMERGENCY_MODE=simulate`; setelah semua kanal terbukti, baru
   pertimbangkan `live`.
2. **Geofence:** Pelacakan → Tempat → tambah "Rumah"/"Kantor" (radius 100–200 m), atau koreksi satu
   titik berhenti di Riwayat → "Simpan sebagai tempat".
3. **Baseline BBM:** Kendaraan → profil (acuan 50 km/L sesuai permintaan Anda; ubah hanya bila Anda
   yakin) + isi kapasitas tangki & harga bila ingin estimasi sisa liter/rupiah. Kalibrasi otomatis
   tersedia setelah 3 pengisian full-to-full.
4. **Maintenance:** Kendaraan → Jadwal servis → konfirmasi/ubah interval "usulan awal" agar berstatus
   terverifikasi; catat servis agar pengingat km/tanggal akurat.
5. **HP:** Dasbor → Perangkat → buat token sekali-tampil → buka `/track` di HP, tempel token, izinkan
   lokasi (+ sensor gerak bila diminta) → Mulai.

## 15. Monitoring, backup, rollback, troubleshooting

- **Monitoring:** log start menandai setiap modul + mode darurat; error berprefix
  `[LOCATION]`/`[EMERGENCY]`/`[VEHICLE]`/`[MEMORY]`. Statistik cepat: `GET /api/location/privacy` dan
  `GET /api/emergency/overview`.
- **Backup:** sama seperti data lain — file SQLite (`WANAR_DB_PATH` / `data/*.db`); tabel modul ini
  aditif sehingga backup/restore rutin yang ada sudah mencakupnya.
- **Rollback:** hentikan pemakaian (nav/route tidak merusak modul lain); `git revert`/hapus folder modul
  tidak menghapus tabel lama; mematikan fitur tanpa menyentuh data: `LOCATION_GEOCODE=off`,
  `EMERGENCY_MODE=simulate`, sesi pelacakan cukup tidak dinyalakan.
- **Troubleshooting:** tabel lengkap ada di README (bagian "Troubleshooting"); ringkasnya: tanpa sesi
  aktif tidak ada data tersimpan · nama tempat kosong = tanpa POI/geofence yang cocok (koreksi sekali) ·
  darurat `escalated_no_contacts` = belum ada kontak terverifikasi (bukan bug) · sisa bensin "$?" = isi
  kapasitas tangki · kalibrasi belum tersedia = butuh ≥3 pengisian penuh · pelacakan latar belakang
  berhenti = batasan browser (gunakan klien eksternal).

---

## Adendum — integrasi chat Telegram/WhatsApp (18 Okt 2026)

Permintaan lanjutan: "pastikan terhubung ke Telegram — tanya lokasi rumah dijawab, dan 'tambahkan
lokasi ini' disimpan + dikonfirmasi." Yang ditambahkan:

| Bagian | Perubahan |
| --- | --- |
| `src/location/service.js` | `setPendingPin/pendingPin/clearPendingPin` (pin chat ditahan di memori 15 menit, tidak pernah masuk DB tanpa nama) + `addPlace()` (validasi, anti-duplikat, event realtime, feed memori yang sama dengan koreksi dasbor) |
| `src/location/quick.js` | Intent chat deterministik baru: "daftar tempat", tanya tempat tersimpan ("di mana rumah?"), simpan dari pin / koordinat yang ditulis / posisi segar (≤15 menit), tolak dengan contoh bila tidak ada sumber; `quickLocationPin()` untuk pesan pin; `listPlacesText()` untuk chat & `/tempat` |
| `src/automation/telegram-inbox.js` | `msg.location`/`msg.venue` dari pemilik di chat privat → `onLocationPin` → balasan (HTML di-escape); orang lain/grup tanpa reaksi. Bonus perbaikan: bentrok **409** (consumer lain memakai bot yang sama) kini **retry berkala** 15 dtk → 5 mnt dengan pemulihan otomatis — sebelumnya inbox dihentikan permanen sampai restart (penyebab chat Telegram pernah diam) |
| `src/automation/whatsapp-inbox.js` | Pesan bertipe `location` dari nomor pemilik → `onLocationPin` (kunci `wa:<nomor>`, sama dengan responder) |
| `src/server.js` | Menyambungkan kedua inbox ke `quickLocationPin`, + perintah owner `/tempat [kata kunci]` |
| `src/worklog/assistant.js` | `quickLocation(..., { chatId })` agar "simpan lokasi ini" menemukan pin milik chat tersebut |
| `src/memory/owner-context.js` | Blok konteks AI menyertakan daftar tempat tersimpan (nama + koordinat + radius, maks 8) |

**Tes baru:** 5 tes intent tempat di `tests/location.test.js` (pin→simpan→tanya; koordinat+duplikat;
judul venue + prefix `wa:`; posisi segar vs basi + daftar; catatan memori tidak pernah jadi tempat),
3 tes pin Telegram di `tests/channels.test.js` (pemilik/venue/escape; orang asing & tanpa handler),
4 tes pesan location WhatsApp di `tests/whatsapp-inbox.test.js`.

**Batas jujur yang tetap berlaku:** menyimpan tempat **tidak pernah lewat model AI** — semuanya kode
deterministik; pin tanpa nama tidak pernah disimpan; posisi lebih tua dari 15 menit ditolak; nama yang
tidak tersimpan dikatakan belum ada (tidak ditebak); kanal darurat tetap `simulate` sampai pemilik
memverifikasi kontak dan mengubah `EMERGENCY_MODE=live`.
