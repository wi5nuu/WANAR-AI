/**
 * src/sales/service.js
 *
 * The sales desk: it receives an inquiry from anyone (website form, WhatsApp, ...), works out what
 * they need, answers them straight away from the owner's catalog, remembers the conversation, and
 * tells the owner the moment a lead is worth a personal reply.
 *
 * What it does NOT do, on purpose: contact strangers who never wrote in, quote a price the owner has
 * not approved, promise dates or guarantees, sign anything, or take payment. Those need the owner.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { EventEmitter } from 'node:events';
import { qualify } from './qualify.js';
import { decide, buildReply, buildFollowUp } from './reply.js';
import { converse } from './intent.js';
import { rupiah } from './catalog.js';
import { SalesStore } from './store.js';
import { inQuietHours } from '../career/service.js';

const MAX_TEXT = 2000;
const FLOOD_PER_HOUR = 12; // a real sales chat can run to a dozen messages an hour; spam is caught by content, this only stops floods
const MAX_AUTO_REPLIES = 6; // a real sale needs back-and-forth; the engine hands over at the decisive moments long before this
const HOT_RENOTIFY_MS = 6 * 3_600_000;
const TICK_MS = 5 * 60_000;

const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

/** Phone numbers to digits, e-mail to lower case; anything else trimmed. */
export function normalizeContact(raw) {
  const s = String(raw || '').trim();
  if (/@/.test(s)) return s.toLowerCase().slice(0, 120);
  const digits = s.replace(/\D/g, '');
  if (digits.length >= 8) return digits.startsWith('0') ? `62${digits.slice(1)}` : digits;
  return s.slice(0, 80);
}

export class SalesService extends EventEmitter {
  constructor({ store, getFacts = () => null, notify = null, ownerChat = () => null, log = () => {}, senders = {}, env = process.env, now = Date.now } = {}) {
    super();
    this.store = store;
    this.getFacts = getFacts;
    // Like the career radar: only the production instance may message the owner on Telegram.
    this.notify = String(env.CAREER_TELEGRAM || '').toLowerCase() === 'on' ? notify : null;
    this.ownerChat = ownerChat;
    this.log = log;
    this.senders = senders;
    this.env = env;
    this.now = now;
    this.timer = null;
  }

  /** Replies leave on their own only when the owner switched auto-reply on. */
  get autoReply() { return String(this.env.SALES_AUTO_REPLY || '').toLowerCase() === 'on'; }

  // ------------------------------------------------------------ catalog (owner's decisions)

  catalog() { return this.store.catalog(); }

  /**
   * Edits a service. Changing a price puts it back to "not approved" unless the caller approves it
   * in the same call: the owner has to have seen the number the agent is about to quote.
   */
  updateService(id, patch = {}) {
    const cat = this.store.catalog();
    const s = cat.services.find((x) => x.id === id);
    if (!s) throw new Error('layanan tidak ditemukan');
    for (const k of ['name', 'summary']) if (typeof patch[k] === 'string' && patch[k].trim()) s[k] = patch[k].trim().slice(0, 200);
    for (const k of ['deliverables', 'questions']) if (Array.isArray(patch[k])) s[k] = patch[k].map((x) => String(x).trim().slice(0, 200)).filter(Boolean).slice(0, 12);
    if (Array.isArray(patch.days) && patch.days.length === 2) {
      const [a, b] = patch.days.map(Number);
      if (a > 0 && b >= a && b <= 365) s.days = [a, b];
    }
    if (patch.price) {
      const min = Number(patch.price.min ?? s.price.min);
      const max = Number(patch.price.max ?? s.price.max);
      const unit = patch.price.unit ?? s.price.unit;
      if (!(min >= 50_000 && max >= min && max <= 1_000_000_000)) throw new Error('harga tidak valid (min >= Rp50.000, max >= min)');
      if (!['proyek', 'bulan', 'jam', 'halaman'].includes(unit)) throw new Error('satuan harga tidak valid');
      const changed = min !== s.price.min || max !== s.price.max || unit !== s.price.unit;
      s.price = { min, max, unit, approved: patch.price.approved === true ? true : (changed ? false : s.price.approved) };
    }
    this.store.saveCatalog(cat);
    this.log({ agent: 'sales', kind: 'catalog', title: `Layanan "${s.name}" diperbarui${patch.price ? (s.price.approved ? ' (harga disetujui)' : ' (harga menunggu persetujuan)') : ''}` });
    return s;
  }

