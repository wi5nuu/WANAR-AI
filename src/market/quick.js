/**
 * src/market/quick.js
 *
 * Plain-language market commands for the Telegram assistant, handled by code (instant,
 * no tokens, never depends on the model):
 *
 *   "harga BBCA" · "ihsg hari ini" · "harga emas" · "kurs dolar"
 *   "pantau BBRI" · "hapus BBRI dari watchlist" · "watchlist"
 *   "kabari kalau BBCA di atas 10000" · "kabari kalau bitcoin turun 5%"
 *   "ringkas pasar"
 *   "simulasi investasi 1jt tiap bulan 300rb return 8% setahun"
 *
 * It informs. Requests for "what should I buy" get an honest refusal to recommend,
 * plus what it CAN do.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { parseAmount } from '../worklog/parse.js';
import { resolveSymbol } from './sources.js';
import { fmtPrice, fmtPct, DISCLAIMER } from './service.js';

const STOP = new Set([
  'KALAU', 'KABARI', 'BERITAHU', 'HARGA', 'SAHAM', 'TURUN', 'NAIK', 'ATAS', 'BAWAH', 'DARI', 'KE', 'PANTAU', 'HAPUS', 'TOLONG', 'CEK',
  'BERAPA', 'HARI', 'INI', 'SEKARANG', 'ALARM', 'ALERT', 'WATCHLIST', 'SAYA', 'AKU', 'YANG', 'DAN', 'ATAU', 'JADI', 'SAMPAI', 'TEMBUS',
  'LEBIH', 'KURANG', 'UNTUK', 'TENTANG', 'PASAR', 'INFO', 'KONDISI', 'TAMBAH', 'MASUK', 'DALAM', 'PADA', 'ADALAH', 'GIMANA', 'BAGAIMANA',
]);

const ADVICE = /(saham|kripto|crypto|investasi|reksa ?dana|emas|bitcoin)\b.*\b(apa|mana)\b.*\b(bagus|untung|cuan|beli|terbaik|rekomendasi|layak)|\b(rekomendasi|saran)\b.*\b(saham|investasi|kripto|beli)|\bapa\b.*\b(harus|sebaiknya)\b.*\b(beli|jual|investasi)|\b(beli|jual)\b.*\b(sekarang|ga|gak|nggak|tidak)\b.*\?|pasti untung|dijamin untung/i;

/** `cue`: the sentence already says it is about prices/stocks, so a bare 4-letter word may be a ticker. */
function symbolIn(text, cue = false) {
  const words = String(text).replace(/[^\p{L}\p{N}:._-]+/gu, ' ').split(/\s+/).filter(Boolean);
  for (const w of words) {
    const up = w.toUpperCase();
    if (STOP.has(up) || /^\d/.test(up)) continue;
    if (/^[A-Z]{4}$/.test(up) && !cue && w !== up) continue; // "tadi" is a word, "BBCA" is a ticker
    // aliases (ihsg, bitcoin, emas…) or exchange-prefixed
    const r = resolveSymbol(up);
    if (r && (r.kind !== 'stock' || /^[A-Z]{4}$/.test(up) || up.includes(':'))) return r;
  }
  return null;
}

const rp = (n) => `Rp${Math.round(n).toLocaleString('id-ID')}`;

function percent(text) {
  const m = /(\d+(?:[.,]\d+)?)\s*%/.exec(text);
  return m ? Number(m[1].replace(',', '.')) : null;
}

function duration(text) {
  const y = /(\d+(?:[.,]\d+)?)\s*(?:tahun|thn|th)\b/i.exec(text);
  if (y) return Math.round(Number(y[1].replace(',', '.')) * 12);
  const m = /(\d+)\s*(?:bulan|bln)\b/i.exec(text);
  if (m) return Number(m[1]);
  if (/\bsetahun\b/i.test(text)) return 12;
  return null;
}

function scenarioText(r) {
  const lines = [`Simulasi (hitungan dari asumsi, bukan prediksi):`];
  for (const s of r.results) {
    lines.push(`• ${s.label}: ${s.annualPct}%/tahun, ${s.months} bulan`);
    lines.push(`  Modal+setoran ${rp(s.contributed)} → nilai akhir ${rp(s.finalValue)} (selisih ${s.gain >= 0 ? '+' : ''}${rp(s.gain)}, ${s.gainPct}%)`);
    if (s.monthsToTarget) lines.push(`  Mencapai target dalam ±${s.monthsToTarget} bulan`);
    else if (s.monthsToTarget === null && r.target) lines.push('  Target tidak tercapai dalam 50 tahun dengan asumsi ini');
  }
  lines.push('', r.disclaimer);
  return lines.join('\n');
}

