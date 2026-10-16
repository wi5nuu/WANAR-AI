/**
 * Pusat Agen — one place to see everything the agent does on its own and everything that needs the
 * owner: what it did and why (Aktivitas), remote jobs it found (Lowongan), people asking for the
 * owner's services (Klien), what it may sell and at what price (Layanan), and a plain summary
 * (Ringkasan). It reads and reports; nothing is submitted to an employer from here.
 *
 * by Wisnu Alfian Nur Ashar
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import DashboardLayout from './DashboardLayout';
import { careerApi, salesApi, ago, remember, recall } from './agent/api.js';
import Overview from './agent/Overview.jsx';
import ActivityFeed from './agent/ActivityFeed.jsx';
import JobsTab from './agent/JobsTab.jsx';
import LeadsTab from './agent/LeadsTab.jsx';
import ServicesTab from './agent/ServicesTab.jsx';
import ProspectsTab from './agent/ProspectsTab.jsx';
import AboutTab from './agent/AboutTab.jsx';
import './automation.css';
import './agent-center.css';

const FEED_MS = 4000;
const SLOW_MS = 20000;
const TABS = [
  ['overview', 'Ringkasan'], ['feed', 'Aktivitas'], ['jobs', 'Lowongan'],
  ['leads', 'Klien'], ['prospects', 'Peluang'], ['services', 'Layanan'], ['about', 'Cara kerja'],
];
const TAB_KEY = 'agentCenterTab';

export default function AgentCenter() {
  const [tab, setTab] = useState(() => (TABS.some(([k]) => k === recall(TAB_KEY, '')) ? recall(TAB_KEY, 'overview') : 'overview'));
  const [status, setStatus] = useState(null);
  const [report, setReport] = useState(null);
  const [salesSum, setSalesSum] = useState(null);
  const [topJobs, setTopJobs] = useState([]);
  const [needLeads, setNeedLeads] = useState([]);
  const [feed, setFeed] = useState([]);
  const [feedLimit, setFeedLimit] = useState(80);
  const [error, setError] = useState('');
  const [scanning, setScanning] = useState(false);
  const lastId = useRef(0);
  const alive = useRef(true);

  const go = useCallback((k) => { setTab(k); remember(TAB_KEY, k); window.scrollTo?.({ top: 0 }); }, []);
  const fail = useCallback((m) => setError(m), []);

  const loadStatus = useCallback(async () => {
    try { setStatus(await careerApi('/status')); } catch (e) { setError(e.message); }
  }, []);

  const loadSlow = useCallback(async () => {
    try {
      const [r, s, jobs, leads] = await Promise.all([
        careerApi('/report'), salesApi('/summary'),
        careerApi('/jobs?verdict=apply&status=new&limit=3'), salesApi('/leads?open=1&limit=20'),
      ]);
      if (!alive.current) return;
      setReport(r); setSalesSum(s); setTopJobs(jobs.jobs);
      setNeedLeads(leads.leads.filter((l) => l.escalated).slice(0, 3));
    } catch (e) { setError(e.message); }
  }, []);

  const pollFeed = useCallback(async (first = false, limit = 80) => {
    try {
      const { items } = await careerApi(`/activity?afterId=${first ? 0 : lastId.current}&limit=${first ? limit : 40}`);
      if (!alive.current || !items.length) return;
      lastId.current = Math.max(lastId.current, ...items.map((i) => i.id));
      setFeed((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        return [...items.filter((i) => !seen.has(i.id)), ...prev].sort((a, b) => b.id - a.id).slice(0, 400);
      });
    } catch (e) { setError(e.message); }
  }, []);

  useEffect(() => {
    alive.current = true;
    loadStatus(); loadSlow(); pollFeed(true);
    const fast = setInterval(() => { if (!document.hidden) { pollFeed(); loadStatus(); } }, FEED_MS);
    const slow = setInterval(() => { if (!document.hidden) loadSlow(); }, SLOW_MS);
    return () => { alive.current = false; clearInterval(fast); clearInterval(slow); };
  }, [loadStatus, loadSlow, pollFeed]);

  const refreshAll = useCallback(() => { loadStatus(); loadSlow(); pollFeed(); }, [loadStatus, loadSlow, pollFeed]);

  const scan = async () => {
    setScanning(true);
    try {
      const r = await careerApi('/scan', { method: 'POST', body: {} });
      if (!r.started) setError(r.message || 'Pemindaian sedang berjalan.');
      await pollFeed(); await loadStatus();
    } catch (e) { setError(e.message); } finally { setScanning(false); }
  };

  const more = async () => {
    const next = Math.min(300, feedLimit + 120);
    setFeedLimit(next);
    try {
      const { items } = await careerApi(`/activity?afterId=0&limit=${next}`);
      setFeed((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        return [...prev, ...items.filter((i) => !seen.has(i.id))].sort((a, b) => b.id - a.id);
      });
    } catch (e) { setError(e.message); }
  };

  const stalled = report?.facts?.stalled;
  const live = status?.running ? 'run' : stalled ? 'bad' : status?.enabled === false ? 'off' : 'ok';
  const liveText = { run: 'Sedang memindai…', bad: 'Radar berhenti', off: 'Radar dimatikan', ok: 'Aktif terus' }[live];
  const counts = { jobs: status?.apply || 0, leads: salesSum?.stats?.needsOwner || 0, prospects: salesSum?.prospects?.dueFollowUps || 0 };

  return (
    <DashboardLayout>
      <div className="au-page ag-page">
        <header className="ag-hero">
          <div>
            <h1>Pusat Agen</h1>
            <p>Apa yang dikerjakan agent Anda, apa yang menunggu Anda, dan buktinya.</p>
          </div>
          <div className="ag-hero-a">
            <span className={`ag-live ${live}`} title={status?.lastScan ? `Pemindaian terakhir ${ago(status.lastScan)}` : ''}>
              <i aria-hidden="true" />{liveText}
              {status?.lastScan ? <small>· {ago(status.lastScan)}</small> : null}
            </span>
            <button type="button" className="ag-btn" onClick={scan} disabled={scanning || status?.running}>
              {status?.running ? 'Memindai…' : 'Pindai sekarang'}
            </button>
          </div>
        </header>

        {error ? (
          <div className="ag-error" role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => setError('')} aria-label="Tutup pesan galat">×</button>
          </div>
        ) : null}

        <nav className="ag-tabs" role="tablist" aria-label="Bagian Pusat Agen">
          {TABS.map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => go(k)}>
              {label}
              {counts[k] ? <em>{counts[k]}</em> : null}
            </button>
          ))}
        </nav>

        <main className="ag-panel">
          {tab === 'overview' && <Overview status={status} report={report} salesSum={salesSum} jobs={topJobs} leads={needLeads} feed={feed} goto={go} />}
          {tab === 'feed' && <ActivityFeed items={feed} onMore={more} canMore={feed.length >= Math.min(feedLimit, 300) && feedLimit < 300} />}
          {tab === 'jobs' && <JobsTab status={status} onChanged={refreshAll} setError={fail} />}
          {tab === 'leads' && <LeadsTab summary={salesSum} goto={go} onChanged={refreshAll} setError={fail} />}
          {tab === 'prospects' && <ProspectsTab summary={salesSum} onChanged={refreshAll} setError={fail} />}
          {tab === 'services' && <ServicesTab onChanged={refreshAll} setError={fail} />}
          {tab === 'about' && <AboutTab intervalHours={status?.intervalHours} />}
        </main>
      </div>
    </DashboardLayout>
  );
}
