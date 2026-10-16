/**
 * Aktivitas: a live, readable log of what the agent did and why. Grouped by day, filterable by
 * which part of the agent did it, details tucked away until asked for.
 */

import { useMemo, useState } from 'react';
import { Section, Empty, Filters } from './ui.jsx';
import { clock, groupByDay } from './api.js';

const AGENT = { career: 'Karir', sales: 'Klien', market: 'Pasar', email: 'Email', system: 'Sistem' };

function Item({ a }) {
  const [open, setOpen] = useState(false);
  return (
    <li className={`ag-ev lv-${a.level}`}>
      <i aria-hidden="true" />
      <div className="ag-ev-b">
        <div className="ag-ev-h">
          <strong>{a.title}</strong>
          <span className="ag-tag">{AGENT[a.agent] || a.agent}</span>
        </div>
        {a.detail ? (
          <>
            <button type="button" className="ag-more" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? 'Sembunyikan rincian' : 'Lihat rincian'}</button>
            {open ? <pre className="ag-detail">{a.detail}</pre> : null}
          </>
        ) : null}
      </div>
      <time title={new Date(a.ts).toLocaleString('id-ID')}>{clock(a.ts)}</time>
    </li>
  );
}

export default function ActivityFeed({ items, onMore, canMore }) {
  const [agent, setAgent] = useState('');
  const [important, setImportant] = useState(false);

  const agents = useMemo(() => [...new Set(items.map((i) => i.agent))], [items]);
  const shown = useMemo(
    () => items.filter((i) => (!agent || i.agent === agent) && (!important || i.level !== 'info')),
    [items, agent, important],
  );
  const groups = useMemo(() => groupByDay(shown), [shown]);

  return (
    <Section title="Aktivitas agent" hint="Diperbarui otomatis tiap beberapa detik.">
      <div className="ag-toolbar">
        <Filters value={agent} onChange={setAgent} options={[['', 'Semua'], ...agents.map((a) => [a, AGENT[a] || a])]} />
        <label className="ag-toggle">
          <input type="checkbox" checked={important} onChange={(e) => setImportant(e.target.checked)} />
          <span>Hanya yang penting</span>
        </label>
      </div>
      {!groups.length ? <Empty title="Belum ada aktivitas di filter ini" hint="Tekan “Pindai sekarang” atau tunggu pemindaian terjadwal." /> : groups.map((g) => (
        <div key={g.label} className="ag-day">
          <h3>{g.label}</h3>
          <ol className="ag-evs" aria-live="polite">{g.items.map((a) => <Item key={a.id} a={a} />)}</ol>
        </div>
      ))}
      {canMore ? <button type="button" className="ag-ghost" onClick={onMore}>Tampilkan lebih banyak</button> : null}
    </Section>
  );
}