  /** The owner's "yes" to the proposed prices (and, with terms: true, the payment terms). */
  approvePrices({ ids = null, terms = false } = {}) {
    const cat = this.store.catalog();
    let n = 0;
    for (const s of cat.services) {
      if (ids && !ids.includes(s.id)) continue;
      if (!s.price.approved) { s.price.approved = true; n += 1; }
    }
    let termsChanged = false;
    if (terms && !cat.terms.approved) { cat.terms.approved = true; cat.terms.note = 'Disetujui pemilik.'; termsChanged = true; }
    this.store.saveCatalog(cat);
    if (n || termsChanged) {
      this.log({ agent: 'sales', kind: 'catalog', level: 'good', title: `${n} harga layanan disetujui pemilik; agent kini boleh menyebut kisarannya${termsChanged ? ' beserta syarat pembayaran' : ''}` });
    }
    return { approved: n, terms: cat.terms.approved, termsChanged };
  }

  // ------------------------------------------------------------ intake

  /**
   * One inbound message from a prospect.
   * @param {{source: string, contact: string, name?: string, text: string}} msg
   * @returns {{leadId:number|null, reply:string|null, autoSend:boolean, escalate:boolean, reasons:string[], hot:boolean, spam:boolean, rateLimited:boolean, created:boolean}}
   */
  async intake({ source, contact, name = '', text }) {
    const t = String(text || '').trim().slice(0, MAX_TEXT);
    const who = normalizeContact(contact);
    const none = { leadId: null, reply: null, autoSend: false, escalate: false, reasons: [], hot: false, spam: false, rateLimited: false, created: false };
    if (!t || !who) return none;

    const catalog = this.store.catalog();
    let lead = this.store.findLead(source, who);
    const created = !lead;
    if (!lead) lead = this.store.createLead({ source, contact: who, name: String(name || '').slice(0, 80) || null });
    else if (name && !lead.name) lead = this.store.updateLead(lead.id, { name: String(name).slice(0, 80) });

    // Spam is recorded once, never answered, and never shown to the owner as a lead.
    const first = qualify(t, catalog.services);
    if (first.spam || lead.status === 'spam') {
      this.store.updateLead(lead.id, { status: 'spam', score: 0 });
      this.log({ agent: 'sales', kind: 'spam', title: `Pesan promosi/spam diabaikan (${source})` });
      return { ...none, leadId: lead.id, spam: true, created };
    }

    this.store.addMessage(lead.id, 'in', t);
    if (this.store.recentInbound(lead.id) > FLOOD_PER_HOUR) {
      this.log({ agent: 'sales', kind: 'flood', level: 'warn', title: `Terlalu banyak pesan dari satu kontak (${source}), tidak dibalas otomatis` });
      return { ...none, leadId: lead.id, rateLimited: true, created };
    }

    // Re-read the whole conversation: a budget given in the second message still counts.
    const need = [lead.need, t].filter(Boolean).join('\n').slice(-MAX_TEXT);
    const q = qualify(need, catalog.services);
    let d = decide(q);
    const firstAnswer = !lead.last_out_at;
    const tooLong = lead.auto_replies >= MAX_AUTO_REPLIES;
    if (tooLong) d = { ...d, escalate: true, reasons: [...d.reasons, 'percakapan sudah panjang, perlu Wisnu'] };

    // After the first full answer the conversation engine talks: it reads what the person just wrote and
    // either answers from the owner's catalog or hands over at the moments that decide a sale.
    let conv = null;
    if (!firstAnswer && !tooLong) {
      conv = converse({ text: t, name: lead.name || '', service: q.service, catalog, facts: this.getFacts(), repliesSoFar: lead.auto_replies || 0 });
      if (conv.escalate) d = { ...d, escalate: true, hot: d.hot || conv.hot, reasons: [...new Set([...d.reasons, ...conv.reasons])] };
    }

    const patch = {
      service_id: q.service?.id || lead.service_id || null, need,
      budget_min: q.budget?.min ?? lead.budget_min ?? null, budget_max: q.budget?.max ?? lead.budget_max ?? null,
      deadline_days: q.deadlineDays ?? lead.deadline_days ?? null, urgent: q.urgent || Boolean(lead.urgent),
      score: Math.max(q.score, lead.score || 0), last_in_at: this.now(),
      escalated: d.escalate || Boolean(lead.escalated), escalate_reason: d.escalate ? d.reasons : (lead.escalate_reason || null),
    };
    lead = this.store.updateLead(lead.id, patch);

    // The answer: full the first time, a one-liner afterwards, nothing once the thread is too long.
    let reply = null;
    if (!tooLong) {
      reply = firstAnswer
        ? buildReply(q, catalog, this.getFacts(), { name: lead.name || '', escalate: d.escalate, reasons: d.reasons })
        : (conv ? conv.text : buildFollowUp(q.lang, d.escalate));
    }
    const viaSite = source === 'site';
    const autoSend = Boolean(reply) && (this.autoReply || viaSite);
    if (autoSend) {
      this.store.addMessage(lead.id, 'out', reply, true);
      lead = this.store.updateLead(lead.id, { last_out_at: this.now(), auto_replies: (lead.auto_replies || 0) + 1, status: lead.status === 'new' ? 'contacted' : lead.status });
    }

    // "stop / tidak tertarik": close it, and never write again unless they do. A new message later reopens it.
    if (conv?.close) lead = this.store.updateLead(lead.id, { status: 'lost', escalated: false });
    else if (conv && lead.status === 'lost') lead = this.store.updateLead(lead.id, { status: 'contacted' });

    this.log({
      agent: 'sales', kind: 'lead', level: d.hot || d.escalate ? 'good' : 'info',
      title: `${created ? 'Prospek baru' : 'Pesan lanjutan'}: ${q.service?.name || 'kebutuhan belum jelas'} - ${lead.name || lead.contact} (${source}, skor ${lead.score})`,
      detail: d.escalate ? `Perlu pemilik: ${d.reasons.join('; ')}` : null, ref: String(lead.id),
    });
    // A prospect ready to start, or haggling, or asking for a call is the moment that decides the sale: tell the owner at once.
    await this._maybeNotifyOwner(lead, d, { force: Boolean(conv?.hot) });
    this.emit('lead', { leadId: lead.id, created });
    return { leadId: lead.id, reply, autoSend, escalate: d.escalate, reasons: d.reasons, hot: d.hot, spam: false, rateLimited: false, created };
  }

