/**
 * Layanan: what the agent may sell, and at what price. Prices and payment terms are the owner's
 * decision: until a price is approved here, the agent never quotes a number.
 */

import { useCallback, useEffect, useState } from 'react';
import { Badge, Section, Skeleton } from './ui.jsx';
import { salesApi, priceText } from './api.js';

const UNITS = ['proyek', 'bulan', 'jam', 'halaman'];

function Service({ s, onSave, onApprove, busy }) {
  const [min, setMin] = useState(s.price.min);
  const [max, setMax] = useState(s.price.max);
  const [unit, setUnit] = useState(s.price.unit);
  const dirty = Number(min) !== s.price.min || Number(max) !== s.price.max || unit !== s.price.unit;

  useEffect(() => { setMin(s.price.min); setMax(s.price.max); setUnit(s.price.unit); }, [s.price.min, s.price.max, s.price.unit]);

  return (
    <article className={`ag-svc ${s.price.approved ? 'ok' : ''}`}>
      <header>
        <h3>{s.name}</h3>
        {s.price.approved ? <Badge tone="good">Harga disetujui</Badge> : <Badge tone="warn">Harga belum disetujui</Badge>}
      </header>
      <p className="ag-svc-sum">{s.summary}</p>
      <ul className="ag-svc-del">{s.deliverables.map((d) => <li key={d}>{d}</li>)}</ul>
      <div className="ag-price">
        <label><span>Dari (Rp)</span><input type="number" inputMode="numeric" min="50000" step="100000" value={min} onChange={(e) => setMin(e.target.value)} /></label>
        <label><span>Sampai (Rp)</span><input type="number" inputMode="numeric" min="50000" step="100000" value={max} onChange={(e) => setMax(e.target.value)} /></label>
        <label><span>Satuan</span><select value={unit} onChange={(e) => setUnit(e.target.value)}>{UNITS.map((u) => <option key={u} value={u}>{u}</option>)}</select></label>
      </div>
      <footer>
        <span className="ag-svc-now">{priceText({ min: Number(min), max: Number(max), unit })} · {s.days[0]}–{s.days[1]} hari kerja</span>
        <div>
          {dirty ? <button type="button" className="ag-btn sm ghost" disabled={busy} onClick={() => onSave(s.id, { min: Number(min), max: Number(max), unit }, false)}>Simpan</button> : null}
          {dirty || !s.price.approved
            ? <button type="button" className="ag-btn sm" disabled={busy} onClick={() => onSave(s.id, { min: Number(min), max: Number(max), unit }, true)}>{dirty ? 'Simpan & setujui' : 'Setujui harga'}</button>
            : null}
        </div>
      </footer>
    </article>
  );
}

export default function ServicesTab({ onChanged, setError }) {
  const [cat, setCat] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setCat(await salesApi('/catalog')); } catch (e) { setError(e.message); }
  }, [setError]);
  useEffect(() => { load(); }, [load]);

  const wrap = async (fn) => {
    setBusy(true);
    try { await fn(); await load(); onChanged?.(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const save = (id, price, approve) => wrap(() => salesApi(`/catalog/${id}`, { method: 'PUT', body: { price: { ...price, approved: approve } } }));
  const approveAll = (terms) => wrap(() => salesApi('/catalog/approve', { method: 'POST', body: { terms } }));

  if (!cat) return <Section title="Layanan & harga"><Skeleton rows={4} /></Section>;
  const pending = cat.services.filter((s) => !s.price.approved).length;

  return (
    <div className="ag-stack">
      <Section
        title="Layanan & harga"
        hint="Daftar ini bersumber dari portofolio Anda. Angka awal hanyalah usulan: agent tidak akan menyebutnya sebelum Anda setujui."
        action={pending ? <button type="button" className="ag-btn sm" disabled={busy} onClick={() => approveAll(false)}>Setujui semua harga ({pending})</button> : <Badge tone="good">Semua harga disetujui</Badge>}
      >
        <div className="ag-svc-grid">
          {cat.services.map((s) => <Service key={s.id} s={s} busy={busy} onSave={save} />)}
        </div>
      </Section>

      <Section
        title="Syarat pembayaran"
        hint="Disebut ke calon klien hanya setelah disetujui."
        action={cat.terms.approved ? <Badge tone="good">Disetujui</Badge> : <button type="button" className="ag-btn sm ghost" disabled={busy} onClick={() => approveAll(true)}>Setujui syarat</button>}
      >
        <dl className="ag-health">
          <div><dt>Pembayaran</dt><dd>{cat.terms.payment}</dd></div>
          <div><dt>Revisi</dt><dd>{cat.terms.revisions}×</dd></div>
          <div><dt>Uang muka</dt><dd>{cat.terms.dpPercent}%</dd></div>
        </dl>
      </Section>
    </div>
  );
}
