/**
 * Peluang: people who may need the owner's services, found by the radar (Freelancer.com projects and local
 * businesses without a website). The agent prepares the message; the OWNER sends it (marketplace and WhatsApp
 * rules forbid robots making first contact, and a banned number costs far more than any lead is worth).
 * Also: "Asisten balasan" for a client message received anywhere the agent cannot see.
 */

import { useCallback, useEffect, useState } from 'react';
import { ScoreRing, Chips, Filters, Empty, Skeleton, Section, Badge } from './ui.jsx';
import { salesApi, ago, copyText } from './api.js';

const STATUS = { new: 'Baru', contacted: 'Sudah dihubungi', replied: 'Sudah membalas', negotiating: 'Negosiasi', won: 'Menang', lost: 'Kalah', skipped: 'Dilewati' };
const INTENT = { stop: 'menolak', ready: 'siap lanjut', haggle: 'menawar harga', call: 'minta bicara', trust: 'meragukan', price: 'tanya harga', timeline: 'tanya waktu', proof: 'minta contoh', ack: 'konfirmasi', brief: 'memberi detail' };

function CopyBtn({ text, label = 'Salin pesan' }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="ag-more" onClick={async () => { if (await copyText(text)) { setDone(true); setTimeout(() => setDone(false), 1500); } }}>
      {done ? 'Tersalin ✓' : label}
    </button>
  );
}

