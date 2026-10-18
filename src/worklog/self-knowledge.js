/**
 * src/worklog/self-knowledge.js
 *
 * What the owner's chat assistant (Telegram/WhatsApp) knows about the Wanar AI application itself:
 * the website's pages, the models/providers behind it, which channels and agents are connected right now.
 * Pages and feature descriptions are curated (they change with the code); models, channel modes and agent
 * status are read live at the moment of the question. The assistant is told to answer questions about the
 * app ONLY from this block and to say plainly when a detail is not here (it cannot open the website).
 *
 * @author Wisnu Alfian Nur Ashar
 */

const clip = (s, n) => (String(s || '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s || ''));

/** [path, name, what it does] — keep in sync with client/src/App.jsx routes. */
export const WEB_PAGES = [
  ['/', 'Chat', 'obrolan dengan AI: pilih provider & model, lampiran file, riwayat sesi, streaming'],
  ['/voice', 'Voice Talk', 'bicara langsung dengan AI lewat suara'],
  ['/worklog', 'Jurnal Kerja', 'tugas harian, catatan uang (masuk/keluar), jam kerja (start/jeda/stop), laporan harian, pengingat'],
  ['/command-center', 'Command Center', 'ringkasan hari ini: pengingat & alarm, Email Desk (draf, percakapan, kontak, kebijakan balas), pasar (watchlist, alert, skenario), briefing pagi, intel'],
  ['/agent-center', 'Pusat Agen', '7 tab: Ringkasan, Aktivitas (log semua agen), Lowongan (radar karier + paket lamaran + unduh CV), Calon Klien (lead yang menulis sendiri), Peluang (radar klien Freelancer & usaha lokal), Layanan (katalog & harga), Tentang'],
  ['/tracking', 'Pelacakan', 'peta live & riwayat perjalanan (OpenStreetMap), tempat yang dikenal + koreksi nama, kontak & alur darurat (mode simulasi/live), kendaraan (bensin/odometer/servis), memori pribadi'],
  ['/track', 'Pelacak HP', 'halaman khusus di HP: kirim GPS ke server dengan token perangkat, interval adaptif, tombol darurat; penamaan file dibuat agar mudah dibuka di ponsel'],
  ['/automation', 'Otomasi', 'kampanye email/WhatsApp/Telegram, penerima, templat, jadwal, status kanal'],
  ['/job-agent', 'Job Agent', 'agen pencari kerja versi awal'],
  ['/system-map', 'Peta Sistem 3D', 'peta langsung seluruh sistem: provider, kuota, jejak (trace) tiap permintaan, keamanan'],
  ['/dashboard dan /analytics', 'Analitik', 'pemakaian token/biaya/panggilan per provider dan model'],
  ['/profile', 'Profil', 'profil pemilik'],
  ['/settings', 'Pengaturan', 'konfigurasi provider, kunci, preferensi'],
];

const FEATURES = [
  'Telegram: asisten ini sendiri (jadwal, tugas, uang, pengingat, email, bisnis); perintah garis miring seperti /kirim, /tolak, /peka, /brief',
  'Email Desk: tulis & kirim email dengan konfirmasi "kirim", pantau balasan realtime (IMAP IDLE), mode per percakapan (kabari / siapkan / otomatis), balasan otomatis selalu diberi keterangan AI',
  'Radar karier: 15 sumber lowongan resmi, penilaian otomatis, paket lamaran (surat + jawaban + CV), laporan harian 19.00 WIB',
  'Radar klien: Freelancer.com tiap 6 jam + usaha lokal tanpa website tiap 3 hari; paket pagi 08.00 WIB; sistem TIDAK menghubungi calon klien sendiri',
  'Meja penjualan: katalog 6 layanan, harga hanya yang disetujui pemilik, lead dari formulir situs portofolio & WhatsApp, saran balasan',
  'Pasar & briefing: watchlist, alert harga, briefing pagi hari kerja, waktu shalat Bekasi, sapaan peduli (Peka), pembelajaran otomatis tiap 00.00',
  'Pelacakan & darurat: posisi live (SSE), riwayat perjalanan & tempat (jarak GPS, bukan odometer), deteksi darurat deterministik dengan hitung mundur + eskalasi ke kontak terverifikasi (mode simulasi bawaan), tombol SOS di HP',
  'Kendaraan: catatan bensin (estimasi model, bukan sensor), odometer manual, jadwal servis dengan interval usulan yang ditandai belum terverifikasi',
  'Memori pribadi: kesukaan, rutinitas, tempat bernama, orang dan catatan — bisa diubah/dihapus pemilik kapan saja',
];

/** Models/providers behind the chat: the live current one plus the configured fallbacks. */
function modelLines(aiManager) {
  const out = [];
  try {
    const current = aiManager.getProvider?.();
    const model = aiManager.getDefaultModel?.();
    const configured = aiManager.getConfiguredProviders?.() || [];
    out.push(`- Model yang menjawab obrolan ini sekarang: provider "${current || 'tidak diketahui'}", model bawaan "${model || 'tidak diketahui'}". Provider lain yang terkonfigurasi (cadangan/pilihan di halaman Chat): ${configured.length ? configured.join(', ') : 'tidak ada'}.`);
    const detail = configured.map((name) => {
      const p = aiManager.providers?.[name];
      return p?.defaultModel ? `${name}: ${p.defaultModel}` : null;
    }).filter(Boolean);
    if (detail.length) out.push(`- Model bawaan tiap provider: ${clip(detail.join('; '), 600)}. Bila failover terjadi, model sebenarnya yang dipakai tercatat di Peta Sistem (/system-map) per permintaan; sisa kuota token juga hanya ada di sana/dasbor provider, bukan di dirimu.`);
  } catch { /* best effort */ }
  return out;
}

function channelLines({ automation, emailDesk, sales, career, market }) {
  const out = [];
  try {
    const ch = (id) => { try { return automation?.channels?.has(id) ? automation.channels.get(id) : null; } catch { return null; } };
    const parts = [];
    for (const [id, label] of [['telegram', 'Telegram'], ['whatsapp', 'WhatsApp'], ['email', 'Email (SMTP)']]) {
      const c = ch(id);
      if (c) parts.push(`${label}: ${c.mode === 'live' ? 'tersambung' : `BELUM tersambung (mode ${c.mode || 'tidak diketahui'})`}`);
    }
    if (automation?.mailer?.mode) parts.push(`Email keluar: mode ${automation.mailer.mode}`);
    if (parts.length) out.push(`- Kanal sekarang: ${parts.join('; ')}.`);
  } catch { /* best effort */ }
  try {
    if (emailDesk) out.push(`- Email Desk: ${emailDesk.live ? 'aktif (kirim sungguhan)' : 'simulasi (SMTP belum diatur)'}; kebijakan balas bawaan "${emailDesk.defaultMode}", untuk pengirim baru "${emailDesk.inboundMode}".`);
  } catch { /* best effort */ }
  try {
    const a = [];
    if (career) a.push(`radar karier ${career.enabled ? 'aktif' : 'MATI'}`);
    if (sales) a.push(`meja penjualan ${sales.autoReply ? 'balas otomatis' : 'mode saran'}`);
    if (sales?.prospects) a.push(`radar klien ${sales.prospects.enabled ? 'aktif' : 'MATI'}`);
    if (market) a.push('pasar aktif');
    if (a.length) out.push(`- Agen: ${a.join(', ')}.`);
  } catch { /* best effort */ }
  return out;
}

/** @returns {string[]} prompt lines describing the application the assistant lives in */
export function appPromptLines({ aiManager = null, automation = null, emailDesk = null, sales = null, career = null, market = null, env = process.env } = {}) {
  const base = String(env.PUBLIC_BASE_URL || 'https://wanarai.ashargrosirparfum.com').replace(/\/+$/, '');
  const out = [
    '',
    'APLIKASI WANAR AI (dirimu sendiri; halaman & fitur ditulis manual, model/kanal/agen dibaca langsung saat ini). Jawab pertanyaan tentang website/aplikasi HANYA dari blok ini; bila detail tidak ada di sini, katakan terus terang bahwa kamu tidak punya detailnya. Kamu tidak bisa membuka website secara langsung.',
    `- Alamat: ${base} (dilindungi login nginx; halaman tertentu tanpa login: /webhook/whatsapp dan /webhook/inquiry untuk pesan masuk).`,
    '- Halaman website:',
    ...WEB_PAGES.map(([path, name, what]) => `  • ${path} — ${name}: ${what}`),
    '- Fitur utama:',
    ...FEATURES.map((f) => `  • ${f}`),
    ...(aiManager ? modelLines(aiManager) : []),
    ...channelLines({ automation, emailDesk, sales, career, market }),
  ];
  return out;
}
