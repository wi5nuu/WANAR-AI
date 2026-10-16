/**
 * src/sales/quick.js
 *
 * The owner's sales commands in plain language (Telegram/WhatsApp), answered by code:
 *
 *   "prospek"                          who is waiting, hottest first
 *   "prospek 12"                       one lead and the last messages
 *   "prospek 12 menang 5jt"            move it along (dihubungi, penawaran, nego, menang, kalah, spam)
 *   "balas prospek 12: Halo, ..."      answer a lead yourself
 *   "setujui harga"                    approve the proposed prices (+ "dan syarat" for payment terms)
 *   "atur harga webapp 8jt - 25jt"     set and approve one price
 *   "daftar layanan"                   the catalog and which prices the agent may quote
 *
 * Patterns are tight on purpose: ordinary sentences must fall through to the model untouched.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { parseAmount } from '../worklog/parse.js';
import { priceRange, rupiah } from './catalog.js';

const LIST = /^\s*(?:prospek|klien|lead)(?:\s+(?:baru|terbaru|aktif|saya))?\s*[.!?]*\s*$/i;
const DETAIL = /^\s*(?:prospek|klien|lead)\s+#?(\d{1,6})\s*[.!?]*\s*$/i;
const SET = /^\s*(?:prospek|klien|lead)\s+#?(\d{1,6})\s+(dihubungi|kualifikasi|penawaran|nego|menang|deal|kalah|batal|spam)(?:\s+(.{1,40}))?\s*[.!?]*\s*$/i;
const REPLY = /^\s*balas\s+(?:prospek|klien|lead)\s+#?(\d{1,6})\s*[:,-]\s*([\s\S]{2,1500})$/i;
const APPROVE = /^\s*setujui\s+harga(?:\s+usulan)?(\s+(?:dan|beserta|serta)\s+syarat(?:\s+pembayaran)?)?\s*[.!?]*\s*$/i;
const SETPRICE = /^\s*(?:atur|set|ubah)\s+harga\s+([a-z]+)\s+(.+?)\s*(?:-|–|sampai|s\/d|hingga)\s*(.+?)(?:\s+per\s+(bulan|proyek|jam|halaman))?\s*[.!?]*\s*$/i;
const SERVICES = /^\s*(?:daftar\s+layanan|layanan\s+saya|katalog\s+layanan|harga\s+layanan)\s*[.!?]*\s*$/i;

const STATUS_WORD = { dihubungi: 'contacted', kualifikasi: 'qualified', penawaran: 'proposal', nego: 'negotiating', menang: 'won', deal: 'won', kalah: 'lost', batal: 'lost', spam: 'spam' };
const STATUS_ID = { new: 'baru', contacted: 'sudah dihubungi', qualified: 'terkualifikasi', proposal: 'penawaran', negotiating: 'negosiasi', won: 'menang', lost: 'kalah', spam: 'spam' };
const ALIAS = { landing: 'landing', profil: 'landing', company: 'landing', toko: 'ecommerce', ecommerce: 'ecommerce', web: 'webapp', webapp: 'webapp', aplikasi: 'webapp', sistem: 'webapp',
  keamanan: 'security', security: 'security', pentest: 'security', bot: 'automation', chatbot: 'automation', otomasi: 'automation', automation: 'automation', perawatan: 'maintenance', maintenance: 'maintenance' };

const clip = (s, n) => (String(s || '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s || ''));
const ago = (ts, now) => {
  const m = Math.max(0, Math.round((now - ts) / 60_000));
  if (m < 60) return `${m} menit lalu`;
  if (m < 1440) return `${Math.round(m / 60)} jam lalu`;
  return `${Math.round(m / 1440)} hari lalu`;
};

export async function quickSales(sales, text, { now = Date.now() } = {}) {
  const t = String(text || '').trim();
  if (!sales || !t || t.length > 1700) return null;
  const cat = () => sales.catalog();

  if (APPROVE.test(t)) {
    const r = sales.approvePrices({ terms: Boolean(APPROVE.exec(t)[1]) });
    const total = cat().services.length;
    return r.approved || r.termsChanged
      ? `Baik. ${r.approved} harga layanan sekarang disetujui${r.termsChanged ? ' beserta syarat pembayaran' : ''}; agent boleh menyebut kisarannya ke calon klien. Ketik "daftar layanan" untuk melihat angkanya (${total} layanan).`
      : 'Semua harga sudah disetujui sebelumnya.';
  }

  if (SERVICES.test(t)) {
    const c = cat();
    const lines = ['Layanan yang dijual agent:', ''];
    c.services.forEach((s, i) => lines.push(`${i + 1}. ${s.name}`, `   ${priceRange(s.price)} | ${s.days[0]}-${s.days[1]} hari kerja | ${s.price.approved ? 'harga disetujui' : 'harga BELUM disetujui (agent tidak menyebut angka)'}`));
    lines.push('', `Syarat pembayaran: ${c.terms.payment}, revisi ${c.terms.revisions}x (${c.terms.approved ? 'disetujui' : 'belum disetujui'}).`);
    if (c.services.some((s) => !s.price.approved)) lines.push('Ketik "setujui harga" bila kisarannya sudah pas, atau "atur harga webapp 10jt - 30jt".');
    return lines.join('\n');
  }

  let m = SETPRICE.exec(t);
  if (m) {
    const id = ALIAS[m[1].toLowerCase()] || m[1].toLowerCase();
    const min = parseAmount(m[2]); const max = parseAmount(m[3]);
    if (!min || !max) return 'Nominalnya belum terbaca. Contoh: "atur harga webapp 8jt - 25jt".';
    try {
      const s = sales.updateService(id, { price: { min, max, unit: m[4] || undefined, approved: true } });
      return `Siap. Harga ${s.name} sekarang ${priceRange(s.price)} dan disetujui, jadi agent boleh menyebutnya.`;
    } catch (e) {
      return `Tidak bisa mengubah harga: ${e.message}. Layanan yang ada: ${cat().services.map((s) => s.id).join(', ')}.`;
    }
  }

  m = REPLY.exec(t);
  if (m) {
    try {
      const r = await sales.ownerReply(Number(m[1]), m[2]);
      return r.sent ? `Terkirim ke prospek #${m[1]}.` : `Dicatat untuk prospek #${m[1]}, tetapi kanal ini belum bisa mengirim otomatis. Hubungi langsung lewat kontaknya.`;
    } catch (e) { return `Tidak bisa membalas: ${e.message}.`; }
  }

  m = SET.exec(t);
  if (m) {
    const status = STATUS_WORD[m[2].toLowerCase()];
    const value = status === 'won' && m[3] ? parseAmount(m[3].replace(/^bernilai\s+|^senilai\s+/i, '')) : null;
    try {
      const l = sales.setStatus(Number(m[1]), status, { value });
      return `Prospek #${l.id} (${l.name || l.contact}) sekarang: ${STATUS_ID[l.status]}${l.value_idr ? `, nilai ${rupiah(l.value_idr)}` : ''}.`;
    } catch (e) { return `Tidak bisa mengubah: ${e.message}.`; }
  }

  m = DETAIL.exec(t);
  if (m) {
    const lead = sales.store.getLead(Number(m[1]));
    if (!lead) return `Prospek #${m[1]} tidak ditemukan.`;
    const svc = cat().services.find((s) => s.id === lead.service_id);
    const msgs = sales.store.messages(lead.id, 6);
    const lines = [
      `Prospek #${lead.id} - ${lead.name || lead.contact} (${lead.source}), skor ${lead.score}, ${STATUS_ID[lead.status]}`,
      `Kontak: ${lead.contact}`, `Butuh: ${svc?.name || 'belum jelas'}`,
    ];
    if (lead.budget_max) lines.push(`Anggaran: ${rupiah(lead.budget_min)}${lead.budget_max !== lead.budget_min ? ` - ${rupiah(lead.budget_max)}` : ''}`);
    if (lead.deadline_days != null) lines.push(`Tenggat: sekitar ${lead.deadline_days} hari`);
    if (lead.escalated) lines.push(`Perlu Mas: ${lead.escalate_reason.join('; ')}`);
    lines.push('', 'Percakapan terakhir:');
    for (const x of msgs) lines.push(`${x.direction === 'in' ? 'Calon klien' : (x.auto ? 'Agent' : 'Mas')} (${ago(x.ts, now)}): ${clip(x.text.replace(/\s+/g, ' '), 160)}`);
    lines.push('', `Balas dengan: balas prospek ${lead.id}: <pesan>`);
    return lines.join('\n');
  }

  if (LIST.test(t)) {
    const { leads, total } = sales.store.listLeads({ open: true, limit: 6 });
    if (!leads.length) return 'Belum ada prospek yang aktif. Agent menjawab calon klien yang menulis lewat website dan WhatsApp, dan akan mengabari Mas saat ada yang serius.';
    const c = cat();
    const lines = [`Prospek aktif (${total}):`, ''];
    for (const l of leads) {
      const svc = c.services.find((s) => s.id === l.service_id);
      lines.push(`#${l.id} [${l.score}] ${clip(l.name || l.contact, 28)} - ${svc?.name || 'belum jelas'}${l.escalated ? ' (perlu Mas)' : ''}`);
    }
    lines.push('', 'Ketik "prospek <nomor>" untuk detailnya.');
    return lines.join('\n');
  }

  return null;
}
