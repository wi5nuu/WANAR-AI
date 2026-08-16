import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import DashboardLayout from './DashboardLayout';

// ─── constants ───────────────────────────────────────────────────────────────
const MODULE_DEFS = [
  { key: 'sqli',      label: 'SQL Injection',    cat: 'injection',  severity: 'critical', icon: '💉' },
  { key: 'xss',       label: 'XSS',              cat: 'injection',  severity: 'high',     icon: '🔴' },
  { key: 'ssti',      label: 'SSTI',             cat: 'injection',  severity: 'critical', icon: '🔥' },
  { key: 'nosqli',    label: 'NoSQL Injection',  cat: 'injection',  severity: 'high',     icon: '🗄️' },
  { key: 'lfi',       label: 'LFI / RFI',        cat: 'traversal',  severity: 'high',     icon: '📁' },
  { key: 'cmdi',      label: 'CMD Injection',    cat: 'injection',  severity: 'critical', icon: '💻' },
  { key: 'ssrf',      label: 'SSRF',             cat: 'network',    severity: 'high',     icon: '🌐' },
  { key: 'xxe',       label: 'XXE',              cat: 'injection',  severity: 'high',     icon: '📄' },
  { key: 'jwt',       label: 'JWT Attack',       cat: 'auth',       severity: 'high',     icon: '🔑' },
  { key: 'graphql',   label: 'GraphQL',          cat: 'api',        severity: 'medium',   icon: '◈'  },
  { key: 'idor',      label: 'IDOR',             cat: 'auth',       severity: 'high',     icon: '🔓' },
  { key: 'redirect',  label: 'Open Redirect',    cat: 'network',    severity: 'medium',   icon: '↗️' },
  { key: 'upload',    label: 'File Upload',      cat: 'traversal',  severity: 'critical', icon: '📤' },
  { key: 'cors',      label: 'CORS',             cat: 'network',    severity: 'medium',   icon: '🔀' },
  { key: 'ddos',      label: 'DDoS Attack',      cat: 'dos',        severity: 'critical', icon: '💥' },
  { key: 'bruteforce',label: 'Brute Force',      cat: 'auth',       severity: 'high',     icon: '🔨' },
];

const SEVERITY_COLOR = { critical: '#ef4444', high: '#f97316', medium: '#f59e0b', low: '#22c55e', info: '#3b82f6' };
const SEVERITY_BG    = { critical: 'rgba(239,68,68,.13)', high: 'rgba(249,115,22,.13)', medium: 'rgba(245,158,11,.13)', low: 'rgba(34,197,94,.13)', info: 'rgba(59,130,246,.13)' };
const LOG_COLOR      = { success: '#22c55e', error: '#ef4444', warning: '#f59e0b', info: '#60a5fa', data: '#a78bfa', system: '#94a3b8' };

const CAT_LABELS = { injection: 'Injection', traversal: 'Traversal', network: 'Network', auth: 'Auth', api: 'API', dos: 'DoS' };
const TABS = [
  { id: 'live',     label: 'Live Feed',   icon: '📡' },
  { id: 'vulns',    label: 'Vulns',       icon: '🎯' },
  { id: 'data',     label: 'Data',        icon: '📦' },
  { id: 'creds',    label: 'Credentials', icon: '🔑' },
  { id: 'files',    label: 'Files',       icon: '📁' },
  { id: 'database', label: 'Database',    icon: '🗄️' },
  { id: 'chains',   label: 'Chains',      icon: '⛓️' },
  { id: 'ai',       label: 'AI Intel',    icon: '🤖' },
  { id: 'report',   label: 'Report',      icon: '📋' },
];

function SeverityBadge({ sev }) {
  return (
    <span style={{
      display: 'inline-block', padding: '2px 7px', borderRadius: '4px', fontSize: '10px',
      fontWeight: '700', letterSpacing: '.5px', textTransform: 'uppercase',
      background: SEVERITY_BG[sev] || SEVERITY_BG.info, color: SEVERITY_COLOR[sev] || SEVERITY_COLOR.info,
      border: `1px solid ${SEVERITY_COLOR[sev] || SEVERITY_COLOR.info}44`,
    }}>
      {sev}
    </span>
  );
}

function StatCard({ label, value, color, sub }) {
  return (
    <div style={{
      flex: 1, minWidth: 90, padding: '12px 14px', borderRadius: '10px',
      background: 'rgba(255,255,255,.04)', border: `1px solid ${color}33`,
      display: 'flex', flexDirection: 'column', gap: 2,
    }}>
      <div style={{ fontSize: '22px', fontWeight: '800', color, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      <div style={{ fontSize: '10px', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '.5px' }}>{label}</div>
      {sub && <div style={{ fontSize: '10px', color: color + 'aa' }}>{sub}</div>}
    </div>
  );
}

function EmptyState({ icon, text }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 180, gap: 10, color: '#4a5568' }}>
      <div style={{ fontSize: 36 }}>{icon}</div>
      <div style={{ fontSize: 12, textAlign: 'center', maxWidth: 220 }}>{text}</div>
    </div>
  );
}

