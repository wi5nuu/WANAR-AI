/**
 * Lowongan: remote jobs the radar found, scored against the owner's real profile, with the reasons
 * and one status per posting (the pipeline).
 */

import { useCallback, useEffect, useState } from 'react';
import { ScoreRing, Chips, Filters, Empty, Skeleton, Section } from './ui.jsx';
import { careerApi, ago } from './api.js';

const STATUS = {
  new: 'Baru', shortlisted: 'Dipilih', applying: 'Sedang dilamar', applied: 'Sudah dilamar',
  interview: 'Wawancara', offer: 'Penawaran', rejected: 'Ditolak', skipped: 'Dilewati',
};
const VERDICT = { apply: 'Layak dilamar', maybe: 'Perlu dicek', skip: 'Dilewati' };

function Job({ job, busy, onStatus }) {
  const [open, setOpen] = useState(false);
  const more = job.reasons.length > 3 || job.warnings.length > 2;
  return (
    <article className={`ag-job v-${job.verdict}`}>
      <ScoreRing value={job.score} />
      <div className="ag-job-m">
        <h3><a href={job.url} target="_blank" rel="noopener noreferrer">{job.title}</a></h3>
        <p className="ag-meta">
          <span>{job.company || 'Perusahaan tidak disebut'}</span>
          {job.location ? <span>{job.location}</span> : null}
          {job.salary_text ? <span>{job.salary_text}</span> : null}
          <span className="ag-src">{job.source.split(':')[0]}</span>
          <span>{ago(job.first_seen)}</span>
        </p>
        <div className="ag-chips">
          <span className={`ag-badge t-${job.verdict === 'apply' ? 'good' : job.verdict === 'maybe' ? 'warn' : 'neutral'}`}>{VERDICT[job.verdict]}</span>
          <Chips items={job.reasons} tone="good" max={3} open={open} />
          <Chips items={job.warnings} tone="warn" max={2} open={open} />
          {more ? <button type="button" className="ag-more" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? 'ringkas' : 'semua alasan'}</button> : null}
        </div>
      </div>
      <div className="ag-job-a">
        <select aria-label={`Status untuk ${job.title}`} value={job.status} disabled={busy} onChange={(e) => onStatus(job.id, e.target.value)}>
          {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <a className="ag-btn sm" href={job.url} target="_blank" rel="noopener noreferrer">Buka</a>
      </div>
    </article>
  );
}

export default function JobsTab({ status, onChanged, setError }) {
  const [verdict, setVerdict] = useState('apply');
  const [q, setQ] = useState('');
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(0);

  const load = useCallback(async () => {
    try {
      const p = new URLSearchParams({ limit: '60' });
      if (verdict) p.set('verdict', verdict);
      if (q.trim()) p.set('q', q.trim());
      setData(await careerApi(`/jobs?${p}`));
    } catch (e) { setError(e.message); }
  }, [verdict, q, setError]);

  useEffect(() => {
    const t = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  const change = async (id, next) => {
    setBusy(id);
    try { await careerApi(`/jobs/${id}/status`, { method: 'POST', body: { status: next } }); await load(); onChanged?.(); } catch (e) { setError(e.message); } finally { setBusy(0); }
  };

  return (
    <Section title="Lowongan remote" hint="Dibaca dari sumber resmi, dinilai dengan aturan tertulis terhadap profil Anda.">
      <div className="ag-toolbar">
        <Filters value={verdict} onChange={setVerdict} options={[['apply', 'Layak dilamar', status?.apply], ['maybe', 'Perlu dicek', status?.maybe], ['skip', 'Dilewati'], ['', 'Semua']]} />
        <input className="ag-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cari judul / perusahaan" aria-label="Cari lowongan" />
      </div>
      {!data ? <Skeleton rows={4} /> : (
        <>
          <p className="ag-count">{data.total} lowongan</p>
          {!data.jobs.length
            ? <Empty title="Tidak ada lowongan di filter ini" hint="Lowongan junior remote yang terbuka untuk Indonesia memang tidak banyak. Radar memindai tiap beberapa jam." />
            : data.jobs.map((j) => <Job key={j.id} job={j} busy={busy === j.id} onStatus={change} />)}
        </>
      )}
    </Section>
  );
}