/**
 * @returns {Promise<string|null>} reply, or null when the message is not about markets
 */
export async function quickMarket(market, text) {
  if (!market) return null;
  const t = String(text || '').trim();
  if (!t || t.length > 300) return null;
  const low = t.toLowerCase();

  // ---- "what should I buy / will I profit": never advise, say what is available instead
  if (ADVICE.test(low)) {
    return [
      'Untuk yang ini saya tidak mau asal menyarankan: saya tidak bisa memastikan saham/aset mana yang akan untung, dan keputusan beli-jual itu risikonya di uang Mas sendiri.',
      'Yang bisa saya bantu: lihat harga & pergerakan hari ini ("ringkas pasar"), pantau kode tertentu ("pantau BBCA"), kabari saat harga menyentuh level pilihan Mas ("kabari kalau BBCA di bawah 6000"), dan hitung skenario ("simulasi investasi 1jt tiap bulan 300rb return 8% 2 tahun").',
      DISCLAIMER,
    ].join('\n');
  }

  // ---- scenario / simulation
  if (/\b(simulasi|hitung|proyeksi|kalau|jika|andai)\b/.test(low) && /\b(investasi|invest|nabung|menabung|modal|setor)\b/.test(low) && /\d/.test(low)) {
    const amounts = [...t.matchAll(/(?:rp\.?\s*)?\d+(?:[.,]\d+)*\s*(?:rb|ribu|k|jt|juta|m|miliar|milyar)\b|rp\.?\s*\d+(?:[.,]\d{3})+/gi)].map((m) => ({ raw: m[0], idx: m.index, v: parseAmount(m[0]) })).filter((a) => a.v);
    if (amounts.length) {
      const monthlyRe = /(?:tiap|setiap|per|\/)\s*bulan/i;
      let monthly = 0;
      let principal = 0;
      let target = null;
      for (const a of amounts) {
        const around = t.slice(Math.max(0, a.idx - 24), a.idx + a.raw.length + 24).toLowerCase();
        if (/target|mencapai|jadi\s*\d|sampai\s*\d/.test(t.slice(Math.max(0, a.idx - 14), a.idx).toLowerCase())) target = a.v;
        else if (monthlyRe.test(t.slice(a.idx, a.idx + a.raw.length + 18)) || /(?:tiap|setiap|per)\s*bulan\s*$/.test(t.slice(Math.max(0, a.idx - 16), a.idx).toLowerCase()) || /nabung|menabung|setor/.test(around) && !principal && amounts.length > 1 && a !== amounts[0]) monthly = a.v;
        else if (!principal) principal = a.v;
      }
      if (!principal && !monthly) principal = amounts[0].v;
      const months = duration(t) || 12;
      const rate = percent(t);
      try {
        const r = market.scenario({ principal, monthly, months, annualPct: rate, target });
        r.target = target;
        return scenarioText(r);
      } catch (e) {
        return `Tidak bisa menghitung: ${e.message}`;
      }
    }
  }

  // ---- alerts
  const wantsAlert = /\b(kabari|beritahu|kasih tahu|kabarin|alarm|alert|ingatkan|notif)\b/.test(low);
  if (wantsAlert && /\b(di atas|diatas|naik|tembus|mencapai|lebih dari|di bawah|dibawah|turun|kurang dari|<=|>=)\b/.test(low) && !/\b(alarm|alert)\b.*\b(apa saja|daftar|list)\b/.test(low)) {
    const sym = symbolIn(t, true);
    if (!sym) return 'Alarm untuk kode apa? Contoh: "kabari kalau BBCA di atas 10000".';
    const pct = percent(t);
    const down = /\b(di bawah|dibawah|turun|kurang dari|<=)\b/.test(low);
    try {
      let a;
      if (pct != null && /\b(naik|turun)\b/.test(low)) a = market.addAlert({ symbol: sym.symbol, op: down ? 'pct_down' : 'pct_up', value: pct });
      else {
        const nums = [...t.replace(/%/g, ' ').matchAll(/\d+(?:[.,]\d+)*\s*(?:rb|ribu|k|jt|juta)?/gi)].map((m) => m[0].trim());
        const val = nums.map((n) => parseAmount(n) ?? Number(n.replace(/\./g, '').replace(',', '.'))).find((v) => Number.isFinite(v) && v > 0);
        if (!val) return `Di level berapa ${sym.symbol}? Contoh: "kabari kalau ${sym.symbol} di atas 10000".`;
        a = market.addAlert({ symbol: sym.symbol, op: down ? 'lte' : 'gte', value: val });
      }
      const target = a.op.startsWith('pct') ? `${a.value}% hari ini` : a.value.toLocaleString('id-ID');
      return `✓ Alarm dipasang: kabari saat ${sym.label} ${a.opLabel} ${target}. Saya cek tiap menit dan kabari di sini begitu tersentuh (sekali jalan).\n${DISCLAIMER}`;
    } catch (e) {
      return `✗ ${e.message}`;
    }
  }
  if (/\b(alarm|alert)\b/.test(low) && /\b(harga|saham|pasar)\b/.test(low) && /\b(apa saja|daftar|list|aktif)\b/.test(low)) {
    const armed = market.alerts().filter((a) => a.status === 'armed');
    return armed.length ? ['Alarm harga aktif:', ...armed.map((a, i) => `${i + 1}. ${a.symbol} ${a.opLabel} ${a.op.startsWith('pct') ? `${a.value}%` : a.value.toLocaleString('id-ID')}`)].join('\n') : 'Tidak ada alarm harga aktif.';
  }

  // ---- watchlist
  let m = /^(?:tolong\s+)?(?:pantau|tambah(?:kan)?(?:\s+ke\s+watchlist)?|masukkan\s+ke\s+watchlist)\s+(.+)$/i.exec(t);
  if (m) {
    const sym = symbolIn(m[1], true);
    if (!sym) return 'Kode apa yang mau dipantau? Contoh: "pantau BBCA", "pantau bitcoin", "pantau NASDAQ:AAPL".';
    try { market.addWatch(sym.symbol); return `✓ ${sym.label} masuk watchlist. Lihat harganya kapan saja: "harga ${sym.symbol}".`; } catch (e) { return `✗ ${e.message}`; }
  }
  m = /^(?:tolong\s+)?(?:hapus|buang|berhenti\s+pantau|stop\s+pantau)\s+(.+?)(?:\s+dari\s+watchlist)?$/i.exec(t);
  if (m && symbolIn(m[1], true)) {
    const sym = symbolIn(m[1], true);
    return market.removeWatch(sym.symbol) ? `✓ ${sym.label} dihapus dari watchlist.` : `${sym.label} tidak ada di watchlist.`;
  }
  if (/^(?:watchlist|daftar\s+(?:saham|pantauan)|pantauan(?:\s+saya)?)\s*\??$/i.test(t)) {
    try {
      const d = await market.quotes();
      return [`Watchlist (${d.quotes.length}):`, ...d.quotes.map((q) => `• ${q.label}: ${fmtPrice(q)} (${fmtPct(q.changePct)})`), '', DISCLAIMER].join('\n');
    } catch (e) { return `Data pasar belum bisa diambil: ${e.message}`; }
  }

  // ---- digest
  if (/\b(ringkas(?:an)?\s+pasar|kondisi\s+pasar|pasar\s+hari\s+ini|market\s+hari\s+ini|bagaimana\s+pasar|gimana\s+pasar|laporan\s+pasar|update\s+pasar)\b/.test(low)) {
    try {
      const d = await market.digest();
      return `${d.text}${d.text.includes('bukan nasihat') ? '' : `\n\n${DISCLAIMER}`}${d.quotes.some((q) => q.delayed) ? '\n(Data bursa bisa tertunda ±10–15 menit.)' : ''}`;
    } catch (e) { return `Data pasar belum bisa diambil: ${e.message}`; }
  }

  // ---- price of one thing
  const priceAsk = /^(?:tolong\s+)?(?:cek\s+)?(?:harga|kurs|nilai|posisi)\s+(.+?)(?:\s+(?:sekarang|hari ini|berapa))?\s*\??$/i.exec(t)
    || /^(.+?)\s+(?:berapa|sekarang berapa|hari ini|gimana|bagaimana)\s*\??$/i.exec(t)
    || (/^(ihsg|bitcoin|btc|ethereum|eth|emas|kurs|dolar)\s*\??$/i.test(t) ? [t, t] : null);
  if (priceAsk) {
    const cue = /^(?:tolong\s+)?(?:cek\s+)?(?:harga|kurs|nilai|posisi)\s/i.test(t);
    const sym = symbolIn(priceAsk[1], cue);
    if (sym) {
      try {
        const q = await market.quote(sym.symbol);
        const range = Number.isFinite(q.low) && Number.isFinite(q.high) ? `\nRentang hari ini: ${q.low.toLocaleString('id-ID')} – ${q.high.toLocaleString('id-ID')}` : '';
        return `${q.label}: ${fmtPrice(q)} (${fmtPct(q.changePct)} hari ini)${range}${q.note ? `\n${q.note}` : ''}${q.delayed ? '\n(data bursa bisa tertunda ±10–15 menit)' : ''}\nSumber: ${q.source}`;
      } catch (e) { return `Data ${sym.symbol} belum bisa diambil: ${e.message}`; }
    }
  }
  return null;
}
