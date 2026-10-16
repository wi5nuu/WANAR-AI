/**
 * src/sales/catalog.js
 *
 * What the agent may offer on the owner's behalf. The services come from the owner's portfolio
 * (Frontend, Full-Stack, System Architecture) and are broken into the things people actually ask
 * for. PRICES AND TERMS ARE THE OWNER'S DECISION: every default here is a *proposal* with
 * `approved: false`, and the agent never quotes a number until the owner has approved it.
 *
 * "Proof" lines are not written here: they are pulled from the owner's fact sheet at reply time, so
 * the agent can only say things the portfolio already says.
 *
 * @author Wisnu Alfian Nur Ashar
 */

export const DEFAULT_TERMS = {
  approved: false,
  dpPercent: 50,
  revisions: 2,
  payment: 'DP di awal, pelunasan saat serah terima',
  note: 'Usulan awal, belum disetujui pemilik.',
};

/**
 * @typedef {object} Service
 * @property {string} id
 * @property {string} name
 * @property {string} summary
 * @property {string[]} deliverables
 * @property {string[]} questions       what the agent needs to know before anyone can quote
 * @property {RegExp}  match            how an inquiry is recognised (see qualify.js)
 * @property {string[]} proofProjects   portfolio project titles that back this service up
 * @property {{min:number,max:number,unit:string,approved:boolean}} price
 * @property {[number,number]} days     typical delivery window, working days
 */

export const DEFAULT_SERVICES = [
  {
    id: 'landing',
    name: 'Landing page / Company profile',
    summary: 'Website profil usaha atau halaman promosi yang cepat, rapi di ponsel, dan siap dicari di Google.',
    deliverables: ['Desain responsif (ponsel & komputer)', 'Optimasi kecepatan dan SEO dasar', 'Formulir kontak / tombol WhatsApp', 'Pemasangan di domain dan hosting Anda'],
    questions: ['Usaha atau kegiatan apa yang ingin ditampilkan?', 'Perkiraan jumlah halaman dan bagian yang dibutuhkan?', 'Sudah punya logo, foto, dan teks, atau perlu dibantu?', 'Sudah punya domain dan hosting?'],
    match: /landing\s*page|company\s*profile|profil\s*(?:perusahaan|usaha|bisnis)|website\s*(?:profil|perusahaan|usaha|sederhana)|undangan\s*digital|portfolio|portofolio|one\s*page/i,
    proofProjects: ['Ashar Grosir Parfum'],
    price: { min: 1_500_000, max: 4_000_000, unit: 'proyek', approved: false },
    days: [5, 14],
  },
  {
    id: 'ecommerce',
    name: 'Website toko online',
    summary: 'Toko online dengan katalog produk, keranjang, dan alur pemesanan yang mudah dipakai pembeli.',
    deliverables: ['Katalog dan pencarian produk', 'Keranjang dan alur pesanan', 'Panel admin untuk mengelola produk dan pesanan', 'Optimasi kecepatan, SEO, dan keamanan'],
    questions: ['Produk apa yang dijual dan kira-kira berapa jumlahnya?', 'Pembayaran dan pengiriman apa yang dibutuhkan?', 'Sudah ada toko di marketplace atau data produk yang bisa dipakai?', 'Target mulai berjualan kapan?'],
    match: /toko\s*online|e-?commerce|jualan\s*online|online\s*shop|katalog\s*produk|keranjang|checkout|woocommerce|shopify|toko\s*web/i,
    proofProjects: ['Ashar Grosir Parfum'],
    price: { min: 4_000_000, max: 12_000_000, unit: 'proyek', approved: false },
    days: [14, 35],
  },
  {
    id: 'webapp',
    name: 'Aplikasi web / sistem custom (POS, ERP, dashboard)',
    summary: 'Sistem berbasis web sesuai proses usaha Anda: kasir, stok, laporan, persetujuan, atau dashboard.',
    deliverables: ['Analisis kebutuhan dan rancangan alur', 'Aplikasi web dengan hak akses per peran', 'Dashboard dan laporan', 'Deploy di server/cloud dan serah terima dokumentasi'],
    questions: ['Proses apa yang ingin dibantu sistem ini?', 'Siapa saja penggunanya dan apa peran masing-masing?', 'Sudah ada data atau sistem lama yang harus dipindahkan?', 'Apa fitur yang paling penting di tahap pertama?'],
    match: /aplikasi|sistem\s*(?:informasi|kasir|inventori|stok|absensi|pemesanan|booking)?|\bpos\b|\berp\b|\bcrm\b|dashboard|inventory|inventori|kasir|absensi|admin\s*panel|reservasi|booking|backend|rest\s*api|custom\s*web/i,
    proofProjects: ['Ashar Grosir Parfum', 'Finance-Requester', 'Zentic Enterprise'],
    price: { min: 8_000_000, max: 35_000_000, unit: 'proyek', approved: false },
    days: [20, 60],
  },
  {
    id: 'security',
    name: 'Audit keamanan web (penetration test)',
    summary: 'Pengujian keamanan website atau aplikasi, dengan laporan temuan yang jelas dan saran perbaikan.',
    deliverables: ['Pengujian kerentanan sesuai lingkup yang disepakati', 'Laporan temuan terstruktur beserta tingkat risikonya', 'Rekomendasi perbaikan', 'Pengujian ulang setelah perbaikan (sesuai kesepakatan)'],
    questions: ['Website atau aplikasi apa yang akan diuji (dan boleh diuji oleh pemiliknya)?', 'Tujuannya: kepatuhan, persiapan peluncuran, atau setelah ada insiden?', 'Sistem berjalan di mana (hosting/cloud) dan teknologinya apa?', 'Kapan jendela pengujian yang diinginkan?'],
    match: /pentest|penetration|audit\s*keamanan|security\s*audit|uji\s*keamanan|vulnerab|kerentanan|diretas|kena\s*hack|keamanan\s*(?:website|web|aplikasi|sistem)/i,
    proofProjects: [],
    price: { min: 2_000_000, max: 8_000_000, unit: 'proyek', approved: false },
    days: [5, 20],
  },
  {
    id: 'automation',
    name: 'Otomasi & chatbot AI (WhatsApp / Telegram / web)',
    summary: 'Bot yang menjawab pertanyaan pelanggan, mencatat pesanan, atau mengerjakan tugas berulang secara otomatis.',
    deliverables: ['Alur percakapan sesuai produk/layanan Anda', 'Integrasi ke WhatsApp, Telegram, atau website', 'Aturan kapan bot menyerahkan ke manusia', 'Panduan penggunaan dan pemantauan'],
    questions: ['Tugas apa yang ingin diotomatiskan atau dijawab bot?', 'Di kanal mana: WhatsApp, Telegram, website?', 'Seberapa banyak pesan per hari, kira-kira?', 'Apakah ada data produk/FAQ yang bisa dipakai bot?'],
    match: /chat\s*bot|chatbot|bot\s*(?:wa|whatsapp|telegram)|otomasi|otomatisasi|automation|ai\s*agent|integrasi\s*ai|auto[\s-]?reply|balas\s*otomatis|n8n|whatsapp\s*gateway/i,
    proofProjects: ['Ashar Grosir Parfum'],
    price: { min: 2_000_000, max: 8_000_000, unit: 'proyek', approved: false },
    days: [7, 25],
  },
  {
    id: 'maintenance',
    name: 'Perawatan & pengembangan lanjutan',
    summary: 'Perbaikan bug, pembaruan, pemantauan, dan penambahan fitur untuk website atau aplikasi yang sudah berjalan.',
    deliverables: ['Pemantauan dan pembaruan berkala', 'Perbaikan bug', 'Penambahan fitur kecil sesuai kuota', 'Laporan bulanan singkat'],
    questions: ['Website/aplikasi apa yang dirawat dan dibangun dengan teknologi apa?', 'Masalah atau fitur apa yang sedang dibutuhkan?', 'Seberapa sering perubahan dibutuhkan?'],
    match: /maintenance|perawatan|rawat\s*(?:website|web|aplikasi)|perbaiki|bug|error|update\s*(?:website|web|plugin)|migrasi|pindah\s*hosting|hosting|renewal/i,
    proofProjects: [],
    price: { min: 300_000, max: 1_000_000, unit: 'bulan', approved: false },
    days: [1, 7],
  },
];