function Draft({ id, onStatus, setError }) {
  const [d, setD] = useState(null);
  useEffect(() => {
    let live = true;
    salesApi(`/prospects/${id}`).then((x) => { if (live) setD(x); }).catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [id, setError]);
  if (!d) return <div className="ag-kit"><Skeleton rows={4} /></div>;
  const local = d.kind === 'local';
  return (
    <div className="ag-kit">
      {(d.warnings || []).map((w) => <p key={w} className="ag-callout-s">{w}</p>)}
      <div className="ag-kit-h"><h4>{local ? 'Pesan WhatsApp' : 'Pesan penawaran'}</h4><CopyBtn text={d.text} /></div>
      <textarea className="ag-letter" readOnly value={d.text} rows={Math.min(16, d.text.split('\n').length + 1)} aria-label="Pesan siap kirim" />
      {d.bid ? <p className="ag-note">Saran penawaran: <strong>{d.bid.currency} {d.bid.amount}</strong> ({d.bid.note}).</p> : null}
      <div className="ag-kit-a">
        {d.link
          ? <a className="ag-btn" href={d.link} target="_blank" rel="noopener noreferrer">{local ? 'Buka WhatsApp dengan pesan terisi' : 'Buka proyek di Freelancer.com'}</a>
          : <span className="ag-note">Tidak ada nomor ponsel: hubungi lewat telepon ({d.prospect.contact ? `+${d.prospect.contact}` : '-'}).</span>}
        <button type="button" className="ag-btn ghost" onClick={() => onStatus(d.prospect.id, 'contacted')}>Tandai sudah dihubungi</button>
        <button type="button" className="ag-btn ghost" onClick={() => onStatus(d.prospect.id, 'skipped')}>Lewati</button>
      </div>
      {local ? <p className="ag-note">Sesudah ditandai, agent mengingatkan Mas menindaklanjuti dua hari lagi bila belum ada balasan (maksimal dua kali).</p> : null}
      {d.followUp ? (
        <>
          <div className="ag-kit-h"><h4>Pesan tindak lanjut (untuk nanti)</h4><CopyBtn text={d.followUp.text} label="Salin" /></div>
          <p className="ag-note">{d.followUp.text}</p>
        </>
      ) : null}
    </div>
  );
}

function Prospect({ p, busy, onStatus, setError }) {
  const [open, setOpen] = useState(false);
  const local = p.kind === 'local';
  return (
    <article className={`ag-job v-${p.verdict === 'good' ? 'apply' : p.verdict === 'maybe' ? 'maybe' : 'skip'}`}>
      <ScoreRing value={p.score} />
      <div className="ag-job-m">
        <h3>{local ? p.title : <a href={p.url} target="_blank" rel="noopener noreferrer">{p.title}</a>}</h3>
        <p className="ag-meta">
          <span>{local ? (p.description || p.category) : 'Freelancer.com'}</span>
          {!local && p.budget_max ? <span>{p.currency} {p.budget_min}–{p.budget_max}{p.hourly ? '/jam' : ''}</span> : null}
          {!local ? <span>{p.bids} penawar</span> : <span>{p.mobile ? 'ponsel' : 'telepon rumah'}</span>}
          <span>#{p.id}</span>
          <span>{ago(p.first_seen)}</span>
        </p>
        <div className="ag-chips">
          <span className={`ag-badge t-${p.verdict === 'good' ? 'good' : p.verdict === 'maybe' ? 'warn' : 'neutral'}`}>{p.verdict === 'good' ? 'Cocok' : p.verdict === 'maybe' ? 'Periksa dulu' : 'Dilewati'}</span>
          <Chips items={p.reasons} tone="good" max={3} open={open} />
          <Chips items={p.warnings} tone="warn" max={2} open={open} />
        </div>
      </div>
      <div className="ag-job-a">
        <select aria-label={`Status untuk ${p.title}`} value={p.status} disabled={busy} onChange={(e) => onStatus(p.id, e.target.value)}>
          {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <button type="button" className={`ag-btn sm ${open ? 'ghost' : ''}`} aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? 'Tutup' : 'Siapkan pesan'}</button>
      </div>
      {open ? <div className="ag-job-kit"><Draft id={p.id} onStatus={onStatus} setError={setError} /></div> : null}
    </article>
  );
}

function Suggest({ setError }) {
  const [text, setText] = useState('');
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const go = async (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    try { setRes(await salesApi('/suggest', { method: 'POST', body: { text } })); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return (
    <Section title="Asisten balasan" hint="Klien membalas di Freelancer.com atau WhatsApp pribadi Mas? Tempel pesannya di sini, agent menyarankan jawabannya.">
      <form className="ag-reply" onSubmit={go}>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={1200} placeholder="Tempel pesan dari klien…" aria-label="Pesan dari klien" />
        <button type="submit" className="ag-btn sm" disabled={busy || !text.trim()}>{busy ? 'Menyusun…' : 'Sarankan balasan'}</button>
      </form>
      {res ? (
        <div className="ag-kit">
          <div className="ag-chips">
            <Badge tone={res.escalate ? 'warn' : res.close ? 'bad' : 'good'}>{INTENT[res.intent] || res.intent}</Badge>
            {res.service ? <span className="ag-chip">{res.service.name}</span> : null}
          </div>
          <div className="ag-kit-h"><h4>Saran balasan</h4><CopyBtn text={res.text} label="Salin balasan" /></div>
          <textarea className="ag-letter" readOnly value={res.text} rows={Math.min(14, res.text.split('\n').length + 1)} aria-label="Saran balasan" />
          {res.escalate ? <p className="ag-callout-s">Bagian ini sebaiknya Mas sendiri yang menjawab: {res.reasons.join('; ')}.</p> : null}
          {res.close ? <p className="ag-note">Klien menolak: tidak perlu dikejar lagi.</p> : null}
        </div>
      ) : null}
    </Section>
  );
}

export default function ProspectsTab({ summary, onChanged, setError }) {
  const [filter, setFilter] = useState('local');
  const [q, setQ] = useState('');
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(0);
  const [scanning, setScanning] = useState(false);

  const load = useCallback(async () => {
    try {
      const p = new URLSearchParams({ limit: '60' });
      if (filter === 'local') { p.set('kind', 'local'); p.set('verdict', 'good'); p.set('status', 'new'); }
      else if (filter === 'marketplace') { p.set('kind', 'marketplace'); p.set('verdict', 'good'); p.set('status', 'new'); }
      else if (filter === 'contacted') p.set('status', 'contacted');
      if (q.trim()) p.set('q', q.trim());
      setData(await salesApi(`/prospects?${p}`));
    } catch (e) { setError(e.message); }
  }, [filter, q, setError]);

  useEffect(() => {
    const t = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  const change = async (id, status) => {
    setBusy(id);
    try { await salesApi(`/prospects/${id}/status`, { method: 'POST', body: { status } }); await load(); onChanged?.(); } catch (e) { setError(e.message); } finally { setBusy(0); }
  };

  const scan = async () => {
    setScanning(true);
    try { await salesApi('/prospects/scan', { method: 'POST', body: { force: true } }); setTimeout(load, 6000); } catch (e) { setError(e.message); } finally { setScanning(false); }
  };

  const st = data?.stats || summary?.prospects || {};
  return (
    <div className="ag-stack">
      <Section
        title="Peluang klien"
        hint="Orang yang mungkin butuh jasa Mas. Agent menyiapkan pesannya; Mas yang mengirim, karena aturan WhatsApp dan marketplace melarang robot menghubungi lebih dulu."
        action={<button type="button" className="ag-btn sm ghost" onClick={scan} disabled={scanning}>{scanning ? 'Memindai…' : 'Pindai sekarang'}</button>}
      >
        <div className="ag-toolbar">
          <Filters value={filter} onChange={setFilter} options={[['local', 'Usaha lokal', st.goodLocal], ['marketplace', 'Freelancer.com', st.goodMarket], ['contacted', 'Sudah dihubungi', st.byStatus?.contacted], ['', 'Semua']]} />
          <input className="ag-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cari nama / judul" aria-label="Cari peluang" />
        </div>
        {!data ? <Skeleton rows={4} /> : (
          <>
            <p className="ag-count">{data.total} peluang{filter === 'local' ? ' · tiap pagi pukul 08.00 saya kirim paket terbaik ke Telegram' : ''}</p>
            {!data.prospects.length
              ? <Empty title="Belum ada peluang di filter ini" hint="Radar membaca Freelancer.com tiap 6 jam dan usaha lokal tanpa website tiap 3 hari. Di Freelancer.com, kebanyakan proyek sudah dibanjiri ratusan penawar, jadi hanya yang masih sepi yang ditampilkan sebagai cocok." />
              : data.prospects.map((p) => <Prospect key={p.id} p={p} busy={busy === p.id} onStatus={change} setError={setError} />)}
          </>
        )}
      </Section>
      <Suggest setError={setError} />
    </div>
  );
}
