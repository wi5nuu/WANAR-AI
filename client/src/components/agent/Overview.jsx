/**
 * Ringkasan: what needs the owner right now, the numbers that matter, the 19.00 report as the owner
 * will receive it, and whether the agent itself is healthy.
 */

import { Kpi, Section, Empty, Skeleton, Badge } from './ui.jsx';
import { ago, clock, priceText } from './api.js';

const AGENT = { career: 'Karir', sales: 'Klien', market: 'Pasar', email: 'Email', system: 'Sistem' };

function Attention({ jobs, leads, goto }) {
  const rows = [
    ...leads.map((l) => ({
      key: `l${l.id}`, kind: 'Klien', title: `${l.name || l.contact}`, meta: (l.escalate_reason || []).slice(0, 2).join(' · ') || 'Menunggu balasan Mas',
      cta: 'Buka', go: () => goto('leads'),
    })),
    ...jobs.map((j) => ({
      key: `j${j.id}`, kind: 'Lowongan', title: j.title, meta: `${j.company || 'Perusahaan tidak disebut'} · skor ${j.score}`,
      cta: 'Lihat', href: j.url,
    })),
  ].slice(0, 6);

  if (!rows.length) return <Empty title="Tidak ada yang perlu diputuskan" hint="Agent bekerja sendiri dan akan mengabari bila ada prospek serius atau lowongan yang layak." />;
  return (
    <ul className="ag-attn">
      {rows.map((r) => (
        <li key={r.key}>
          <span className={`ag-kind k-${r.kind === 'Klien' ? 'sales' : 'job'}`}>{r.kind}</span>
          <div><strong>{r.title}</strong><small>{r.meta}</small></div>
          {r.href
            ? <a className="ag-link" href={r.href} target="_blank" rel="noopener noreferrer">{r.cta}</a>
            : <button type="button" className="ag-link" onClick={r.go}>{r.cta}</button>}
        </li>
      ))}
    </ul>
  );
}

export default function Overview({ status, report, salesSum, jobs, leads, feed, goto }) {
  const loading = !status || !report;
  const st = status || {};
  const ss = salesSum?.stats || {};
  const f = report?.facts || {};
  const by = st.byStatus || {};
  const cat = salesSum?.catalog;

  return (
    <div className="ag-stack">
      <Section title="Perlu keputusan Mas" hint="Hanya yang benar-benar menunggu Anda.">
        {loading ? <Skeleton rows={2} /> : <Attention jobs={jobs} leads={leads} goto={goto} />}
      </Section>

      <div className="ag-kpi-groups">
        <div>
          <h3 className="ag-group">Karir</h3>
          <div className="ag-kpis">
            <Kpi label="Layak dilamar" value={st.apply ?? '–'} tone="good" hint="belum diproses" />
            <Kpi label="Sudah dilamar" value={by.applied || 0} hint={`${f.applied ?? 0} dalam 24 jam`} />
            <Kpi label="Wawancara / penawaran" value={(by.interview || 0) + (by.offer || 0)} tone="good" />
          </div>
        </div>
        <div>
          <h3 className="ag-group">Klien</h3>
          <div className="ag-kpis">
            <Kpi label="Prospek aktif" value={ss.open ?? '–'} hint={`${ss.newToday ?? 0} baru 24 jam`} />
            <Kpi label="Perlu Mas" value={ss.needsOwner ?? '–'} tone={ss.needsOwner ? 'warn' : ''} />
            <Kpi label="Deal 30 hari" value={ss.won30?.n ?? 0} tone="good" hint={ss.won30?.v ? `Rp${Math.round(ss.won30.v).toLocaleString('id-ID')}` : null} />
          </div>
        </div>
      </div>

      <div className="ag-two">
        <Section title="Laporan 19.00 WIB" hint="Isinya persis seperti yang dikirim ke Telegram, dihitung dari data sekarang.">
          {report ? <pre className="ag-report">{report.text}</pre> : <Skeleton rows={5} />}
        </Section>

        <Section title="Kesehatan agent" hint="Apakah agent benar-benar bekerja terus.">
          {loading ? <Skeleton rows={4} /> : (
            <dl className="ag-health">
              <div><dt>Radar lowongan</dt><dd>{st.running ? <Badge tone="warn">sedang memindai</Badge> : f.stalled ? <Badge tone="bad">berhenti</Badge> : st.enabled === false ? <Badge tone="neutral">dimatikan</Badge> : <Badge tone="good">aktif</Badge>}</dd></div>
              <div><dt>Pemindaian terakhir</dt><dd>{ago(st.lastScan)}</dd></div>
              <div><dt>Interval</dt><dd>tiap {st.intervalHours || 6} jam</dd></div>
              <div><dt>Restart (24 jam)</dt><dd>{f.restarts ?? 0}×</dd></div>
              <div><dt>Sumber gagal (24 jam)</dt><dd>{f.sourceErrors ?? 0}×</dd></div>
              <div><dt>Balas klien otomatis</dt><dd>{salesSum ? (salesSum.autoReply ? <Badge tone="good">menyala</Badge> : <Badge tone="neutral">hanya draf</Badge>) : '–'}</dd></div>
              {cat ? <div><dt>Harga yang boleh disebut</dt><dd>{cat.pricesApproved} dari {cat.services} layanan</dd></div> : null}
            </dl>
          )}
        </Section>
      </div>

      <Section title="Terakhir dikerjakan" action={<button type="button" className="ag-link" onClick={() => goto('feed')}>Semua aktivitas</button>}>
        {!feed.length ? <Skeleton rows={3} /> : (
          <ul className="ag-recent">
            {feed.slice(0, 6).map((a) => (
              <li key={a.id} className={`lv-${a.level}`}>
                <i aria-hidden="true" />
                <span>{a.title}</span>
                <em>{AGENT[a.agent] || a.agent}</em>
                <time>{clock(a.ts)}</time>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

export { priceText };
