/**
 * src/sales/intent.js
 *
 * How the agent talks a prospect from "interested" to "deal". It reads what the person just wrote,
 * decides what they want (price? time? proof? to stop? to start?), and answers with fixed sentences
 * filled from the owner's approved catalog and fact sheet, plus ONE clear next step. It never makes up
 * a price, a date, a discount or a guarantee, and it hands the person to the owner at the moments that
 * decide a sale: ready to start, price negotiation, contract/payment, a call.
 *
 *  stop        they do not want this  -> close politely, never message again
 *  ready       they want to proceed   -> hand to the owner NOW (this is the closing moment)
 *  haggle      too expensive / discount -> owner decides; the agent never offers a discount
 *  price       how much?              -> approved range, else "estimate after the brief"
 *  timeline    how long?              -> approved day range, else "depends on scope"
 *  proof       portfolio / examples   -> owner's own project lines + links
 *  trust       guarantee / is this legit -> honest: no promises, show real work
 *  call        wants to talk          -> owner
 *  brief       gave details           -> thank, ask the next missing question
 *  ack         "ok", "thanks"         -> short, keep the door open
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { priceRange, proofLines } from './catalog.js';
import { detectLanguage, parseBudget } from './qualify.js';

// ---------------------------------------------------------------- classification

const RULES = [
  ['stop', /\b(stop|berhenti|unsubscribe|jangan\s+(?:hubungi|kirim|chat|ganggu)|tidak\s+tertarik|nggak\s+tertarik|gak\s+tertarik|ga\s+tertarik|tidak\s+jadi|nggak\s+jadi|gak\s+jadi|ga\s+jadi|batal(?:kan)?|not\s+interested|no\s+thanks?|remove\s+me)\b/i],
  ['ready', /\b(deal|setuju|sepakat|oke\s+lanjut|ok\s+lanjut|lanjut(?:kan)?\s*(?:saja|aja|yuk|ya)?|siap\s+(?:mulai|lanjut)|mulai\s+(?:aja|saja|sekarang|kerja)|kapan\s+(?:bisa\s+)?mulai|saya\s+(?:mau|ingin)\s+(?:order|pesan|pakai|ambil)|boleh\s+(?:mulai|lanjut)|(?:sudah|mau|akan|siap|segera|langsung)\s+(?:transfer|bayar|dp)|(?:minta|kirim|mana|nomor)\s+(?:no(?:mor)?\.?\s*)?rekening|rekening\s*(?:nya)?\s+(?:mana|berapa)|invoice(?:nya)?\s+(?:mana|dong|ya)|let'?s\s+(?:go|start|proceed)|go\s+ahead|sounds\s+good|i'?ll\s+take\s+it)\b/i],
  ['haggle', /\b(terlalu\s+mahal|kemahalan|mahal\s+(?:banget|sekali|amat)|nego|tawar|diskon|kurangi|turun(?:kan)?\s+(?:harga|dikit|sedikit)|bisa\s+kurang|lebih\s+murah|budget\s+(?:saya\s+)?(?:cuma|hanya|terbatas)|too\s+(?:expensive|much)|discount|cheaper|lower\s+(?:price|rate))\b/i],
  ['call', /\b(telepon|telfon|telp|call|video\s*call|zoom|google\s*meet|ketemu|bertemu|bicara\s*(?:langsung|dengan)|hubungi\s+saya|meeting)\b/i],
  ['trust', /\b(garansi|jaminan|dijamin|aman\s+(?:tidak|ga|gak|nggak)|terpercaya|penipuan|tipu|scam|legit|refund|uang\s+kembali|guarantee)\b/i],
  ['timeline', /\b(berapa\s+lama|kapan\s+selesai|lama\s+(?:pengerjaan|dikerjakan)|durasi|waktu\s+pengerjaan|how\s+long|timeline|turnaround|selesai\s+dalam)\b/i],
  ['price', /\b(harga|biaya|tarif|berapa(?:\s+(?:biaya|harga|duit|rupiah))?|estimasi|kisaran|quote|price|cost|how\s+much|rate)\b/i],
  ['proof', /\b(portofolio|portfolio|contoh(?:\s+(?:karya|website|hasil))?|referensi|hasil\s+kerja|pernah\s+(?:buat|bikin)|karya|sample|examples?|previous\s+work)\b/i],
];

const ACK = /^\s*(?:ok(?:e|ay)?|siap|baik|sip|mantap|noted|thanks?|thank\s+you|terima\s*kasih|makasih|trims|oke\s+(?:kak|mas|pak|bu)|👍|🙏)[\s.!?🙏👍]*$/i;

/** @returns {'stop'|'ready'|'haggle'|'call'|'trust'|'price'|'timeline'|'proof'|'ack'|'brief'} */
export function classifyReply(text) {
  const t = String(text || '').trim();
  if (!t) return 'ack';
  if (ACK.test(t) && t.length <= 40) return 'ack';
  for (const [name, re] of RULES) if (re.test(t)) {
    // "kapan mulai?" in a long brief is about timing, not a green light for payment: only short messages close.
    if (name === 'ready' && t.length > 160 && !/\b(deal|setuju|sepakat|transfer|bayar|dp)\b/i.test(t)) continue;
    return name;
  }
  return 'brief';
}