export default function ProfessionalAttack() {
  const navigate = useNavigate();

  // ── core state ──────────────────────────────────────────────────────────────
  const [target, setTarget]               = useState('');
  const [isAttacking, setIsAttacking]     = useState(false);
  const [attackLog, setAttackLog]         = useState([]);
  const [logFilter, setLogFilter]         = useState('all');
  const [confirmedVulns, setConfirmedVulns] = useState([]);
  const [extractedData, setExtractedData] = useState(null);
  const [credentials, setCredentials]     = useState(null);
  const [fileSystem, setFileSystem]       = useState(null);
  const [databaseInfo, setDatabaseInfo]   = useState(null);
  const [attackProgress, setAttackProgress] = useState({ phase: '', percent: 0 });
  const [report, setReport]               = useState(null);
  const [compliance, setCompliance]       = useState(null);
  const [exploitChains, setExploitChains] = useState(null);
  const [aiGuidance, setAiGuidance]       = useState(null);
  const [activeTab, setActiveTab]         = useState('live');
  const [scanHistory, setScanHistory]     = useState([]);
  const [elapsedTime, setElapsedTime]     = useState(0);
  const [startTime, setStartTime]         = useState(null);

  // ── module / config state ────────────────────────────────────────────────────
  const [modules, setModules] = useState(
    Object.fromEntries(MODULE_DEFS.map(m => [m.key, true]))
  );
  const [intensity, setIntensity]   = useState('high');
  const [ddosConfig, setDdosConfig] = useState({ requestsPerSecond: 20000, duration: 50, method: 'http' });
  const [bruteConfig, setBruteConfig] = useState({ wordlist: 'common', threads: 50, delay: 0 });
  const [notifyEmail, setNotifyEmail]   = useState('');
  const [notifyPhone, setNotifyPhone]   = useState('');
  const [notifyResult, setNotifyResult] = useState(null);

  const abortRef    = useRef(null);
  const logRef      = useRef(null);
  const timerRef    = useRef(null);

  // ── derived stats ────────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    const critical = confirmedVulns.filter(v => v.severity === 'critical').length;
    const high     = confirmedVulns.filter(v => v.severity === 'high').length;
    const medium   = confirmedVulns.filter(v => v.severity === 'medium').length;
    const low      = confirmedVulns.filter(v => ['low','info'].includes(v.severity)).length;
    return { critical, high, medium, low, total: confirmedVulns.length };
  }, [confirmedVulns]);

  const activeModuleCount = useMemo(() => Object.values(modules).filter(Boolean).length, [modules]);

  const filteredLog = useMemo(() => {
    if (logFilter === 'all') return attackLog;
    return attackLog.filter(e => e.type === logFilter);
  }, [attackLog, logFilter]);

  // ── helpers ──────────────────────────────────────────────────────────────────
  const addLog = useCallback((type, message, data) => {
    const entry = { timestamp: new Date().toISOString(), type, message, data };
    setAttackLog(prev => [...prev, entry]);
  }, []);

  // auto-scroll live log
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [attackLog]);

  // elapsed timer
  useEffect(() => {
    if (isAttacking) {
      setStartTime(Date.now());
      setElapsedTime(0);
      timerRef.current = setInterval(() => {
        setElapsedTime(t => t + 1);
      }, 1000);
    } else {
      clearInterval(timerRef.current);
    }
    return () => clearInterval(timerRef.current);
  }, [isAttacking]);

  const fmtTime = (s) => `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;

  const handleStartAttack = useCallback(async () => {
    if (!target) return;
    setIsAttacking(true);
    setAttackLog([]);
    setConfirmedVulns([]);
    setExtractedData(null);
    setCredentials(null);
    setFileSystem(null);
    setDatabaseInfo(null);
    setReport(null);
    setCompliance(null);
    setExploitChains(null);
    setAiGuidance(null);
    setAttackProgress({ phase: 'Initializing...', percent: 0 });
    setActiveTab('live');

    const abort = new AbortController();
    abortRef.current = abort;

    const scanEntry = { target, startedAt: new Date().toISOString(), intensity, modules: activeModuleCount };

    try {
      addLog('system', `Wanar AI Professional Pentest Engine — Session started`);
      addLog('info', `Target: ${target}`);
      addLog('warning', 'LEGAL: Only test systems you own or have explicit written permission to test.');
      addLog('info', `Modules active: ${activeModuleCount} | Intensity: ${intensity.toUpperCase()}`);

      const resp = await fetch('/api/security/attack/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target,
          scanType: intensity === 'critical' || intensity === 'high' ? 'deep' : 'quick',
          modules: Object.entries(modules).filter(([, v]) => v).map(([k]) => k),
          options: {
            ddos: modules.ddos ? ddosConfig : null,
            bruteforce: modules.bruteforce ? bruteConfig : null,
          },
        }),
        signal: abort.signal,
      });

      if (!resp.ok) throw new Error(`Server error: ${resp.status}`);

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let currentData = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('data: ')) {
            currentData = trimmed.slice(6).trim();
          } else if (trimmed === '' && currentData) {
            try { handleEvent(JSON.parse(currentData)); } catch {}
            currentData = '';
          }
        }
      }
      if (currentData) { try { handleEvent(JSON.parse(currentData)); } catch {} }
    } catch (err) {
      if (err.name === 'AbortError') {
        addLog('warning', 'Scan stopped by user.');
      } else {
        addLog('error', `Scan failed: ${err.message}`);
      }
    } finally {
      setIsAttacking(false);
      abortRef.current = null;
      setAttackProgress(p => p.percent < 100 ? { phase: 'Stopped', percent: p.percent } : p);
      setScanHistory(prev => [{ ...scanEntry, endedAt: new Date().toISOString() }, ...prev.slice(0, 9)]);
    }
  }, [target, modules, intensity, ddosConfig, bruteConfig, activeModuleCount, addLog]);

  const handleEvent = useCallback((data) => {
    if (!data || !data.type) return;

    switch (data.type) {
      case 'attack_start':
        addLog('info', `Attack started | ID: ${data.attackId}`);
        setAttackProgress({ phase: 'Starting...', percent: 5 });
        break;

      case 'progress':
        addLog('info', data.message);
        const phaseKeywords = {
          recon: 10, enhanced_recon: 12, bruteforce: 14, ddos: 15,
          sqli_attack: 18, xss_attack: 23,
          ssti_attack: 28, nosqli_attack: 32, lfi_attack: 36, cmdi_attack: 40,
          ssrf_attack: 44, xxe_attack: 48, jwt_attack: 52, graphql_attack: 55,
          idor_check: 58, redirect_check: 61, upload_check: 64, cors_check: 67,
          ai_analysis: 85, exploit_chains: 89, compliance: 92, report: 95,
        };
        const pct = phaseKeywords[data.phase] || attackProgress.percent;
        setAttackProgress({ phase: data.message, percent: pct });
        break;

      case 'payload_test':
        addLog('payload', `→ ${data.module} | ${data.payload}`);
        break;

      case 'evidence':
        addLog('success', `Evidence collected: ${data.phase}`);
        break;

      case 'vulnerability_confirmed':
        setConfirmedVulns(prev => [...prev, data.vulnerability]);
        addLog('confirmed', `✅ [CONFIRMED] ${data.vulnerability.type} (${data.vulnerability.severity}) - ${data.vulnerability.location}`, data.vulnerability);
        break;

      case 'attack_fake':
        addLog('fake', `❌ FAKE: ${data.vulnerability.type} - ${data.vulnerability.description}`);
        break;

      case 'ai_guidance':
        setAiGuidance(data.guidance);
        addLog('ai', 'AI exploitation guidance received from NVIDIA DeepSeek');
        break;

      case 'exploit_chains':
        setExploitChains(data.chains);
        addLog('warning', `⚔️ ${data.chains.length} exploitation chains generated`);
        break;

      case 'compliance':
        setCompliance(data.compliance);
        addLog('info', `📋 Compliance mapping: OWASP ${data.compliance.owasp.categories.length} categories, PCI DSS ${data.compliance.pciDss.requirements.length} reqs, GDPR ${data.compliance.gdpr.articles.length} articles`);
        break;

      case 'exploitation':
        addLog('exploit', `🔓 Exploitation (${data.phase}): ${JSON.stringify(data.data).slice(0, 300)}...`);
        break;

      case 'exploitation_complete':
        addLog('success', `💀 Server penetration complete! ${data.data.credentials?.length || 0} credentials, ${data.data.files?.length || 0} files extracted`);
        if (data.data.serverAccess) addLog('success', `Access level: ${data.data.serverAccess.access_level}`);
        if (data.data.database) setDatabaseInfo(data.data.database);
        if (data.data.credentials?.length > 0) setCredentials(data.data.credentials);
        if (data.data.files?.length > 0) setFileSystem({ files: data.data.files, server: 'exploited', os: 'from target', user: data.data.serverAccess?.user || 'unknown', sensitiveFiles: data.data.files.filter(f => f.path?.includes('passwd') || f.path?.includes('config') || f.path?.includes('env') || f.path?.includes('key')) });
        if (data.data.serverAccess?.output) setExtractedData(data.data.serverAccess);
        break;

      case 'ddos_start':
        addLog('warning', `💥 DDoS started: ${data.config.requestsPerSecond || 10000} req/s for ${data.config.duration || 60}s`);
        break;

      case 'ddos_progress':
        addLog('ddos', `💥 DDoS: ${data.sent}/${data.total} requests (second ${data.second})`);
        break;

      case 'ddos_complete':
        addLog('success', `💥 DDoS complete: ${data.sent} requests sent (${(data.sent / (data.total || 1) * 100).toFixed(0)}% success rate)`);
        break;

      case 'bruteforce_complete':
        addLog('warning', `🔓 Brute force complete: ${data.stats.success || 0} credentials found`);
        break;

      case 'attack_complete':
        setReport(data.report);
        addLog('success', `🎯 Attack complete! ${data.totalConfirmed} confirmed, ${data.totalFake} fake in ${(data.elapsed / 1000).toFixed(1)}s`);
        setAttackProgress({ phase: 'Complete', percent: 100 });
        // Start data extraction automatically
        handleDataExtraction(data.target);
        break;

      case 'attack_error':
        addLog('error', `Error: ${data.message}`);
        break;
    }
  }, [addLog, attackProgress.percent]);

  const handleDataExtraction = useCallback(async (targetUrl) => {
    addLog('info', '🔍 Starting deep data extraction (database, credentials, file system)...');
    try {
      const resp = await fetch('/api/security/professional/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: targetUrl || target }),
      });
      const result = await resp.json();
      if (result.success) {
        if (result.database) setDatabaseInfo(result.database);
        if (result.credentials) setCredentials(result.credentials);
        if (result.fileSystem) setFileSystem(result.fileSystem);
        if (result.extractedData) setExtractedData(result.extractedData);
        addLog('success', `📦 Extraction complete: ${result.extractedData?.length || 0} data items, ${result.credentials?.length || 0} credentials, ${result.fileSystem?.files?.length || 0} files`);
      }
    } catch (err) {
      addLog('error', `Extraction error: ${err.message}`);
    }
  }, [target, addLog]);

  const handleStop = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  const handleGenerateReport = useCallback(async (format) => {
    try {
      const resp = await fetch('/api/security/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vulnerabilities: confirmedVulns,
          target,
          format,
        }),
      });

      if (format === 'html') {
        const html = await resp.text();
        const win = window.open('', '_blank');
        win.document.write(html);
        win.document.close();
      } else if (format === 'text') {
        const text = await resp.text();
        const blob = new Blob([text], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `pentest-report-${Date.now()}.txt`;
        a.click();
        URL.revokeObjectURL(url);
      } else {
        const result = await resp.json();
        setReport(result.report);
      }
      addLog('success', `📄 Report generated (${format})`);
    } catch (err) {
      addLog('error', `Report error: ${err.message}`);
    }
  }, [confirmedVulns, target, addLog]);

  const handleSendNotification = useCallback(async (type) => {
    try {
      const resp = await fetch('/api/security/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target, vulnerabilities: confirmedVulns, type,
          contact: type === 'email' ? notifyEmail : notifyPhone,
        }),
      });
      const result = await resp.json();
      setNotifyResult(result);
      addLog('success', `📧 ${type} notification ready`);
    } catch (err) {
      addLog('error', `Notification error: ${err.message}`);
    }
  }, [confirmedVulns, target, notifyEmail, notifyPhone, addLog]);

  const toggleModule  = (key) => setModules(prev => ({ ...prev, [key]: !prev[key] }));
  const selectAll    = () => setModules(Object.fromEntries(MODULE_DEFS.map(m => [m.key, true])));
  const deselectAll  = () => setModules(Object.fromEntries(MODULE_DEFS.map(m => [m.key, false])));

  const tabBadge = (id) => {
    switch (id) {
      case 'vulns':    return stats.total || null;
      case 'creds':    return credentials?.length || null;
      case 'files':    return fileSystem?.files?.length || null;
      case 'data':     return extractedData?.length || null;
      case 'chains':   return exploitChains?.length || null;
      case 'ai':       return aiGuidance ? '●' : null;
      case 'report':   return report || compliance ? '●' : null;
      default:         return null;
    }
  };

  // ── CSS-in-JS theme tokens (dark terminal theme) ────────────────────────────
  const T = {
    bg:      '#0a0a14',
    panel:   '#0f0f1e',
    border:  '#1e1e3a',
    border2: '#2a2a4a',
    text:    '#e2e8f0',
    muted:   '#64748b',
    accent:  '#6366f1',
    red:     '#ef4444',
    orange:  '#f97316',
    green:   '#22c55e',
    yellow:  '#f59e0b',
    blue:    '#3b82f6',
    purple:  '#a78bfa',
  };

  const panelStyle = {
    background: T.panel,
    border: `1px solid ${T.border}`,
    borderRadius: 12,
    padding: '16px',
  };

  return (
    <DashboardLayout>
      <div style={{
        padding: '20px 24px', maxWidth: '1500px', margin: '0 auto', width: '100%',
        fontFamily: "'Segoe UI', Consolas, monospace", color: T.text,
        background: T.bg, minHeight: '100%',
      }}>

        {/* ── PAGE HEADER ─────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{
                width: 36, height: 36, borderRadius: 8,
                background: 'linear-gradient(135deg,#ef4444,#7c3aed)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18,
              }}>⚡</div>
              <div>
                <h1 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: T.text, letterSpacing: '.5px' }}>
                  Professional Pentest Engine
                  <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 600, color: T.muted, fontFamily: 'monospace' }}>v3.0</span>
                </h1>
                <p style={{ margin: 0, fontSize: 11, color: T.muted }}>
                  Advanced exploitation framework — SQL · XSS · SSTI · LFI · DDoS · Brute Force · Compliance
                </p>
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {isAttacking && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: T.orange }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: T.orange, animation: 'pulse 1s infinite' }} />
                {attackProgress.phase} — {fmtTime(elapsedTime)}
              </div>
            )}
            <div style={{
              padding: '6px 14px', borderRadius: 6, fontSize: 11, fontWeight: 700, letterSpacing: '.5px',
              background: isAttacking ? `${T.red}18` : `${T.green}18`,
              border: `1px solid ${isAttacking ? T.red : T.green}44`,
              color: isAttacking ? T.red : T.green,
            }}>
              {isAttacking ? '⚔ SCANNING' : '◉ ARMED'}
            </div>
          </div>
        </div>

        {/* ── STATS BAR ───────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
          <StatCard label="Total Vulns"  value={stats.total}    color={T.purple} />
          <StatCard label="Critical"     value={stats.critical} color={T.red}    sub={stats.critical > 0 ? 'Immediate action' : undefined} />
          <StatCard label="High"         value={stats.high}     color={T.orange} />
          <StatCard label="Medium"       value={stats.medium}   color={T.yellow} />
          <StatCard label="Log Entries"  value={attackLog.length} color={T.blue} />
          <StatCard label="Modules"      value={`${activeModuleCount}/${MODULE_DEFS.length}`} color={T.muted} />
        </div>

        {/* ── MAIN BODY ────────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>

          {/* ── LEFT PANEL ─ configuration ─────────────────────────────────── */}
          <div style={{ flex: '0 0 300px', minWidth: 260, display: 'flex', flexDirection: 'column', gap: 12 }}>

            {/* Target */}
            <div style={{ ...panelStyle }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: T.muted, textTransform: 'uppercase', letterSpacing: '.8px', marginBottom: 8 }}>
                Target URL
              </div>
              <input
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder="https://target.com"
                disabled={isAttacking}
                style={{
                  width: '100%', padding: '9px 12px', fontSize: 13, fontFamily: 'monospace',
                  background: T.bg, border: `1px solid ${target ? T.accent + '66' : T.border2}`,
                  borderRadius: 7, color: '#a5f3fc', outline: 'none', boxSizing: 'border-box',
                  transition: 'border-color .2s',
                }}
              />
            </div>

            {/* Modules */}
            <div style={{ ...panelStyle }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: T.muted, textTransform: 'uppercase', letterSpacing: '.8px' }}>
                  Attack Modules <span style={{ marginLeft: 6, color: T.accent }}>{activeModuleCount}/{MODULE_DEFS.length}</span>
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                  <button onClick={selectAll} style={{ padding: '2px 8px', fontSize: 9, fontWeight: 700, background: T.green + '18', border: '1px solid ' + T.green + '44', borderRadius: 4, color: T.green, cursor: 'pointer' }}>ALL</button>
                  <button onClick={deselectAll} style={{ padding: '2px 8px', fontSize: 9, fontWeight: 700, background: T.red + '18', border: '1px solid ' + T.red + '44', borderRadius: 4, color: T.red, cursor: 'pointer' }}>NONE</button>
                </div>
              </div>
              {Object.entries(CAT_LABELS).map(([cat, catLabel]) => (
                <div key={cat} style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 9, color: T.muted, textTransform: 'uppercase', letterSpacing: '.6px', marginBottom: 4, fontWeight: 600 }}>{catLabel}</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 3 }}>
                    {MODULE_DEFS.filter(m => m.cat === cat).map(m => (
                      <button key={m.key} onClick={() => toggleModule(m.key)} style={{
                        padding: '5px 7px', fontSize: 10, fontWeight: 600, textAlign: 'left',
                        background: modules[m.key] ? SEVERITY_COLOR[m.severity] + '16' : 'transparent',
                        border: '1px solid ' + (modules[m.key] ? SEVERITY_COLOR[m.severity] + '55' : T.border2),
                        borderRadius: 5, color: modules[m.key] ? SEVERITY_COLOR[m.severity] : T.muted,
                        cursor: 'pointer', transition: 'all .15s',
                        display: 'flex', alignItems: 'center', gap: 4,
                      }}>
                        <span style={{ fontSize: 9 }}>{modules[m.key] ? '●' : '○'}</span>
                        {m.icon} {m.label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {/* Intensity */}
            <div style={{ ...panelStyle }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: T.muted, textTransform: 'uppercase', letterSpacing: '.8px', marginBottom: 8 }}>Scan Intensity</div>
              <div style={{ display: 'flex', gap: 4 }}>
                {[{ id: 'low', color: T.green }, { id: 'medium', color: T.yellow }, { id: 'high', color: T.orange }, { id: 'critical', color: T.red }].map(({ id, color }) => (
                  <button key={id} onClick={() => setIntensity(id)} style={{
                    flex: 1, padding: '7px 4px', fontSize: 9, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.6px',
                    background: intensity === id ? color : 'transparent',
                    border: '1px solid ' + (intensity === id ? color : T.border2),
                    borderRadius: 5, color: intensity === id ? '#000' : T.muted,
                    cursor: 'pointer', transition: 'all .15s',
                  }}>{id}</button>
                ))}
              </div>
            </div>

            {/* DDoS Config */}
            {modules.ddos && (
              <div style={{ ...panelStyle, borderColor: T.red + '44' }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: T.red, textTransform: 'uppercase', letterSpacing: '.8px', marginBottom: 8 }}>DDoS Config</div>
                <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 9, color: T.muted, marginBottom: 3 }}>Req/sec</div>
                    <input type="number" value={ddosConfig.requestsPerSecond}
                      onChange={(e) => setDdosConfig(p => ({ ...p, requestsPerSecond: parseInt(e.target.value) || 10000 }))}
                      style={{ width: '100%', padding: '6px 8px', fontSize: 11, background: T.bg, border: '1px solid ' + T.red + '44', borderRadius: 5, color: T.text, fontFamily: 'monospace', boxSizing: 'border-box' }} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 9, color: T.muted, marginBottom: 3 }}>Duration (s)</div>
                    <input type="number" value={ddosConfig.duration}
                      onChange={(e) => setDdosConfig(p => ({ ...p, duration: parseInt(e.target.value) || 30 }))}
                      style={{ width: '100%', padding: '6px 8px', fontSize: 11, background: T.bg, border: '1px solid ' + T.red + '44', borderRadius: 5, color: T.text, fontFamily: 'monospace', boxSizing: 'border-box' }} />
                  </div>
                </div>
                <div style={{ fontSize: 9, color: T.muted, background: T.bg, padding: '5px 8px', borderRadius: 4 }}>
                  {ddosConfig.method.toUpperCase()} — {ddosConfig.requestsPerSecond.toLocaleString()} req/s × {ddosConfig.duration}s = <span style={{ color: T.red }}>{(ddosConfig.requestsPerSecond * ddosConfig.duration).toLocaleString()}</span> total
                </div>
              </div>
            )}

            {/* Brute Force */}
            {modules.bruteforce && (
              <div style={{ ...panelStyle, borderColor: T.orange + '44' }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: T.orange, textTransform: 'uppercase', letterSpacing: '.8px', marginBottom: 8 }}>Brute Force</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <select value={bruteConfig.wordlist} onChange={(e) => setBruteConfig(p => ({ ...p, wordlist: e.target.value }))}
                    style={{ flex: 1, padding: '6px 8px', fontSize: 11, background: T.bg, border: '1px solid ' + T.orange + '44', borderRadius: 5, color: T.text }}>
                    <option value="common">Common (100)</option>
                    <option value="extended">Extended (1K)</option>
                    <option value="rockyou">RockYou (10M)</option>
                  </select>
                  <input type="number" value={bruteConfig.threads}
                    onChange={(e) => setBruteConfig(p => ({ ...p, threads: parseInt(e.target.value) || 50 }))}
                    style={{ width: 64, padding: '6px 8px', fontSize: 11, background: T.bg, border: '1px solid ' + T.orange + '44', borderRadius: 5, color: T.text, fontFamily: 'monospace', boxSizing: 'border-box' }}
                    placeholder="Threads" />
                </div>
              </div>
            )}

            {/* Start / Stop */}
            <div>
              {!isAttacking ? (
                <button onClick={handleStartAttack} disabled={!target} style={{
                  width: '100%', padding: '13px 16px', fontSize: 13, fontWeight: 800, letterSpacing: '.5px',
                  background: !target ? T.border2 : 'linear-gradient(135deg,#7c3aed,#ef4444)',
                  color: !target ? T.muted : '#fff', border: 'none', borderRadius: 8,
                  cursor: !target ? 'not-allowed' : 'pointer',
                  boxShadow: !target ? 'none' : '0 4px 20px rgba(124,58,237,.35)',
                }}>
                  ⚡ Start Scan
                </button>
              ) : (
                <button onClick={handleStop} style={{
                  width: '100%', padding: '13px 16px', fontSize: 13, fontWeight: 800,
                  background: T.red, color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer',
                }}>
                  ■ Stop Scan
                </button>
              )}
            </div>

            {/* Scan History */}
            {scanHistory.length > 0 && (
              <div style={{ ...panelStyle }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: T.muted, textTransform: 'uppercase', letterSpacing: '.8px', marginBottom: 8 }}>Recent Scans</div>
                {scanHistory.slice(0, 4).map((s, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', borderBottom: '1px solid ' + T.border }}>
                    <div style={{ fontSize: 10, color: T.text, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160 }}>{s.target}</div>
                    <div style={{ fontSize: 9, color: T.muted }}>{new Date(s.startedAt).toLocaleTimeString()}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* RIGHT PANEL */}
          <div style={{ flex: 1, minWidth: 480, display: 'flex', flexDirection: 'column', gap: 12 }}>

            {/* Progress bar */}
            {(isAttacking || attackProgress.percent > 0) && (
              <div style={{ ...panelStyle, padding: '10px 14px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: T.muted, marginBottom: 6 }}>
                  <span>{attackProgress.phase || 'Idle'}</span>
                  <span style={{ fontFamily: 'monospace', color: T.accent }}>{attackProgress.percent}%</span>
                </div>
                <div style={{ height: 5, background: T.bg, borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{
                    height: '100%', width: attackProgress.percent + '%',
                    background: 'linear-gradient(90deg,' + T.green + ',' + T.yellow + ',' + T.red + ')',
                    borderRadius: 3, transition: 'width .4s ease',
                  }} />
                </div>
              </div>
            )}

            {/* Tabs */}
            <div style={{ display: 'flex', gap: 2, background: T.panel, border: '1px solid ' + T.border, borderRadius: 10, padding: 3, flexWrap: 'wrap' }}>
              {TABS.map(tab => {
                const badge = tabBadge(tab.id);
                const isActive = activeTab === tab.id;
                return (
                  <button key={tab.id} onClick={() => setActiveTab(tab.id)} style={{
                    flex: '1 0 auto', padding: '6px 8px', fontSize: 10, fontWeight: 700,
                    background: isActive ? T.accent + '22' : 'transparent',
                    border: '1px solid ' + (isActive ? T.accent + '88' : 'transparent'),
                    borderRadius: 7, color: isActive ? T.accent : T.muted,
                    cursor: 'pointer', whiteSpace: 'nowrap',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                  }}>
                    <span>{tab.icon}</span>
                    <span>{tab.label}</span>
                    {badge != null && (
                      <span style={{ padding: '0 4px', fontSize: 8, fontWeight: 800, borderRadius: 3, background: T.red, color: '#fff', minWidth: 14, textAlign: 'center' }}>{badge}</span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Tab content */}
            <div style={{ ...panelStyle, minHeight: 420, maxHeight: 600, overflow: 'auto', padding: 0 }}>

              {activeTab === 'live' && (
                <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                  <div style={{ display: 'flex', gap: 4, padding: '8px 12px', borderBottom: '1px solid ' + T.border, flexWrap: 'wrap' }}>
                    {['all','success','error','warning','info','system'].map(f => (
                      <button key={f} onClick={() => setLogFilter(f)} style={{
                        padding: '2px 8px', fontSize: 9, fontWeight: 700, textTransform: 'uppercase',
                        background: logFilter === f ? (LOG_COLOR[f] || T.accent) + '22' : 'transparent',
                        border: '1px solid ' + (logFilter === f ? (LOG_COLOR[f] || T.accent) + '66' : T.border),
                        borderRadius: 4, color: logFilter === f ? (LOG_COLOR[f] || T.accent) : T.muted, cursor: 'pointer',
                      }}>{f}</button>
                    ))}
                    <span style={{ marginLeft: 'auto', fontSize: 9, color: T.muted, alignSelf: 'center' }}>{filteredLog.length} entries</span>
                  </div>
                  <div ref={logRef} style={{ flex: 1, overflow: 'auto', padding: 12, fontFamily: 'Consolas, monospace', fontSize: 11, minHeight: 300 }}>
                    {filteredLog.length === 0 && (
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 200, gap: 10, color: '#4a5568' }}>
                        <div style={{ fontSize: 36 }}>&#x26A1;</div>
                        <div style={{ fontSize: 12, textAlign: 'center', maxWidth: 260, lineHeight: 1.5 }}>Configure a target, select modules, and click Start Scan.<br/>Only test systems you own or have explicit written permission to test.</div>
                      </div>
                    )}
                    {filteredLog.map((entry, i) => (
                      <div key={i} style={{ display: 'flex', gap: 8, padding: '2px 0', borderBottom: '1px solid ' + T.border + '11' }}>
                        <span style={{ color: T.muted, minWidth: 72, fontSize: 9, paddingTop: 1, flexShrink: 0 }}>
                          {new Date(entry.timestamp).toLocaleTimeString()}
                        </span>
                        <span style={{ flex: 1, color: LOG_COLOR[entry.type] || T.muted, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{entry.message}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {activeTab === 'vulns' && (
                <div style={{ padding: 14 }}>
                  {confirmedVulns.length === 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 180, gap: 10, color: '#4a5568' }}>
                      <div style={{ fontSize: 36 }}>&#x1F3AF;</div>
                      <div style={{ fontSize: 12, textAlign: 'center', maxWidth: 220 }}>No vulnerabilities confirmed yet. Run a scan first.</div>
                    </div>
                  ) : (
                    <>
                      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                        {[['critical', T.red], ['high', T.orange], ['medium', T.yellow], ['low', T.green]].map(([sev, col]) => (
                          <div key={sev} style={{ padding: '4px 10px', borderRadius: 6, background: col + '18', border: '1px solid ' + col + '33', fontSize: 11, fontWeight: 700, color: col }}>
                            {confirmedVulns.filter(v => (v.severity || '').toLowerCase() === sev).length} {sev}
                          </div>
                        ))}
                      </div>
                      {confirmedVulns.map((v, i) => {
                        const sev = (v.severity || 'info').toLowerCase();
                        const col = SEVERITY_COLOR[sev] || SEVERITY_COLOR.info;
                        return (
                          <div key={i} style={{ background: T.bg, borderRadius: 8, padding: 12, marginBottom: 8, borderLeft: '3px solid ' + col, border: '1px solid ' + col + '22' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                              <div style={{ fontWeight: 700, fontSize: 13, color: T.text }}>{v.type}</div>
                              <span style={{ display: 'inline-block', padding: '2px 7px', borderRadius: 4, fontSize: 10, fontWeight: 700, letterSpacing: '.5px', textTransform: 'uppercase', background: SEVERITY_BG[sev] || SEVERITY_BG.info, color: col, border: '1px solid ' + col + '44' }}>{sev}</span>
                            </div>
                            <div style={{ fontSize: 11, color: T.muted, marginBottom: 6 }}>{v.description}</div>
                            <div style={{ display: 'flex', gap: 12, fontSize: 10, color: T.muted, fontFamily: 'monospace', flexWrap: 'wrap' }}>
                              {v.cvss && <span>CVSS <span style={{ color: col }}>{v.cvss}</span></span>}
                              {v.cwe && <span>CWE-{v.cwe}</span>}
                              {v.location && <span style={{ color: T.text }}>{v.location}</span>}
                            </div>
                          </div>
                        );
                      })}
                    </>
                  )}
                </div>
              )}

              {activeTab === 'data' && (
                <div style={{ padding: 14 }}>
                  {!extractedData ? (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 180, gap: 10, color: '#4a5568' }}>
                      <div style={{ fontSize: 36 }}>&#x1F4E6;</div>
                      <div style={{ fontSize: 12, textAlign: 'center', maxWidth: 220 }}>{isAttacking ? 'Extracting data...' : 'No extracted data. Run a scan first.'}</div>
                    </div>
                  ) : (
                    <pre style={{ fontSize: 10, color: '#a5f3fc', background: T.bg, padding: 12, borderRadius: 7, overflow: 'auto', fontFamily: 'monospace', lineHeight: 1.5 }}>
                      {JSON.stringify(extractedData, null, 2)}
                    </pre>
                  )}
                </div>
              )}

              {activeTab === 'creds' && (
                <div style={{ padding: 14 }}>
                  {!credentials || credentials.length === 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 180, gap: 10, color: '#4a5568' }}>
                      <div style={{ fontSize: 36 }}>&#x1F511;</div>
                      <div style={{ fontSize: 12, textAlign: 'center', maxWidth: 220 }}>No credentials extracted yet.</div>
                    </div>
                  ) : (
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                      <thead>
                        <tr style={{ borderBottom: '1px solid ' + T.border2 }}>
                          {['Type', 'Username', 'Password / Hash', 'Source'].map(h => (
                            <th key={h} style={{ padding: '6px 10px', textAlign: 'left', color: T.muted, fontWeight: 700, fontSize: 10, textTransform: 'uppercase', letterSpacing: '.5px' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {credentials.map((c, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid ' + T.border }}>
                            <td style={{ padding: '7px 10px', color: T.muted }}>{c.type}</td>
                            <td style={{ padding: '7px 10px', color: T.green, fontFamily: 'monospace' }}>{c.username}</td>
                            <td style={{ padding: '7px 10px', color: T.red, fontFamily: 'monospace' }}>{c.password || c.hash}</td>
                            <td style={{ padding: '7px 10px', color: T.muted, fontSize: 10 }}>{c.source}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}

              {activeTab === 'files' && (
                <div style={{ padding: 14 }}>
                  {!fileSystem ? (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 180, gap: 10, color: '#4a5568' }}>
                      <div style={{ fontSize: 36 }}>&#x1F4C1;</div>
                      <div style={{ fontSize: 12, textAlign: 'center', maxWidth: 220 }}>No file system data extracted.</div>
                    </div>
                  ) : (
                    <>
                      <div style={{ display: 'flex', gap: 12, fontSize: 10, color: T.muted, marginBottom: 10, flexWrap: 'wrap' }}>
                        {fileSystem.server && <span>Server: <span style={{ color: T.text }}>{fileSystem.server}</span></span>}
                        {fileSystem.os && <span>OS: <span style={{ color: T.text }}>{fileSystem.os}</span></span>}
                        {fileSystem.user && <span>User: <span style={{ color: T.orange }}>{fileSystem.user}</span></span>}
                      </div>
                      {fileSystem.sensitiveFiles && fileSystem.sensitiveFiles.length > 0 && (
                        <div style={{ marginBottom: 12 }}>
                          <div style={{ fontSize: 10, fontWeight: 700, color: T.red, textTransform: 'uppercase', letterSpacing: '.6px', marginBottom: 6 }}>Sensitive Files</div>
                          {fileSystem.sensitiveFiles.map((f, i) => (
                            <div key={i} style={{ background: T.red + '0d', border: '1px solid ' + T.red + '33', borderRadius: 6, padding: 10, marginBottom: 6 }}>
                              <div style={{ color: T.red, fontFamily: 'monospace', fontSize: 11, marginBottom: 4 }}>{f.path}</div>
                              {f.content && <pre style={{ color: T.muted, fontSize: 10, margin: 0, whiteSpace: 'pre-wrap' }}>{f.content.slice(0, 300)}</pre>}
                            </div>
                          ))}
                        </div>
                      )}
                      {fileSystem.files && fileSystem.files.map((f, i) => (
                        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid ' + T.border, fontSize: 11 }}>
                          <span style={{ color: T.text, fontFamily: 'monospace' }}>{f.path}</span>
                          <span style={{ color: T.muted, fontSize: 10 }}>{f.size}</span>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              )}

              {activeTab === 'database' && (
                <div style={{ padding: 14 }}>
                  {!databaseInfo ? (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 180, gap: 10, color: '#4a5568' }}>
                      <div style={{ fontSize: 36 }}>&#x1F5C4;</div>
                      <div style={{ fontSize: 12, textAlign: 'center', maxWidth: 220 }}>No database data extracted.</div>
                    </div>
                  ) : (
                    <>
                      <div style={{ display: 'flex', gap: 12, fontSize: 10, color: T.muted, marginBottom: 10, flexWrap: 'wrap' }}>
                        {databaseInfo.type && <span>Type: <span style={{ color: T.green }}>{databaseInfo.type}</span></span>}
                        {databaseInfo.version && <span>v{databaseInfo.version}</span>}
                        {databaseInfo.host && <span>Host: <span style={{ color: T.text }}>{databaseInfo.host}</span></span>}
                      </div>
                      {databaseInfo.databases && databaseInfo.databases.map((db, i) => (
                        <div key={i} style={{ background: T.bg, borderRadius: 8, padding: 12, marginBottom: 8, border: '1px solid ' + T.green + '22' }}>
                          <div style={{ fontWeight: 700, color: T.green, fontSize: 12, marginBottom: 8 }}>{db.name}</div>
                          {db.tables && db.tables.map((table, ti) => (
                            <div key={ti} style={{ marginLeft: 12, marginBottom: 6 }}>
                              <div style={{ fontSize: 11, fontWeight: 600, color: T.text }}>
                                {table.name}
                                {table.rowCount != null && <span style={{ color: T.muted, fontWeight: 400 }}> — {table.rowCount} rows</span>}
                              </div>
                              {table.sampleData && (
                                <pre style={{ fontSize: 9, color: T.muted, margin: '4px 0 0 12px', fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>
                                  {JSON.stringify(table.sampleData, null, 2).slice(0, 300)}
                                </pre>
                              )}
                            </div>
                          ))}
                          {db.query && (
                            <code style={{ fontSize: 10, color: '#a5f3fc', background: T.panel, padding: '4px 8px', borderRadius: 4, display: 'block', marginTop: 6, fontFamily: 'monospace' }}>{db.query}</code>
                          )}
                        </div>
                      ))}
                    </>
                  )}
                </div>
              )}

              {activeTab === 'chains' && (
                <div style={{ padding: 14 }}>
                  {!exploitChains || exploitChains.length === 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 180, gap: 10, color: '#4a5568' }}>
                      <div style={{ fontSize: 36 }}>&#x26D3;</div>
                      <div style={{ fontSize: 12, textAlign: 'center', maxWidth: 220 }}>{confirmedVulns.length < 2 ? 'Need 2+ confirmed vulnerabilities for chain analysis.' : 'No chains generated yet.'}</div>
                    </div>
                  ) : (
                    exploitChains.map((chain, i) => {
                      const sev = (chain.severity || 'high').toLowerCase();
                      const col = SEVERITY_COLOR[sev] || SEVERITY_COLOR.high;
                      return (
                        <div key={i} style={{ background: T.bg, borderRadius: 8, padding: 12, marginBottom: 8, borderLeft: '3px solid ' + col }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                            <div style={{ fontWeight: 700, fontSize: 13, color: T.text }}>{chain.name}</div>
                            <span style={{ padding: '2px 7px', borderRadius: 4, fontSize: 10, fontWeight: 700, textTransform: 'uppercase', background: SEVERITY_BG[sev] || SEVERITY_BG.info, color: col }}>{sev}</span>
                          </div>
                          <div style={{ fontSize: 11, color: T.muted, marginBottom: 8 }}>{chain.description}</div>
                          <div style={{ fontSize: 10, color: T.muted }}>
                            {chain.steps && chain.steps.map((step, si) => (
                              <div key={si} style={{ padding: '2px 0', display: 'flex', gap: 6 }}>
                                <span style={{ color: col, flexShrink: 0 }}>{si + 1}.</span>
                                <span>{step}</span>
                              </div>
                            ))}
                          </div>
                          {chain.cvss && <div style={{ marginTop: 6, fontSize: 10, color: T.muted }}>CVSS: <span style={{ color: col }}>{chain.cvss}</span></div>}
                        </div>
                      );
                    })
                  )}
                </div>
              )}

              {activeTab === 'ai' && (
                <div style={{ padding: 14 }}>
                  {!aiGuidance ? (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 180, gap: 10, color: '#4a5568' }}>
                      <div style={{ fontSize: 36 }}>&#x1F916;</div>
                      <div style={{ fontSize: 12, textAlign: 'center', maxWidth: 220 }}>AI Intelligence appears here after a scan with confirmed vulnerabilities.</div>
                    </div>
                  ) : (
                    <div>
                      <div style={{ fontSize: 10, fontWeight: 700, color: T.purple, textTransform: 'uppercase', letterSpacing: '.8px', marginBottom: 12 }}>AI Exploitation Guidance</div>
                      <pre style={{ fontSize: 11, color: T.text, background: T.bg, padding: 12, borderRadius: 7, whiteSpace: 'pre-wrap', fontFamily: 'monospace', lineHeight: 1.6, overflow: 'auto' }}>
                        {typeof aiGuidance === 'string' ? aiGuidance : JSON.stringify(aiGuidance, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'report' && (
                <div style={{ padding: 14 }}>
                  <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
                    {[
                      { fmt: 'html', label: 'HTML Report', color: T.blue },
                      { fmt: 'text', label: 'Text Report', color: T.muted },
                      { fmt: 'json', label: 'JSON Export', color: T.green },
                    ].map(({ fmt, label, color }) => (
                      <button key={fmt} onClick={() => handleGenerateReport(fmt)} style={{
                        padding: '8px 16px', fontSize: 11, fontWeight: 700,
                        background: color + '18', border: '1px solid ' + color + '44',
                        borderRadius: 6, color, cursor: 'pointer',
                      }}>{label}</button>
                    ))}
                  </div>

                  {compliance && (
                    <div style={{ marginBottom: 16 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: T.muted, textTransform: 'uppercase', letterSpacing: '.7px', marginBottom: 8 }}>Compliance</div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                        {[
                          { key: 'owasp', label: 'OWASP Top 10', color: T.red, detail: (compliance.owasp && compliance.owasp.categories ? compliance.owasp.categories.length : 0) + ' categories' },
                          { key: 'pciDss', label: 'PCI DSS', color: T.orange, detail: (compliance.pciDss && compliance.pciDss.compliant) ? 'Compliant' : 'Non-Compliant' },
                          { key: 'gdpr', label: 'GDPR', color: T.blue, detail: (compliance.gdpr && compliance.gdpr.compliant) ? 'Compliant' : 'Non-Compliant' },
                          { key: 'hipaa', label: 'HIPAA', color: T.green, detail: (compliance.hipaa && compliance.hipaa.compliant) ? 'Compliant' : 'Non-Compliant' },
                        ].map(({ key, label, color, detail }) => (
                          <div key={key} style={{ background: T.bg, padding: 10, borderRadius: 7, border: '1px solid ' + color + '22' }}>
                            <div style={{ fontSize: 11, fontWeight: 700, color, marginBottom: 3 }}>{label}</div>
                            <div style={{ fontSize: 10, color: T.muted }}>{detail}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div style={{ background: T.bg, borderRadius: 8, padding: 14, border: '1px solid ' + T.purple + '33' }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: T.purple, textTransform: 'uppercase', letterSpacing: '.7px', marginBottom: 10 }}>Send Report</div>
                    <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                      <input type="email" value={notifyEmail} onChange={(e) => setNotifyEmail(e.target.value)}
                        placeholder="owner@example.com"
                        style={{ flex: 1, padding: '8px 10px', fontSize: 11, background: T.panel, border: '1px solid ' + T.border2, borderRadius: 6, color: T.text, fontFamily: 'monospace', outline: 'none' }} />
                      <button onClick={() => handleSendNotification('email')} style={{
                        padding: '8px 14px', fontSize: 11, fontWeight: 700, background: T.purple, color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer',
                      }}>Email</button>
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <input type="tel" value={notifyPhone} onChange={(e) => setNotifyPhone(e.target.value)}
                        placeholder="WhatsApp (62xxx)"
                        style={{ flex: 1, padding: '8px 10px', fontSize: 11, background: T.panel, border: '1px solid ' + T.border2, borderRadius: 6, color: T.text, fontFamily: 'monospace', outline: 'none' }} />
                      <button onClick={() => handleSendNotification('whatsapp')} style={{
                        padding: '8px 14px', fontSize: 11, fontWeight: 700, background: '#25D366', color: '#000', border: 'none', borderRadius: 6, cursor: 'pointer',
                      }}>WhatsApp</button>
                    </div>
                    {notifyResult && (
                      <div style={{ marginTop: 8, padding: '6px 10px', borderRadius: 5, fontSize: 10, background: (notifyResult.success ? T.green : T.red) + '18', color: notifyResult.success ? T.green : T.red, border: '1px solid ' + (notifyResult.success ? T.green : T.red) + '33' }}>
                        {notifyResult.message}
                      </div>
                    )}
                  </div>
                </div>
              )}

            </div>
          </div>
        </div>

        <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.6}}`}</style>

      </div>
    </DashboardLayout>
  );
}
