/**
 * Lowongan: remote jobs the radar found, scored against the owner's real profile, with the reasons,
 * one status per posting (the pipeline), and a ready-to-use application kit for each.
 */

import { useCallback, useEffect, useState } from 'react';
import { ScoreRing, Chips, Filters, Empty, Skeleton, Section } from './ui.jsx';
import { careerApi, ago, copyText, downloadFile } from './api.js';

const STATUS = {
  new: 'Baru', shortlisted: 'Dipilih', applying: 'Sedang dilamar', applied: 'Sudah dilamar',
  interview: 'Wawancara', offer: 'Penawaran', rejected: 'Ditolak', skipped: 'Dilewati',
};
const VERDICT = { apply: 'Layak dilamar', maybe: 'Perlu dicek', skip: 'Dilewati' };

function CopyBtn({ text, label = 'Salin' }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="ag-more" onClick={async () => { if (await copyText(text)) { setDone(true); setTimeout(() => setDone(false), 1500); } }}>
      {done ? 'Tersalin ✓' : label}
    </button>
  );
}

function Kit({ job, onApplied, setError }) {
  const [kit, setKit] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    careerApi(`/jobs/${job.id}/kit`).then((k) => { if (live) setKit(k); }).catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [job.id, setError]);

  const cv = async () => {
    setBusy(true);
    try { await downloadFile('/api/career/cv', 'CV.pdf'); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  if (!kit) return <div className="ag-kit"><Skeleton rows={4} /></div>;
  return (
    <div className="ag-kit">
      {kit.warnings.map((w) => <p key={w} className="ag-callout-s">{w}</p>)}

      <div className="ag-kit-h"><h4>Surat lamaran</h4><CopyBtn text={kit.coverLetter} label="Salin surat" /></div>
      <textarea className="ag-letter" readOnly value={kit.coverLetter} rows={Math.min(18, kit.coverLetter.split('\n').length + 1)} aria-label="Surat lamaran" />
      <p className="ag-note">Dirakit hanya dari fakta di portofolio Anda: tidak ada keahlian, angka, atau pengalaman yang tidak tertulis di sana.</p>

      <div className="ag-kit-h"><h4>Jawaban standar formulir</h4></div>
      <dl className="ag-ans">
        {kit.answers.map((a) => (
          <div key={a.label}><dt>{a.label}</dt><dd>{a.value}</dd><CopyBtn text={a.value} /></div>
        ))}
      </dl>

      <div className="ag-kit-h"><h4>Hanya Mas yang bisa menjawab</h4></div>
      <ul className="ag-needs">
        {kit.needsOwner.map((n) => <li key={n.label}><strong>{n.label}</strong><small>{n.why}</small></li>)}
      </ul>

      <div className="ag-kit-a">
        <a className="ag-btn" href={job.url} target="_blank" rel="noopener noreferrer">Buka halaman lamaran</a>
        {kit.resume ? <button type="button" className="ag-btn ghost" onClick={cv} disabled={busy}>{busy ? 'Mengunduh…' : 'Unduh CV'}</button> : <span className="ag-note">CV belum diunggah ke server.</span>}
        <button type="button" className="ag-btn ghost" onClick={() => onApplied(job.id)}>Tandai sudah dilamar</button>
      </div>
    </div>
  );
}

function Job({ job, busy, onStatus, setError }) {
  const [open, setOpen] = useState(false);
  const [kit, setKit] = useState(false);
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
          <span>#{job.id}</span>
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
        <button type="button" className={`ag-btn sm ${kit ? 'ghost' : ''}`} aria-expanded={kit} onClick={() => setKit((v) => !v)}>{kit ? 'Tutup paket' : 'Siapkan lamaran'}</button>
      </div>
      {kit ? <div className="ag-job-kit"><Kit job={job} onApplied={(id) => onStatus(id, 'applied')} setError={setError} /></div> : null}
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
    <Section title="Lowongan remote" hint="Dibaca dari sumber resmi dan dinilai dengan aturan tertulis. Untuk tiap lowongan, agent menyiapkan paket lamaran: surat, jawaban standar, dan CV.">
      <div className="ag-toolbar">
        <Filters value={verdict} onChange={setVerdict} options={[['apply', 'Layak dilamar', status?.apply], ['maybe', 'Perlu dicek', status?.maybe], ['skip', 'Dilewati'], ['', 'Semua']]} />
        <input className="ag-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cari judul / perusahaan" aria-label="Cari lowongan" />
      </div>
      {!data ? <Skeleton rows={4} /> : (
        <>
          <p className="ag-count">{data.total} lowongan</p>
          {!data.jobs.length
            ? <Empty title="Tidak ada lowongan di filter ini" hint="Lowongan junior remote yang terbuka untuk Indonesia memang tidak banyak. Radar memindai tiap beberapa jam." />
            : data.jobs.map((j) => <Job key={j.id} job={j} busy={busy === j.id} onStatus={change} setError={setError} />)}
        </>
      )}
    </Section>
  );
}