  /**
   * "What should I answer?": the same conversation engine, for a message the owner received on a channel
   * the agent cannot see (Freelancer chat, a personal WhatsApp). Pure: it records nothing and sends nothing.
   */
  suggest({ text, serviceId = null, name = '', repliesSoFar = 0 } = {}) {
    const t = String(text || '').trim().slice(0, MAX_TEXT);
    if (!t) throw new Error('pesan kosong');
    const catalog = this.store.catalog();
    const q = qualify(t, catalog.services);
    const service = catalog.services.find((s) => s.id === serviceId) || q.service;
    const r = converse({ text: t, name, service, catalog, facts: this.getFacts(), repliesSoFar });
    return { ...r, service: service ? { id: service.id, name: service.name } : null, budget: q.budget, spam: q.spam };
  }

  // ------------------------------------------------------------ owner side

  async _maybeNotifyOwner(lead, d, { force = false } = {}) {
    if (!(d.hot || d.escalate)) return false;
    if (!this.notify || !this.ownerChat()) return false;
    if (!force && lead.hot_notified_at && this.now() - lead.hot_notified_at < HOT_RENOTIFY_MS) return false;
    if (inQuietHours(this.now())) return false; // held: the heartbeat sends it in the morning
    const cat = this.store.catalog();
    const svc = cat.services.find((s) => s.id === lead.service_id);
    const lines = [
      `Prospek ${d.hot ? 'panas' : 'baru'} #${lead.id} (skor ${lead.score}) via ${lead.source}`,
      `${lead.name || lead.contact}${lead.name ? ` (${lead.contact})` : ''}`,
      `Butuh: ${svc?.name || 'belum jelas'}`,
    ];
    if (lead.budget_max) lines.push(`Anggaran: ${rupiah(lead.budget_min)}${lead.budget_max !== lead.budget_min ? ` - ${rupiah(lead.budget_max)}` : ''}`);
    if (lead.deadline_days != null) lines.push(`Tenggat: sekitar ${lead.deadline_days} hari`);
    if (d.escalate) lines.push(`Perlu Mas: ${d.reasons.join('; ')}`);
    lines.push(lead.last_out_at ? 'Sudah dibalas otomatis.' : 'Belum dibalas.', `Ketik "prospek ${lead.id}" untuk detailnya.`);
    try {
      await this.notify(this.ownerChat(), lines.join('\n'));
    } catch (e) {
      this.log({ agent: 'sales', kind: 'notify_fail', level: 'warn', title: 'Pemberitahuan prospek ke Telegram gagal', detail: String(e?.message || e) });
      return false;
    }
    this.store.updateLead(lead.id, { hot_notified_at: this.now() });
    return true;
  }