// ---------------------------------------------------------------- wording

const W = {
  id: {
    thanks: (n) => (n ? `Terima kasih, ${n}.` : 'Terima kasih.'),
    stop: 'Baik, saya tidak akan menghubungi lagi. Terima kasih atas waktunya, dan sukses untuk usahanya.',
    ready: 'Terima kasih, senang mendengarnya. Saya teruskan ke Wisnu sekarang untuk mengonfirmasi lingkup, harga akhir, dan cara pembayaran; beliau akan menghubungi Anda langsung. Supaya cepat, boleh kirim ringkasan kebutuhan Anda (fitur utama, contoh yang disukai, dan target waktu)?',
    haggle: 'Terima kasih sudah terbuka soal anggaran. Harga akhir dan kemungkinan menyesuaikan lingkup diputuskan langsung oleh Wisnu, jadi saya teruskan ke beliau. Sambil menunggu, fitur mana yang paling penting bagi Anda? Dengan begitu lingkup bisa disusun sesuai anggaran.',
    call: 'Tentu, saya teruskan permintaan ini ke Wisnu agar beliau menghubungi Anda langsung. Kapan waktu yang nyaman, dan lewat apa (telepon, WhatsApp, atau video)?',
    trust: 'Pertanyaan yang wajar. Saya tidak bisa menjanjikan hasil tertentu, tetapi Anda bisa menilai pekerjaan nyata Wisnu lewat portofolio dan GitHub-nya, dan semua kesepakatan (lingkup, harga, tahapan pembayaran) ditulis jelas di awal.',
    priceOk: (range, unit) => `Untuk kebutuhan seperti ini, kisaran biayanya ${range}${unit ? '' : ''}; angka pastinya bergantung pada fitur dan jumlah halaman.`,
    priceNo: 'Angka pastinya bergantung pada fitur dan jumlah halaman, jadi saya perlu memahami kebutuhan Anda dulu. Setelah itu estimasi disampaikan, dan Wisnu yang menyetujui penawaran akhirnya.',
    timeOk: (d) => `Biasanya pengerjaan sekitar ${d[0]}-${d[1]} hari kerja, tergantung lingkup akhir.`,
    timeNo: 'Lama pengerjaan bergantung pada lingkup, dan akan dipastikan setelah kebutuhan Anda jelas.',
    proof: 'Berikut karya nyata yang relevan:',
    portfolio: (u) => `Portofolio lengkap: ${u}`,
    brief: 'Terima kasih, sudah saya catat.',
    ack: 'Siap. Kalau ada yang ingin ditanyakan atau ditambahkan, kabari saja ya.',
    ask: 'Supaya penawarannya tepat, boleh dijawab:',
    nextNone: 'Boleh ceritakan sedikit lebih lanjut apa yang ingin dibuat?',
    handoff: 'Wisnu akan meninjau dan menghubungi Anda langsung.',
  },
  en: {
    thanks: (n) => (n ? `Thank you, ${n}.` : 'Thank you.'),
    stop: 'Understood, I will not contact you again. Thank you for your time, and all the best.',
    ready: 'Thank you, that is great to hear. I am passing this to Wisnu now to confirm scope, final price and payment; he will contact you directly. To speed things up, could you send a short summary of what you need (key features, examples you like, and your target date)?',
    haggle: 'Thank you for being open about your budget. The final price and any scope adjustment are decided by Wisnu directly, so I am passing this to him. Meanwhile, which features matter most to you? That lets the scope be shaped around your budget.',
    call: 'Of course, I am passing this to Wisnu so he can contact you directly. What time suits you, and by which channel (phone, WhatsApp or video)?',
    trust: 'A fair question. I cannot promise specific results, but you can judge Wisnu\'s real work through his portfolio and GitHub, and every agreement (scope, price, payment stages) is written down clearly up front.',
    priceOk: (range) => `For something like this the typical range is ${range}; the exact figure depends on features and number of pages.`,
    priceNo: 'The exact figure depends on features and number of pages, so I need to understand your needs first. An estimate follows after that, and Wisnu approves the final proposal.',
    timeOk: (d) => `Delivery is typically ${d[0]}-${d[1]} working days, depending on the final scope.`,
    timeNo: 'Delivery time depends on scope and will be confirmed once your needs are clear.',
    proof: 'Some relevant real work:',
    portfolio: (u) => `Full portfolio: ${u}`,
    brief: 'Thank you, noted.',
    ack: 'Got it. If you have questions or want to add anything, just let me know.',
    ask: 'To prepare an accurate proposal, could you tell me:',
    nextNone: 'Could you tell me a bit more about what you would like built?',
    handoff: 'Wisnu will review this and contact you directly.',
  },
};

