/**
 * Klien: people who asked for the owner's services. The agent has already answered them; this is
 * where the owner sees the conversation, answers personally, and moves a lead toward "menang".
 */

import { useCallback, useEffect, useState } from 'react';
import { Badge, Empty, Filters, Section, Skeleton } from './ui.jsx';
import { salesApi, ago, rupiah } from './api.js';

const STATUS = {
  new: 'Baru', contacted: 'Sudah dihubungi', qualified: 'Terkualifikasi', proposal: 'Penawaran',
  negotiating: 'Negosiasi', won: 'Menang', lost: 'Kalah', spam: 'Spam',
};
const SOURCE = { whatsapp: 'WhatsApp', site: 'Website', email: 'Email' };

function Conversation({ id, onSent, setError }) {
  const [data, setData] = useState(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    try { setData(await salesApi(`/leads/${id}`)); } catch (e) { setError(e.message); }
  }, [id, setError]);
  useEffect(() => { load(); }, [load]);

  const send = async (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    setSending(true);
    try {
      const r = await salesApi(`/leads/${id}/reply`, { method: 'POST', body: { text } });
      setText('');
      await load(); onSent?.(r);
    } catch (err) { setError(err.message); } finally { setSending(false); }
  };

  if (!data) return <Skeleton rows={3} />;
  return (
    <div className="ag-convo">
      <ol className="ag-msgs">
        {data.messages.map((m) => (
          <li key={m.id} className={m.direction === 'in' ? 'in' : (m.auto ? 'out auto' : 'out')}>
            <small>{m.direction === 'in' ? 'Calon klien' : (m.auto ? 'Agent (otomatis)' : 'Mas')} · {ago(m.ts)}</small>
            <p>{m.text}</p>
          </li>
        ))}
      </ol>
      <form className="ag-reply" onSubmit={send}>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="Tulis balasan Mas sendiri…" aria-label="Balasan untuk calon klien" maxLength={1500} />
        <button type="submit" className="ag-btn sm" disabled={sending || !text.trim()}>{sending ? 'Mengirim…' : 'Kirim balasan'}</button>
      </form>
      <p className="ag-note">Dikirim lewat kanal asalnya bila kanal itu sudah tersambung; kalau belum, hanya dicatat.</p>
    </div>
  );
}

function Lead({ lead, services, busy, onStatus, setError, refresh }) {
  const [open, setOpen] = useState(false);
  const svc = services.find((s) => s.id === lead.service_id);
  return (
    <article className={`ag-lead ${lead.escalated ? 'needs' : ''}`}>
      <div className="ag-lead-h">
        <div className="ag-lead-t">
          <h3>{lead.name || lead.contact}</h3>
          <p className="ag-meta">
            <span>{SOURCE[lead.source] || lead.source}</span>
            {lead.name ? <span>{lead.contact}</span> : null}
            <span>{ago(lead.last_in_at || lead.created_at)}</span>
          </p>
        </div>
        <div className="ag-lead-s">
          {lead.escalated ? <Badge tone="warn">Perlu Mas</Badge> : null}
          {lead.score >= 60 ? <Badge tone="good">Panas · {lead.score}</Badge> : <Badge tone="neutral">Skor {lead.score}</Badge>}
        </div>
      </div>
      <div className="ag-chips">
        <span className="ag-chip">{svc?.name || 'Kebutuhan belum jelas'}</span>
        {lead.budget_max ? <span className="ag-chip good">Anggaran {rupiah(lead.budget_min)}{lead.budget_max !== lead.budget_min ? ` – ${rupiah(lead.budget_max)}` : ''}</span> : null}
        {lead.deadline_days != null ? <span className={`ag-chip ${lead.urgent ? 'warn' : ''}`}>Tenggat ±{lead.deadline_days} hari</span> : null}
        {lead.value_idr ? <span className="ag-chip good">Nilai {rupiah(lead.value_idr)}</span> : null}
        {(lead.escalate_reason || []).map((r) => <span key={r} className="ag-chip warn">{r}</span>)}
      </div>
      <div className="ag-lead-a">
        <button type="button" className="ag-btn sm ghost" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? 'Tutup percakapan' : 'Lihat percakapan'}</button>
        <select aria-label={`Status untuk ${lead.name || lead.contact}`} value={lead.status} disabled={busy} onChange={(e) => onStatus(lead, e.target.value)}>
          {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      {open ? <Conversation id={lead.id} onSent={refresh} setError={setError} /> : null}
    </article>
  );
}

export default function LeadsTab({ summary, goto, onChanged, setError }) {
  const [filter, setFilter] = useState('open');
  const [data, setData] = useState(null);
  const [services, setServices] = useState([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(0);

  const load = useCallback(async () => {
    try {
      const p = new URLSearchParams({ limit: '60' });
      if (filter === 'open') p.set('open', '1');
      else if (filter) p.set('status', filter);
      if (q.trim()) p.set('q', q.trim());
      const [leads, cat] = await Promise.all([salesApi(`/leads?${p}`), salesApi('/catalog')]);
      setData(leads); setServices(cat.services);
    } catch (e) { setError(e.message); }
  }, [filter, q, setError]);

  useEffect(() => {
    const t = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  const onStatus = async (lead, next) => {
    let value = null;
    if (next === 'won') {
      const v = window.prompt('Nilai proyek (Rp), boleh dikosongkan:', lead.budget_max || '');
      if (v === null) return;
      value = Number(String(v).replace(/\D/g, '')) || null;
    }
    setBusy(lead.id);
    try { await salesApi(`/leads/${lead.id}/status`, { method: 'POST', body: { status: next, value } }); await load(); onChanged?.(); } catch (e) { setError(e.message); } finally { setBusy(0); }
  };

  const st = summary?.stats || {};
  const unapproved = summary && summary.catalog.pricesApproved < summary.catalog.services;

  return (
    <Section title="Calon klien" hint="Orang yang menulis lewat website atau WhatsApp. Agent sudah menjawab; Mas hanya perlu turun tangan bila diminta.">
      {unapproved ? (
        <div className="ag-callout">
          <div><strong>Agent belum boleh menyebut harga</strong><p>Sampai harga disetujui, ia hanya mengumpulkan kebutuhan dan menjawab bahwa estimasi menyusul.</p></div>
          <button type="button" className="ag-btn sm" onClick={() => goto('services')}>Atur harga</button>
        </div>
      ) : null}
      <div className="ag-toolbar">
        <Filters value={filter} onChange={setFilter} options={[['open', 'Aktif', st.open], ['won', 'Menang'], ['lost', 'Kalah'], ['spam', 'Spam'], ['', 'Semua']]} />
        <input className="ag-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cari nama / kontak / kebutuhan" aria-label="Cari prospek" />
      </div>
      {!data ? <Skeleton rows={3} /> : (
        <>
          <p className="ag-count">{data.total} prospek</p>
          {!data.leads.length
            ? <Empty title="Belum ada prospek di filter ini" hint="Prospek muncul saat seseorang menulis lewat formulir website atau WhatsApp nomor toko. Agent tidak menghubungi orang yang belum menulis lebih dulu." />
            : data.leads.map((l) => <Lead key={l.id} lead={l} services={services} busy={busy === l.id} onStatus={onStatus} setError={setError} refresh={load} />)}
        </>
      )}
    </Section>
  );
}