  /** Hot/escalated leads that were held back by quiet hours or a Telegram failure. */
  async flush() {
    const open = this.store.listLeads({ open: true, limit: 50 }).leads;
    let sent = 0;
    for (const l of open) {
      const d = { hot: l.score >= 60, escalate: l.escalated, reasons: l.escalate_reason || [] };
      if ((d.hot || d.escalate) && !l.hot_notified_at && await this._maybeNotifyOwner(l, d)) sent += 1;
    }
    return sent;
  }

  /**
   * The owner's own answer to a lead: sent on the lead's channel when that channel can send,
   * always recorded. The owner answering is what ends "needs the owner".
   */
  async ownerReply(leadId, text) {
    const lead = this.store.getLead(leadId);
    if (!lead) throw new Error('prospek tidak ditemukan');
    const body = String(text || '').trim().slice(0, 4000);
    if (!body) throw new Error('isi balasan kosong');
    const send = this.senders[lead.source];
    let sent = false;
    if (send) { await send(lead.contact, body); sent = true; }
    this.store.addMessage(lead.id, 'out', body, false);
    this.store.updateLead(lead.id, { last_out_at: this.now(), escalated: false, status: ['new', 'qualified'].includes(lead.status) ? 'contacted' : lead.status });
    this.log({ agent: 'sales', kind: 'owner_reply', title: `Balasan pemilik untuk prospek #${lead.id}${sent ? ' terkirim' : ' dicatat (kanal ini belum bisa mengirim)'}` });
    return { sent };
  }

  setStatus(id, status, { notes = null, value = null } = {}) {
    const lead = this.store.getLead(id);
    if (!lead) throw new Error('prospek tidak ditemukan');
    const patch = { status };
    if (notes) patch.notes = String(notes).slice(0, 500);
    if (value != null) patch.value_idr = Math.max(0, Math.round(Number(value)) || 0);
    if (['won', 'lost', 'spam'].includes(status)) patch.escalated = false;
    const out = this.store.updateLead(id, patch);
    this.log({ agent: 'sales', kind: 'status', level: status === 'won' ? 'good' : 'info', title: `Prospek #${id} (${lead.name || lead.contact}) -> ${status}${status === 'won' && out.value_idr ? ` (${rupiah(out.value_idr)})` : ''}`, ref: String(id) });
    return out;
  }

  /** Lines for the owner's daily report; empty on a quiet day. */
  reportLines({ since }) {
    const db = this.store.db;
    const fresh = db.prepare("SELECT COUNT(*) c FROM sales_leads WHERE created_at >= ? AND status != 'spam'").get(since).c;
    const st = this.store.stats();
    const won = db.prepare("SELECT COUNT(*) c, COALESCE(SUM(value_idr), 0) v FROM sales_leads WHERE status = 'won' AND updated_at >= ?").get(since);
    const out = [];
    if (fresh) out.push(`Klien: ${fresh} prospek baru${st.needsOwner ? `, ${st.needsOwner} perlu Mas` : ''}`);
    else if (st.needsOwner) out.push(`Klien: ${st.needsOwner} prospek menunggu Mas`);
    if (won.c) out.push(`Deal: ${won.c} proyek${won.v ? ` (${rupiah(won.v)})` : ''}`);
    return out;
  }

  start() {
    if (this.timer) return false;
    this.timer = setInterval(() => this.flush().catch(() => {}), TICK_MS);
    this.timer.unref?.();
    return true;
  }

  stop() { clearInterval(this.timer); this.timer = null; }
}

export function createSales(deps) {
  const store = deps.store || new SalesStore(deps.db);
  return new SalesService({ ...deps, store });
}
