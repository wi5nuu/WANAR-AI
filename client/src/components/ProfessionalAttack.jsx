import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import DashboardLayout from './DashboardLayout';

export default function ProfessionalAttack() {
  const navigate = useNavigate();
  const [target, setTarget] = useState('');
  const [isAttacking, setIsAttacking] = useState(false);
  const [attackLog, setAttackLog] = useState([]);
  const [confirmedVulns, setConfirmedVulns] = useState([]);
  const [extractedData, setExtractedData] = useState(null);
  const [credentials, setCredentials] = useState(null);
  const [fileSystem, setFileSystem] = useState(null);
  const [databaseInfo, setDatabaseInfo] = useState(null);
  const [attackProgress, setAttackProgress] = useState({ phase: '', percent: 0 });
  const [report, setReport] = useState(null);
  const [compliance, setCompliance] = useState(null);
  const [exploitChains, setExploitChains] = useState(null);
  const [aiGuidance, setAiGuidance] = useState(null);
  const [activeTab, setActiveTab] = useState('live');
  const [modules, setModules] = useState({
    sqli: true, xss: true, ssti: true, nosqli: true, lfi: true,
    cmdi: true, ssrf: true, xxe: true, jwt: true, graphql: true,
    idor: true, redirect: true, upload: true, cors: true,
    ddos: true, bruteforce: true,
  });
  const [intensity, setIntensity] = useState('high');
  const [ddosConfig, setDdosConfig] = useState({ requestsPerSecond: 20000, duration: 50, method: 'http' });
  const [bruteConfig, setBruteConfig] = useState({ wordlist: 'common', threads: 50, delay: 0 });
  const [notifyEmail, setNotifyEmail] = useState('');
  const [notifyPhone, setNotifyPhone] = useState('');
  const [notifyResult, setNotifyResult] = useState(null);
  const abortRef = useRef(null);
  const logRef = useRef(null);

  const addLog = useCallback((type, message, data) => {
    const entry = { timestamp: new Date().toISOString(), type, message, data };
    setAttackLog(prev => [...prev, entry]);
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [attackLog]);

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

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      addLog('info', 'Professional Attack Engine initializing...');
      addLog('info', `Target: ${target}`);
      addLog('warning', '⚠️ LEGAL DISCLAIMER: Only test systems you own or have written permission to test.');
      addLog('info', `Modules: ${Object.entries(modules).filter(([,v]) => v).map(([k]) => k.toUpperCase()).join(', ')}`);
      addLog('info', `Intensity: ${intensity.toUpperCase()}`);
      addLog('info', 'Establishing connection to target...');

      const resp = await fetch('/api/security/attack/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target,
          scanType: intensity === 'critical' ? 'deep' : intensity === 'high' ? 'deep' : 'quick',
          modules: Object.entries(modules).filter(([,v]) => v).map(([k]) => k),
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
      let currentEvent = '';
      let currentData = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('event: ')) {
            currentEvent = trimmed.slice(7).trim();
          } else if (trimmed.startsWith('data: ')) {
            currentData = trimmed.slice(6).trim();
          } else if (trimmed === '') {
            // End of SSE event — parse it
            if (currentData) {
              try {
                const parsed = JSON.parse(currentData);
                handleEvent(parsed);
              } catch (e) {
                // Not JSON
              }
            }
            currentEvent = '';
            currentData = '';
          }
        }
      }
      // Handle any remaining data in buffer
      if (currentData) {
        try {
          const parsed = JSON.parse(currentData);
          handleEvent(parsed);
        } catch {}
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        addLog('warning', 'Attack stopped by user.');
      } else {
        addLog('error', `Attack failed: ${err.message}`);
      }
    } finally {
      setIsAttacking(false);
      abortRef.current = null;
      setAttackProgress({ phase: 'Complete', percent: 100 });
    }
  }, [target, modules, intensity, addLog]);

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

  const toggleModule = (key) => setModules(prev => ({ ...prev, [key]: !prev[key] }));

  return (
    <DashboardLayout>
      <div style={{
        padding: '24px', maxWidth: '1400px', margin: '0 auto', width: '100%',
        fontFamily: "'Segoe UI', 'Consolas', monospace",
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          marginBottom: '20px',
        }}>
          <div>
            <h1 style={{ fontSize: '22px', fontWeight: '800', color: '#d32f2f', margin: 0, letterSpacing: '1px' }}>
              ⚡ PROFESSIONAL PENTEST ENGINE v3.0
            </h1>
            <p style={{ fontSize: '12px', color: '#999', margin: '4px 0 0' }}>
              Advanced exploitation framework | Real attack | Data extraction | DDoS | Brute force | Compliance reporting
            </p>
          </div>
          <div style={{
            padding: '8px 16px', background: isAttacking ? '#d32f2f22' : '#1b5e2022',
            border: `1px solid ${isAttacking ? '#d32f2f' : '#2e7d32'}`,
            borderRadius: '8px', fontSize: '12px', fontWeight: '700',
            color: isAttacking ? '#d32f2f' : '#2e7d32',
          }}>
            {isAttacking ? '⚔️ ATTACK IN PROGRESS' : '🛡️ SYSTEM ARMED'}
          </div>
        </div>

        <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
          {/* Left Column - Configuration */}
          <div style={{ flex: '0 0 320px', minWidth: '280px' }}>
            {/* Target Input */}
            <div style={{
              background: '#1a1a2e', borderRadius: '10px', padding: '16px',
              border: '1px solid #333', marginBottom: '16px',
            }}>
              <label style={{ fontSize: '11px', fontWeight: '600', color: '#ff9800', marginBottom: '6px', display: 'block', textTransform: 'uppercase', letterSpacing: '1px' }}>
                TARGET URL
              </label>
              <input
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder="https://target.com"
                disabled={isAttacking}
                style={{
                  width: '100%', padding: '10px 12px', fontSize: '13px',
                  background: '#0d0d1a', border: '1px solid #333', borderRadius: '6px',
                  color: '#00ff00', fontFamily: 'monospace',
                  outline: 'none', boxSizing: 'border-box',
                }}
              />
            </div>

            {/* Attack Modules */}
            <div style={{
              background: '#1a1a2e', borderRadius: '10px', padding: '16px',
              border: '1px solid #333', marginBottom: '16px',
            }}>
              <div style={{ fontSize: '11px', fontWeight: '600', color: '#ff9800', marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '1px' }}>
                ⚙️ ATTACK MODULES
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px' }}>
                {[
                  ['sqli', 'SQL Injection', '#d32f2f'],
                  ['xss', 'XSS', '#e65100'],
                  ['ssti', 'SSTI', '#f9a825'],
                  ['nosqli', 'NoSQL Injection', '#2e7d32'],
                  ['lfi', 'LFI/RFI', '#1565c0'],
                  ['cmdi', 'CMD Injection', '#6a1b9a'],
                  ['ssrf', 'SSRF', '#00838f'],
                  ['xxe', 'XXE', '#4e342e'],
                  ['jwt', 'JWT Attack', '#37474f'],
                  ['graphql', 'GraphQL', '#1a237e'],
                  ['idor', 'IDOR', '#827717'],
                  ['redirect', 'Open Redirect', '#bf360c'],
                  ['upload', 'File Upload', '#3e2723'],
                  ['cors', 'CORS', '#004d40'],
                ].map(([key, label, color]) => (
                  <button
                    key={key}
                    onClick={() => toggleModule(key)}
                    style={{
                      padding: '6px 8px', fontSize: '11px', fontWeight: '600',
                      background: modules[key] ? `${color}33` : 'transparent',
                      border: `1px solid ${modules[key] ? color : '#333'}`,
                      borderRadius: '4px', color: modules[key] ? color : '#666',
                      cursor: 'pointer', textAlign: 'left',
                      transition: 'all 0.2s',
                    }}
                  >
                    {modules[key] ? '✓ ' : '○ '}{label}
                  </button>
                ))}
              </div>
              <div style={{ marginTop: '8px', display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                <button
                  onClick={() => toggleModule('ddos')}
                  style={{
                    padding: '6px 10px', fontSize: '11px', fontWeight: '700',
                    background: modules.ddos ? '#d32f2f33' : 'transparent',
                    border: `1px solid ${modules.ddos ? '#d32f2f' : '#333'}`,
                    borderRadius: '4px', color: modules.ddos ? '#d32f2f' : '#666',
                    cursor: 'pointer',
                  }}
                >
                  {modules.ddos ? '✓ ' : '○ '}💥 DDoS Attack
                </button>
                <button
                  onClick={() => toggleModule('bruteforce')}
                  style={{
                    padding: '6px 10px', fontSize: '11px', fontWeight: '700',
                    background: modules.bruteforce ? '#e6510033' : 'transparent',
                    border: `1px solid ${modules.bruteforce ? '#e65100' : '#333'}`,
                    borderRadius: '4px', color: modules.bruteforce ? '#e65100' : '#666',
                    cursor: 'pointer',
                  }}
                >
                  {modules.bruteforce ? '✓ ' : '○ '}🔓 Brute Force
                </button>
              </div>
            </div>

            {/* Intensity & Advanced Config */}
            <div style={{
              background: '#1a1a2e', borderRadius: '10px', padding: '16px',
              border: '1px solid #333', marginBottom: '16px',
            }}>
              <div style={{ fontSize: '11px', fontWeight: '600', color: '#ff9800', marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '1px' }}>
                ⚡ INTENSITY
              </div>
              <div style={{ display: 'flex', gap: '6px', marginBottom: '12px' }}>
                {['low', 'medium', 'high', 'critical'].map(level => (
                  <button
                    key={level}
                    onClick={() => setIntensity(level)}
                    style={{
                      flex: 1, padding: '8px 4px', fontSize: '10px', fontWeight: '700',
                      background: intensity === level ? (
                        level === 'critical' ? '#d32f2f' : level === 'high' ? '#e65100' :
                        level === 'medium' ? '#f9a825' : '#2e7d32'
                      ) : 'transparent',
                      border: `1px solid ${intensity === level ? 'transparent' : '#333'}`,
                      borderRadius: '4px', color: intensity === level ? 'white' : '#666',
                      cursor: 'pointer', textTransform: 'uppercase',
                    }}
                  >
                    {level}
                  </button>
                ))}
              </div>

              {modules.ddos && (
                <div style={{ marginTop: '10px', padding: '10px', background: '#0d0d1a', borderRadius: '6px' }}>
                  <div style={{ fontSize: '10px', fontWeight: '600', color: '#d32f2f', marginBottom: '6px' }}>💥 DDoS CONFIG</div>
                  <div style={{ display: 'flex', gap: '6px', marginBottom: '4px' }}>
                    <input type="number" value={ddosConfig.requestsPerSecond} onChange={(e) => setDdosConfig(p => ({ ...p, requestsPerSecond: parseInt(e.target.value) || 10000 }))}
                      style={{ width: '50%', padding: '4px 6px', fontSize: '11px', background: '#1a1a2e', border: '1px solid #d32f2f', borderRadius: '3px', color: '#fff', fontFamily: 'monospace' }}
                      placeholder="Req/s" />
                    <input type="number" value={ddosConfig.duration} onChange={(e) => setDdosConfig(p => ({ ...p, duration: parseInt(e.target.value) || 60 }))}
                      style={{ width: '50%', padding: '4px 6px', fontSize: '11px', background: '#1a1a2e', border: '1px solid #d32f2f', borderRadius: '3px', color: '#fff', fontFamily: 'monospace' }}
                      placeholder="Duration (s)" />
                  </div>
                  <div style={{ fontSize: '9px', color: '#999' }}>
                    Method: {ddosConfig.method.toUpperCase()} | {ddosConfig.requestsPerSecond.toLocaleString()} req/s × {ddosConfig.duration}s = {(ddosConfig.requestsPerSecond * ddosConfig.duration).toLocaleString()} total requests
                  </div>
                </div>
              )}

              {modules.bruteforce && (
                <div style={{ marginTop: '10px', padding: '10px', background: '#0d0d1a', borderRadius: '6px' }}>
                  <div style={{ fontSize: '10px', fontWeight: '600', color: '#e65100', marginBottom: '6px' }}>🔓 BRUTE FORCE CONFIG</div>
                  <div style={{ display: 'flex', gap: '6px', fontSize: '11px', color: '#ccc' }}>
                    <select value={bruteConfig.wordlist} onChange={(e) => setBruteConfig(p => ({ ...p, wordlist: e.target.value }))}
                      style={{ flex: 1, padding: '4px', background: '#1a1a2e', border: '1px solid #e65100', borderRadius: '3px', color: '#fff', fontSize: '11px' }}>
                      <option value="common">Common (100 creds)</option>
                      <option value="extended">Extended (1000 creds)</option>
                      <option value="rockyou">RockYou (10M creds)</option>
                    </select>
                    <input type="number" value={bruteConfig.threads} onChange={(e) => setBruteConfig(p => ({ ...p, threads: parseInt(e.target.value) || 50 }))}
                      style={{ width: '60px', padding: '4px', background: '#1a1a2e', border: '1px solid #e65100', borderRadius: '3px', color: '#fff', fontFamily: 'monospace', fontSize: '11px' }}
                      placeholder="Threads" />
                  </div>
                </div>
              )}
            </div>

            {/* Action Buttons */}
            <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
              {!isAttacking ? (
                <button onClick={handleStartAttack} disabled={!target}
                  style={{
                    flex: 1, padding: '14px 20px', fontSize: '14px', fontWeight: '800',
                    background: !target ? '#333' : 'linear-gradient(135deg, #d32f2f, #b71c1c)',
                    color: !target ? '#666' : 'white', border: 'none', borderRadius: '8px',
                    cursor: !target ? 'not-allowed' : 'pointer',
                    boxShadow: !target ? 'none' : '0 4px 20px rgba(211,47,47,0.4)',
                    letterSpacing: '1px', textTransform: 'uppercase',
                  }}
                >
                  ⚡ START ATTACK
                </button>
              ) : (
                <button onClick={handleStop}
                  style={{
                    flex: 1, padding: '14px 20px', fontSize: '14px', fontWeight: '800',
                    background: '#d32f2f', color: 'white', border: 'none', borderRadius: '8px',
                    cursor: 'pointer', letterSpacing: '1px', textTransform: 'uppercase',
                  }}
                >
                  ■ STOP ATTACK
                </button>
              )}
            </div>
          </div>

          {/* Right Column - Dashboard */}
          <div style={{ flex: 1, minWidth: '500px' }}>
            {/* Tabs */}
            <div style={{
              display: 'flex', gap: '2px', marginBottom: '12px',
              background: '#1a1a2e', borderRadius: '8px', padding: '3px',
              border: '1px solid #333',
            }}>
              {[
                ['live', 'LIVE', '#00ff00'],
                ['vulns', 'VULNS', '#d32f2f'],
                ['data', 'DATA', '#ff9800'],
                ['creds', 'CREDS', '#e65100'],
                ['fs', 'FILES', '#1565c0'],
                ['db', 'DATABASE', '#2e7d32'],
                ['chains', 'CHAINS', '#6a1b9a'],
                ['report', 'REPORT', '#1a237e'],
              ].map(([key, label, color]) => (
                <button key={key} onClick={() => setActiveTab(key)}
                  style={{
                    flex: 1, padding: '6px 4px', fontSize: '9px', fontWeight: '700',
                    background: activeTab === key ? `${color}22` : 'transparent',
                    border: `1px solid ${activeTab === key ? color : 'transparent'}`,
                    borderRadius: '5px', color: activeTab === key ? color : '#555',
                    cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.5px',
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* Tab Content */}
            <div style={{
              background: '#1a1a2e', borderRadius: '10px', border: '1px solid #333',
              minHeight: '400px', maxHeight: '600px', overflow: 'auto',
            }}>
              {/* LIVE Tab - Attack Log */}
              {activeTab === 'live' && (
                <div ref={logRef} style={{ padding: '12px', height: '100%', overflow: 'auto', fontFamily: "'Consolas', 'Courier New', monospace", fontSize: '12px' }}>
                  {/* Progress Bar */}
                  <div style={{ marginBottom: '12px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: '#999', marginBottom: '4px' }}>
                      <span>{attackProgress.phase}</span>
                      <span>{attackProgress.percent}%</span>
                    </div>
                    <div style={{ height: '4px', background: '#0d0d1a', borderRadius: '2px', overflow: 'hidden' }}>
                      <div style={{
                        height: '100%', width: `${attackProgress.percent}%`,
                        background: 'linear-gradient(90deg, #2e7d32, #f9a825, #d32f2f)',
                        borderRadius: '2px', transition: 'width 0.3s ease',
                      }} />
                    </div>
                  </div>

                  {attackLog.length === 0 && !isAttacking && (
                    <div style={{ textAlign: 'center', padding: '60px 20px', color: '#555' }}>
                      <div style={{ fontSize: '40px', marginBottom: '12px' }}>⚔️</div>
                      <div style={{ fontSize: '14px', fontWeight: '600', color: '#777', marginBottom: '8px' }}>PENTEST ENGINE ARMED</div>
                      <div style={{ fontSize: '11px', color: '#555' }}>
                        Configure target and modules above, then click START ATTACK
                      </div>
                      <div style={{ fontSize: '10px', color: '#444', marginTop: '12px' }}>
                        LEGAL: Only attack systems you own or have explicit permission to test
                      </div>
                    </div>
                  )}

                  {attackLog.map((entry, i) => (
                    <div key={i} style={{
                      display: 'flex', gap: '8px', padding: '2px 0',
                      borderBottom: '1px solid #0d0d1a',
                      color: entry.type === 'error' ? '#d32f2f' :
                             entry.type === 'confirmed' ? '#00ff00' :
                             entry.type === 'fake' ? '#666' :
                             entry.type === 'warning' ? '#ff9800' :
                             entry.type === 'success' ? '#2e7d32' :
                             entry.type === 'ai' ? '#7c4dff' :
                             entry.type === 'exploit' ? '#ff1744' :
                             entry.type === 'ddos' ? '#ff6d00' :
                             entry.type === 'payload' ? '#4fc3f7' : '#ccc',
                    }}>
                      <span style={{ color: '#555', minWidth: '80px', fontSize: '10px' }}>
                        {new Date(entry.timestamp).toLocaleTimeString()}
                      </span>
                      <span style={{ flex: 1, whiteSpace: 'pre-wrap' }}>{entry.message}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* VULNS Tab */}
              {activeTab === 'vulns' && (
                <div style={{ padding: '16px' }}>
                  <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
                    <span style={{ fontSize: '13px', fontWeight: '700', color: '#d32f2f' }}>{confirmedVulns.filter(v => v.severity === 'Critical').length} Critical</span>
                    <span style={{ fontSize: '13px', fontWeight: '700', color: '#e65100' }}>{confirmedVulns.filter(v => v.severity === 'High').length} High</span>
                    <span style={{ fontSize: '13px', color: '#f9a825' }}>{confirmedVulns.filter(v => v.severity === 'Medium').length} Medium</span>
                    <span style={{ fontSize: '13px', color: '#1976d2' }}>{confirmedVulns.filter(v => v.severity === 'Low').length} Low</span>
                  </div>
                  {confirmedVulns.map((v, i) => (
                    <div key={i} style={{
                      background: '#0d0d1a', borderRadius: '6px', padding: '10px',
                      marginBottom: '8px', borderLeft: `3px solid ${
                        v.severity === 'Critical' ? '#d32f2f' : v.severity === 'High' ? '#e65100' :
                        v.severity === 'Medium' ? '#f9a825' : '#1976d2'
                      }`,
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                        <span style={{ fontWeight: '700', fontSize: '13px', color: '#fff' }}>{v.type}</span>
                        <span style={{
                          padding: '2px 8px', borderRadius: '8px', fontSize: '10px', fontWeight: '700',
                          background: v.severity === 'Critical' ? '#d32f2f33' : v.severity === 'High' ? '#e6510033' : '#f9a82533',
                          color: v.severity === 'Critical' ? '#d32f2f' : v.severity === 'High' ? '#e65100' : '#f9a825',
                        }}>
                          {v.severity}
                        </span>
                      </div>
                      <div style={{ fontSize: '11px', color: '#aaa', marginBottom: '4px' }}>{v.description}</div>
                      <div style={{ fontSize: '10px', color: '#666' }}>
                        CVSS: {v.cvss} | CWE: {v.cwe || 'N/A'} | {v.location}
                      </div>
                    </div>
                  ))}
                  {confirmedVulns.length === 0 && (
                    <div style={{ textAlign: 'center', padding: '40px', color: '#555', fontSize: '12px' }}>
                      No vulnerabilities confirmed yet. Start an attack.
                    </div>
                  )}
                </div>
              )}

              {/* DATA Tab */}
              {activeTab === 'data' && (
                <div style={{ padding: '16px' }}>
                  <div style={{ fontSize: '12px', fontWeight: '600', color: '#ff9800', marginBottom: '12px' }}>
                    📦 EXTRACTED DATA
                  </div>
                  {extractedData ? (
                    <pre style={{ fontSize: '11px', color: '#00ff00', background: '#0d0d1a', padding: '12px', borderRadius: '6px', overflow: 'auto', maxHeight: '400px', fontFamily: 'monospace' }}>
                      {JSON.stringify(extractedData, null, 2)}
                    </pre>
                  ) : (
                    <div style={{ textAlign: 'center', padding: '40px', color: '#555', fontSize: '12px' }}>
                      {isAttacking ? '⏳ Extracting data after attack completes...' : 'Run an attack first to extract data.'}
                    </div>
                  )}
                </div>
              )}

              {/* CREDS Tab */}
              {activeTab === 'creds' && (
                <div style={{ padding: '16px' }}>
                  <div style={{ fontSize: '12px', fontWeight: '600', color: '#e65100', marginBottom: '12px' }}>
                    🔑 EXTRACTED CREDENTIALS
                  </div>
                  {credentials && credentials.length > 0 ? (
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
                      <thead>
                        <tr style={{ borderBottom: '1px solid #333' }}>
                          <th style={{ padding: '6px 8px', textAlign: 'left', color: '#ff9800' }}>Type</th>
                          <th style={{ padding: '6px 8px', textAlign: 'left', color: '#ff9800' }}>Username</th>
                          <th style={{ padding: '6px 8px', textAlign: 'left', color: '#ff9800' }}>Password/Hash</th>
                          <th style={{ padding: '6px 8px', textAlign: 'left', color: '#ff9800' }}>Source</th>
                        </tr>
                      </thead>
                      <tbody>
                        {credentials.map((c, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid #222' }}>
                            <td style={{ padding: '6px 8px', color: '#fff' }}>{c.type}</td>
                            <td style={{ padding: '6px 8px', color: '#00ff00', fontFamily: 'monospace' }}>{c.username}</td>
                            <td style={{ padding: '6px 8px', color: '#d32f2f', fontFamily: 'monospace' }}>{c.password || c.hash}</td>
                            <td style={{ padding: '6px 8px', color: '#999' }}>{c.source}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <div style={{ textAlign: 'center', padding: '40px', color: '#555', fontSize: '12px' }}>
                      No credentials extracted yet.
                    </div>
                  )}
                </div>
              )}

              {/* FILES Tab */}
              {activeTab === 'fs' && (
                <div style={{ padding: '16px' }}>
                  <div style={{ fontSize: '12px', fontWeight: '600', color: '#1565c0', marginBottom: '12px' }}>
                    📁 FILE SYSTEM ACCESS
                  </div>
                  {fileSystem ? (
                    <div>
                      <div style={{ fontSize: '11px', color: '#888', marginBottom: '8px' }}>
                        Server: {fileSystem.server} | OS: {fileSystem.os} | User: {fileSystem.user}
                      </div>
                      {fileSystem.files?.map((f, i) => (
                        <div key={i} style={{
                          display: 'flex', justifyContent: 'space-between', padding: '4px 8px',
                          borderBottom: '1px solid #222', fontSize: '11px',
                        }}>
                          <span style={{ color: '#fff', fontFamily: 'monospace' }}>{f.path}</span>
                          <span style={{ color: '#888' }}>{f.size}</span>
                        </div>
                      ))}
                      {fileSystem.sensitiveFiles?.length > 0 && (
                        <div style={{ marginTop: '12px' }}>
                          <div style={{ fontSize: '11px', fontWeight: '600', color: '#d32f2f', marginBottom: '6px' }}>
                            🔴 SENSITIVE FILES FOUND:
                          </div>
                          {fileSystem.sensitiveFiles.map((f, i) => (
                            <div key={i} style={{
                              background: '#d32f2f11', padding: '8px', borderRadius: '4px',
                              marginBottom: '4px', fontSize: '11px', fontFamily: 'monospace',
                              border: '1px solid #d32f2f44',
                            }}>
                              <div style={{ color: '#ff6b6b' }}>{f.path}</div>
                              <pre style={{ color: '#ffab91', margin: '4px 0 0', fontSize: '10px', whiteSpace: 'pre-wrap' }}>{f.content?.slice(0, 300)}</pre>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div style={{ textAlign: 'center', padding: '40px', color: '#555', fontSize: '12px' }}>
                      No file system data extracted.
                    </div>
                  )}
                </div>
              )}

              {/* DATABASE Tab */}
              {activeTab === 'db' && (
                <div style={{ padding: '16px' }}>
                  <div style={{ fontSize: '12px', fontWeight: '600', color: '#2e7d32', marginBottom: '12px' }}>
                    🗄️ DATABASE ACCESS
                  </div>
                  {databaseInfo ? (
                    <div>
                      <div style={{ fontSize: '11px', color: '#888', marginBottom: '8px' }}>
                        Type: {databaseInfo.type} | Version: {databaseInfo.version} | Host: {databaseInfo.host}
                      </div>
                      {databaseInfo.databases?.map((db, i) => (
                        <div key={i} style={{
                          background: '#0d0d1a', borderRadius: '6px', padding: '10px',
                          marginBottom: '8px', border: '1px solid #2e7d3244',
                        }}>
                          <div style={{ fontSize: '12px', fontWeight: '700', color: '#2e7d32', marginBottom: '6px' }}>
                            📂 {db.name}
                          </div>
                          {db.tables?.map((table, ti) => (
                            <div key={ti} style={{ marginLeft: '12px', marginBottom: '4px' }}>
                              <div style={{ fontSize: '11px', fontWeight: '600', color: '#fff' }}>
                                📋 {table.name} ({table.rowCount} rows)
                              </div>
                              {table.sampleData && (
                                <pre style={{ fontSize: '10px', color: '#aaa', marginLeft: '12px', fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>
                                  {JSON.stringify(table.sampleData, null, 2).slice(0, 500)}
                                </pre>
                              )}
                            </div>
                          ))}
                          {db.query && (
                            <div style={{ marginTop: '4px', padding: '6px', background: '#000', borderRadius: '3px' }}>
                              <code style={{ fontSize: '10px', color: '#00ff00' }}>{db.query}</code>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ textAlign: 'center', padding: '40px', color: '#555', fontSize: '12px' }}>
                      No database information extracted.
                    </div>
                  )}
                </div>
              )}

              {/* CHAINS Tab */}
              {activeTab === 'chains' && (
                <div style={{ padding: '16px' }}>
                  <div style={{ fontSize: '12px', fontWeight: '600', color: '#6a1b9a', marginBottom: '12px' }}>
                    ⚔️ EXPLOITATION CHAINS
                  </div>
                  {exploitChains ? (
                    exploitChains.map((chain, i) => (
                      <div key={i} style={{
                        background: '#0d0d1a', borderRadius: '6px', padding: '12px',
                        marginBottom: '10px', borderLeft: `3px solid #6a1b9a`,
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                          <span style={{ fontWeight: '700', fontSize: '13px', color: '#fff' }}>{chain.name}</span>
                          <span style={{
                            padding: '2px 8px', borderRadius: '8px', fontSize: '10px', fontWeight: '700',
                            background: chain.severity === 'Critical' ? '#d32f2f33' : '#e6510033',
                            color: chain.severity === 'Critical' ? '#d32f2f' : '#e65100',
                          }}>{chain.severity}</span>
                        </div>
                        <div style={{ fontSize: '11px', color: '#aaa', marginBottom: '8px' }}>{chain.description}</div>
                        <div style={{ fontSize: '10px', color: '#888' }}>
                          {chain.steps?.map((step, si) => (
                            <div key={si} style={{ padding: '2px 0' }}>
                              <span style={{ color: '#6a1b9a' }}>→</span> {step}
                            </div>
                          ))}
                        </div>
                        <div style={{ marginTop: '6px', fontSize: '10px', color: '#555' }}>
                          CVSS: {chain.cvss}
                        </div>
                      </div>
                    ))
                  ) : (
                    <div style={{ textAlign: 'center', padding: '40px', color: '#555', fontSize: '12px' }}>
                      {confirmedVulns.length < 2 ? 'Need at least 2 confirmed vulnerabilities for chain analysis.' : 'Exploitation chains not generated.'}
                    </div>
                  )}
                </div>
              )}

              {/* REPORT Tab */}
              {activeTab === 'report' && (
                <div style={{ padding: '16px' }}>
                  <div style={{ fontSize: '12px', fontWeight: '600', color: '#1a237e', marginBottom: '12px' }}>
                    📋 PROFESSIONAL REPORT
                  </div>

                  {/* Report Actions */}
                  <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' }}>
                    <button onClick={() => handleGenerateReport('html')} style={{
                      padding: '10px 18px', fontSize: '12px', fontWeight: '700',
                      background: 'linear-gradient(135deg, #1a237e, #283593)',
                      color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer',
                    }}>
                      🌐 HTML Report
                    </button>
                    <button onClick={() => handleGenerateReport('text')} style={{
                      padding: '10px 18px', fontSize: '12px', fontWeight: '700',
                      background: '#333', color: 'white', border: '1px solid #555', borderRadius: '6px', cursor: 'pointer',
                    }}>
                      📄 Text Report
                    </button>
                    <button onClick={() => handleGenerateReport('json')} style={{
                      padding: '10px 18px', fontSize: '12px', fontWeight: '700',
                      background: '#333', color: 'white', border: '1px solid #555', borderRadius: '6px', cursor: 'pointer',
                    }}>
                      📊 JSON Export
                    </button>
                  </div>

                  {/* Compliance */}
                  {compliance && (
                    <div style={{ marginBottom: '16px' }}>
                      <div style={{ fontSize: '12px', fontWeight: '600', color: '#ff9800', marginBottom: '8px' }}>
                        COMPLIANCE STANDARDS
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                        <div style={{ background: '#0d0d1a', padding: '10px', borderRadius: '6px' }}>
                          <div style={{ fontSize: '11px', fontWeight: '600', color: '#f44336', marginBottom: '4px' }}>OWASP Top 10 2021</div>
                          <div style={{ fontSize: '10px', color: '#aaa' }}>{compliance.owasp.categories.length} categories affected</div>
                          <div style={{ fontSize: '9px', color: '#666' }}>
                            {compliance.owasp.categories.slice(0, 3).map(c => c.name).join(', ')}
                          </div>
                        </div>
                        <div style={{ background: '#0d0d1a', padding: '10px', borderRadius: '6px' }}>
                          <div style={{ fontSize: '11px', fontWeight: '600', color: '#ff9800', marginBottom: '4px' }}>PCI DSS v3.2.1</div>
                          <div style={{ fontSize: '10px', color: '#aaa' }}>{compliance.pciDss.requirements.length} reqs affected</div>
                          <div style={{ fontSize: '9px', color: compliance.pciDss.compliant ? '#2e7d32' : '#d32f2f' }}>
                            {compliance.pciDss.compliant ? '✓ Compliant' : '✗ Non-Compliant'}
                          </div>
                        </div>
                        <div style={{ background: '#0d0d1a', padding: '10px', borderRadius: '6px' }}>
                          <div style={{ fontSize: '11px', fontWeight: '600', color: '#2196f3', marginBottom: '4px' }}>GDPR</div>
                          <div style={{ fontSize: '10px', color: '#aaa' }}>{compliance.gdpr.articles.length} articles violated</div>
                          <div style={{ fontSize: '9px', color: compliance.gdpr.compliant ? '#2e7d32' : '#d32f2f' }}>
                            {compliance.gdpr.compliant ? '✓ Compliant' : '✗ Non-Compliant'}
                          </div>
                        </div>
                        <div style={{ background: '#0d0d1a', padding: '10px', borderRadius: '6px' }}>
                          <div style={{ fontSize: '11px', fontWeight: '600', color: '#4caf50', marginBottom: '4px' }}>HIPAA</div>
                          <div style={{ fontSize: '10px', color: '#aaa' }}>{compliance.hipaa.requirements.length} reqs affected</div>
                          <div style={{ fontSize: '9px', color: compliance.hipaa.compliant ? '#2e7d32' : '#d32f2f' }}>
                            {compliance.hipaa.compliant ? '✓ Compliant' : '✗ Non-Compliant'}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Notification */}
                  <div style={{ background: '#0d0d1a', borderRadius: '8px', padding: '14px', border: '1px solid #7b1fa244' }}>
                    <div style={{ fontSize: '11px', fontWeight: '600', color: '#7b1fa2', marginBottom: '8px' }}>
                      📧 SEND REPORT TO WEBSITE OWNER
                    </div>
                    <div style={{ display: 'flex', gap: '6px', marginBottom: '6px' }}>
                      <input type="email" value={notifyEmail} onChange={(e) => setNotifyEmail(e.target.value)}
                        placeholder="Owner email address..."
                        style={{ flex: 1, padding: '8px 10px', fontSize: '12px', background: '#1a1a2e', border: '1px solid #7b1fa2', borderRadius: '4px', color: '#fff', fontFamily: 'monospace' }} />
                      <button onClick={() => handleSendNotification('email')} style={{
                        padding: '8px 14px', fontSize: '11px', fontWeight: '700',
                        background: '#7b1fa2', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer',
                      }}>
                        Send Email
                      </button>
                    </div>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <input type="tel" value={notifyPhone} onChange={(e) => setNotifyPhone(e.target.value)}
                        placeholder="WhatsApp number (62xxx)..."
                        style={{ flex: 1, padding: '8px 10px', fontSize: '12px', background: '#1a1a2e', border: '1px solid #25D366', borderRadius: '4px', color: '#fff', fontFamily: 'monospace' }} />
                      <button onClick={() => handleSendNotification('whatsapp')} style={{
                        padding: '8px 14px', fontSize: '11px', fontWeight: '700',
                        background: '#25D366', color: '#000', border: 'none', borderRadius: '4px', cursor: 'pointer',
                      }}>
                        Send WA
                      </button>
                    </div>
                    {notifyResult && (
                      <div style={{
                        marginTop: '6px', padding: '6px 10px', borderRadius: '4px', fontSize: '10px',
                        background: notifyResult.success ? '#2e7d3222' : '#d32f2f22',
                        color: notifyResult.success ? '#2e7d32' : '#d32f2f',
                      }}>
                        {notifyResult.message}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
