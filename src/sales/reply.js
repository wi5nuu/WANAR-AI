/**
 * src/sales/reply.js
 *
 * Decides whether an inquiry needs the owner personally, and writes the first answer to the person
 * who asked. The answer is assembled from fixed sentences and the owner's own catalog and fact sheet:
 * no sentence is invented per customer, so it cannot promise what the owner never agreed to.
 *
 *  - The agent says it is an AI assistant (always).
 *  - It quotes a price range ONLY if the owner approved that price; otherwise it says an estimate follows.
 *  - It never promises a date, a guarantee, a discount or a contract.
 *  - Money, contracts, complaints, tight deadlines and requests for a call go to the owner.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { priceRange, proofLines, rupiah } from './catalog.js';

const HOT_SCORE = 60;

/**
 * @returns {{escalate: boolean, hot: boolean, reasons: string[]}}
 */
export function decide(q) {
  const reasons = [];
  const s = q.service;
  if (q.complaint) reasons.push('komplain');
  if (q.legal) reasons.push('kontrak/administrasi');
  if (q.wantsHuman) reasons.push('minta bicara langsung');
  if (q.urgent) reasons.push('tenggat mepet (kurang dari 7 hari)');
  if (s && q.budget) {
    if (q.budget.max < s.price.min * 0.7) reasons.push(`anggaran ${rupiah(q.budget.max)} di bawah kisaran (${priceRange(s.price)})`);
    else if (q.budget.min > s.price.max * 1.5) reasons.push(`proyek besar (anggaran ${rupiah(q.budget.min)})`);
  }
  return { escalate: reasons.length > 0, hot: !q.spam && q.score >= HOT_SCORE, reasons };
}

const T = {
  id: {
    hello: (n) => (n ? `Halo ${n}, terima kasih sudah menghubungi.` : 'Halo, terima kasih sudah menghubungi.'),
    who: (owner) => `Saya asisten AI yang membantu ${owner}, Full-Stack Engineer.`,
    understood: (name) => `Dari pesan Anda, kebutuhannya sepertinya: ${name}.`,
    unsure: (name) => `Sepertinya Anda butuh website. Supaya tepat, apakah yang dimaksud ${name}, atau kebutuhan lain?`,
    none: 'Boleh diceritakan lebih jelas apa yang ingin dibuat atau dibantu? Layanan yang tersedia:',
    proof: 'Beberapa karya yang relevan:',
    portfolio: (u) => `Portofolio: ${u}`,
    ask: 'Supaya penawarannya tepat, mohon dijawab:',
    askBudget: 'Kira-kira berapa anggaran dan target waktunya?',
    price: (range, unit, days) => `Kisaran biaya ${range}${unit ? '' : ''}, dengan estimasi pengerjaan ${days[0]}-${days[1]} hari kerja tergantung lingkup final.`,
    noPrice: 'Estimasi biaya dan waktu saya sampaikan setelah kebutuhannya jelas. Penawaran akhirnya ditinjau dan disetujui oleh pemilik.',
    terms: (t) => `Pembayaran: ${t.payment}. Revisi ${t.revisions}x.`,
    below: 'Anggaran tersebut di bawah kisaran biasa, jadi saya teruskan agar Wisnu bisa meninjau apakah lingkupnya dapat disesuaikan.',
    handoff: 'Saya sudah meneruskan ini ke Wisnu supaya dibahas langsung, dan beliau akan menghubungi Anda.',
    next: 'Wisnu akan meninjau dan menghubungi Anda langsung.',
    email: (e) => `Anda juga bisa menulis ke ${e}.`,
  },
  en: {
    hello: (n) => (n ? `Hello ${n}, thanks for reaching out.` : 'Hello, thanks for reaching out.'),
    who: (owner) => `I'm an AI assistant helping ${owner}, a Full-Stack Engineer.`,
    understood: (name) => `From your message, it sounds like you need: ${name}.`,
    unsure: (name) => `It sounds like you need a website. To be precise, do you mean ${name}, or something else?`,
    none: 'Could you tell me more about what you would like built or improved? What is available:',
    proof: 'Some relevant work:',
    portfolio: (u) => `Portfolio: ${u}`,
    ask: 'To prepare an accurate proposal, could you tell me:',
    askBudget: 'Roughly what budget and timeline do you have in mind?',
    price: (range, unit, days) => `Typical range ${range}, with an estimated ${days[0]}-${days[1]} working days depending on final scope.`,
    noPrice: 'I will share a cost and time estimate once the requirements are clear. The final proposal is reviewed and approved by the owner.',
    terms: (t) => `Payment: ${t.payment}. ${t.revisions} revision rounds.`,
    below: 'That budget is below the usual range, so I am passing it on for Wisnu to review whether the scope can be adjusted.',
    handoff: 'I have passed this to Wisnu to discuss directly, and he will contact you.',
    next: 'Wisnu will review this and contact you directly.',
    email: (e) => `You can also write to ${e}.`,
  },
};

/**
 * @param {object} q        result of qualify()
 * @param {{services: object[], terms: object}} catalog
 * @param {object|null} facts   the owner's fact sheet (for proof lines, website, e-mail)
 * @param {{name?: string, escalate?: boolean, reasons?: string[]}} ctx
 * @returns {string}
 */
export function buildReply(q, catalog, facts, { name = '', escalate = false, reasons = [] } = {}) {
  const t = T[q.lang] || T.id;
  const pi = facts?.en?.personalInfo || {};
  const owner = pi.name || 'pemilik';
  const s = q.service;
  const out = [t.hello(name), t.who(owner)];

  if (s && q.serviceConfidence === 'high') out.push('', t.understood(s.name));
  else if (s) out.push('', t.unsure(s.name));
  else out.push('', t.none, ...catalog.services.slice(0, 5).map((x, i) => `${i + 1}. ${x.name}`));

  if (s) {
    const proof = proofLines(s, facts);
    if (proof.length) out.push('', t.proof, ...proof.map((l) => `- ${l}`));
    if (pi.website) out.push(t.portfolio(pi.website));

    out.push('', t.ask);
    const qs = [...s.questions].slice(0, 3);
    if (!q.budget || q.deadlineDays == null) qs.push(t.askBudget);
    qs.forEach((x, i) => out.push(`${i + 1}. ${x}`));

    out.push('');
    if (s.price.approved) {
      out.push(t.price(priceRange(s.price), s.price.unit, s.days));
      if (catalog.terms?.approved) out.push(t.terms(catalog.terms));
      if (reasons.some((r) => r.startsWith('anggaran'))) out.push(t.below);
    } else {
      out.push(t.noPrice);
    }
  }

  out.push('', escalate ? t.handoff : t.next);
  if (pi.email) out.push(t.email(pi.email));
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Short acknowledgement for a follow-up message in a conversation that already got a full answer. */
export function buildFollowUp(lang = 'id', escalate = false) {
  if (lang === 'en') return escalate ? 'Thanks, I have added this and passed it on to Wisnu.' : 'Thanks, I have added this to your inquiry for Wisnu.';
  return escalate ? 'Terima kasih, sudah saya catat dan teruskan ke Wisnu.' : 'Terima kasih, sudah saya tambahkan ke permintaan Anda untuk Wisnu.';
}