/**
 * @param {{text: string, name?: string, service?: object|null, catalog: {services: object[], terms: object}, facts?: object|null,
 *          repliesSoFar?: number, budget?: object|null}} ctx
 * @returns {{intent: string, text: string, escalate: boolean, reasons: string[], close: boolean, hot: boolean}}
 */
export function converse(ctx) {
  const { text, name = '', service = null, catalog, facts = null, repliesSoFar = 0 } = ctx;
  const intent = classifyReply(text);
  const lang = detectLanguage(text) === 'en' ? 'en' : 'id';
  const w = W[lang];
  const pi = facts?.en?.personalInfo || {};
  const out = { intent, text: '', escalate: false, reasons: [], close: false, hot: false };
  const parts = [];

  const nextQuestion = () => {
    if (!service) return w.nextNone;
    const qs = service.questions || [];
    const q = qs[Math.min(repliesSoFar, qs.length - 1)];
    return q ? `${w.ask}\n1. ${q}` : w.nextNone;
  };

  switch (intent) {
    case 'stop':
      out.close = true;
      parts.push(w.stop);
      break;
    case 'ready':
      out.escalate = true; out.hot = true; out.reasons.push('siap lanjut: konfirmasi lingkup, harga, dan pembayaran');
      parts.push(w.ready);
      break;
    case 'haggle':
      out.escalate = true; out.hot = true; out.reasons.push('menawar harga: hanya pemilik yang memutuskan');
      parts.push(w.haggle);
      break;
    case 'call':
      out.escalate = true; out.hot = true; out.reasons.push('minta bicara langsung');
      parts.push(w.call);
      break;
    case 'trust':
      out.escalate = /tipu|penipuan|scam/i.test(text); if (out.escalate) out.reasons.push('meragukan kepercayaan');
      parts.push(w.trust);
      if (pi.website) parts.push(w.portfolio(pi.website));
      if (pi.github) parts.push(`GitHub: ${pi.github}`);
      break;
    case 'price':
      parts.push(w.thanks(name));
      parts.push(service?.price.approved ? w.priceOk(priceRange(service.price), service.price.unit) : w.priceNo);
      if (service?.price.approved && catalog.terms?.approved) parts.push(lang === 'en' ? `Payment: ${catalog.terms.payment}.` : `Pembayaran: ${catalog.terms.payment}.`);
      parts.push(nextQuestion());
      break;
    case 'timeline':
      parts.push(service && service.price.approved ? w.timeOk(service.days) : w.timeNo);
      parts.push(nextQuestion());
      break;
    case 'proof': {
      const lines = service ? proofLines(service, facts, 3) : [];
      parts.push(w.proof);
      if (lines.length) parts.push(...lines.map((l) => `- ${l}`));
      if (pi.website) parts.push(w.portfolio(pi.website));
      if (pi.github) parts.push(`GitHub: ${pi.github}`);
      parts.push(nextQuestion());
      break;
    }
    case 'ack':
      parts.push(w.ack);
      break;
    default: { // brief: the prospect is telling us about their project
      parts.push(`${w.brief}${ctx.budget ? '' : ''}`);
      parts.push(nextQuestion());
      if (repliesSoFar >= 1) parts.push(w.handoff);
    }
  }
  out.text = parts.filter(Boolean).join('\n\n');
  return out;
}

export { parseBudget };