/** Plain copy of the defaults: callers may edit their copy freely. */
export function defaultCatalog() {
  return {
    services: DEFAULT_SERVICES.map((s) => ({ ...s, deliverables: [...s.deliverables], questions: [...s.questions], proofProjects: [...s.proofProjects], price: { ...s.price }, days: [...s.days] })),
    terms: { ...DEFAULT_TERMS },
  };
}

export const rupiah = (n) => `Rp${Math.round(n).toLocaleString('id-ID')}`;

/** "Rp1,5 juta - Rp4 juta" : short and exact, never rounded in the owner's disfavour. */
export function priceRange(p) {
  const short = (n) => {
    if (n >= 1_000_000) return `Rp${(n / 1_000_000).toLocaleString('id-ID', { maximumFractionDigits: 1 })} juta`;
    if (n >= 1_000) return `Rp${Math.round(n / 1_000).toLocaleString('id-ID')} ribu`;
    return rupiah(n);
  };
  return `${short(p.min)} - ${short(p.max)}${p.unit === 'bulan' ? ' per bulan' : ''}`;
}

/**
 * Proof lines for a service, taken VERBATIM from the owner's fact sheet (never composed here):
 * "<title> (<status>): <first sentence of the portfolio's own description>".
 */
export function proofLines(service, facts, max = 2) {
  const projects = facts?.en?.projects || [];
  const out = [];
  for (const title of service.proofProjects || []) {
    const p = projects.find((x) => x.title === title);
    if (!p) continue;
    const first = String(p.description || '').split(/(?<=[.!?])\s+/)[0].trim();
    if (!first) continue;
    out.push(`${p.title}${p.status ? ` (${p.status})` : ''}: ${first}`);
    if (out.length >= max) break;
  }
  return out;
}
