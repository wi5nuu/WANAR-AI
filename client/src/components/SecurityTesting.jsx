import { useState, useRef, useCallback, useEffect } from 'react';
import DashboardLayout from './DashboardLayout';

const inputStyle = {
  width: '100%',
  padding: '10px 12px',
  fontSize: '14px',
  border: '1px solid var(--border-primary)',
  borderRadius: '8px',
  background: 'var(--bg-tertiary)',
  color: 'var(--text-primary)',
  outline: 'none',
  fontFamily: 'inherit',
  transition: 'border-color 0.2s',
};

const labelStyle = {
  fontSize: '13px',
  fontWeight: '600',
  color: 'var(--text-secondary)',
  marginBottom: '6px',
  display: 'block',
};

const selectStyle = {
  width: '100%',
  padding: '10px 12px',
  fontSize: '14px',
  border: '1px solid var(--border-primary)',
  borderRadius: '8px',
  background: 'var(--bg-tertiary)',
  color: 'var(--text-primary)',
  outline: 'none',
  fontFamily: 'inherit',
  cursor: 'pointer',
  transition: 'border-color 0.2s',
};

const SEVERITY_COLORS = {
  Critical: { bg: '#ffebee', text: '#c62828', border: '#ef5350', dot: '#d32f2f' },
  High: { bg: '#fff3e0', text: '#e65100', border: '#ff9800', dot: '#f57c00' },
  Medium: { bg: '#fff8e1', text: '#f9a825', border: '#ffd54f', dot: '#fbc02d' },
  Low: { bg: '#e3f2fd', text: '#1565c0', border: '#64b5f6', dot: '#1976d2' },
  Info: { bg: '#f3e5f5', text: '#7b1fa2', border: '#ce93d8', dot: '#9c27b0' },
};

function SeverityBadge({ severity, size = 'sm' }) {
  const colors = SEVERITY_COLORS[severity] || SEVERITY_COLORS.Info;
  const isLg = size === 'lg';
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: '4px',
      padding: isLg ? '6px 14px' : '3px 10px',
      borderRadius: '20px',
      fontSize: isLg ? '13px' : '11px',
      fontWeight: '700',
      background: colors.bg,
      color: colors.text,
      border: `1px solid ${colors.border}`,
      textTransform: 'uppercase',
      letterSpacing: '0.3px',
    }}>
      <span style={{
        width: isLg ? '8px' : '6px',
        height: isLg ? '8px' : '6px',
        borderRadius: '50%',
        background: colors.dot,
        display: 'inline-block',
      }} />
      {severity}
    </span>
  );
}

function CVSSMeter({ score }) {
  if (score == null) return null;
  const color = score >= 9 ? '#d32f2f' : score >= 7 ? '#f57c00' : score >= 5 ? '#fbc02d' : '#1976d2';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
      <div style={{
        width: '40px',
        height: '6px',
        background: '#e0e0e0',
        borderRadius: '3px',
        overflow: 'hidden',
      }}>
        <div style={{
          width: `${(score / 10) * 100}%`,
          height: '100%',
          background: color,
          borderRadius: '3px',
          transition: 'width 0.5s ease',
        }} />
      </div>
      <span style={{ fontSize: '11px', fontWeight: '700', color }}>CVSS {score}</span>
    </div>
  );
}

function VulnerabilityCard({ vuln, onAnalyze, isAnalyzing }) {
  const [expanded, setExpanded] = useState(false);
  const colors = SEVERITY_COLORS[vuln.severity] || SEVERITY_COLORS.Info;

  return (
    <div style={{
      border: `1px solid ${colors.border}20`,
      borderRadius: '10px',
      background: 'var(--bg-primary)',
      marginBottom: '10px',
      overflow: 'hidden',
      boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
      transition: 'box-shadow 0.2s',
    }}>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          padding: '14px 16px',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          borderLeft: `4px solid ${colors.dot}`,
          userSelect: 'none',
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px', flexWrap: 'wrap' }}>
            <SeverityBadge severity={vuln.severity} />
            <span style={{ fontSize: '14px', fontWeight: '600', color: 'var(--text-primary)' }}>
              {vuln.type}
            </span>
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: '1.4' }}>
            {vuln.description}
          </div>
          {vuln.location && (
            <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '4px', fontFamily: 'monospace' }}>
              {vuln.location}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px', flexShrink: 0 }}>
          {vuln.cvss != null && (
            <CVSSMeter score={vuln.cvss} />
          )}
          <span style={{ fontSize: '10px', color: 'var(--text-tertiary)' }}>
            {expanded ? '▲ Hide' : '▼ Details'}
          </span>
        </div>
      </div>

      {expanded && (
        <div style={{
          padding: '0 16px 16px',
          borderTop: '1px solid var(--border-primary)',
          marginTop: '0',
        }}>
          <div style={{ padding: '12px 0', display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {vuln.payload && (
              <div>
                <div style={{ fontSize: '11px', fontWeight: '600', color: 'var(--text-secondary)', marginBottom: '4px' }}>Payload</div>
                <code style={{
                  fontSize: '11px', background: 'var(--bg-tertiary)',
                  padding: '6px 10px', borderRadius: '6px', display: 'block',
                  wordBreak: 'break-all', color: 'var(--text-primary)',
                }}>
                  {vuln.payload}
                </code>
              </div>
            )}
            {vuln.evidence && vuln.evidence.length > 0 && (
              <div>
                <div style={{ fontSize: '11px', fontWeight: '600', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                  Evidence ({vuln.count || vuln.evidence.length} occurrences)
                </div>
                {vuln.evidence.map((ev, i) => (
                  <code key={i} style={{
                    fontSize: '11px', background: 'var(--bg-tertiary)',
                    padding: '4px 8px', borderRadius: '4px', display: 'block',
                    marginBottom: '4px', wordBreak: 'break-all', color: 'var(--text-primary)',
                  }}>
                    {ev}
                  </code>
                ))}
              </div>
            )}
            {vuln.recommendation && (
              <div style={{
                background: '#e8f5e9', borderRadius: '8px',
                padding: '10px 12px', fontSize: '12px', color: '#2e7d32',
                border: '1px solid #a5d6a7',
              }}>
                <strong>Fix:</strong> {vuln.recommendation}
              </div>
            )}
            <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
              <button
                onClick={(e) => { e.stopPropagation(); onAnalyze(vuln); }}
                disabled={isAnalyzing}
                style={{
                  padding: '6px 14px',
                  fontSize: '12px',
                  fontWeight: '600',
                  border: '1px solid var(--brand)',
                  borderRadius: '6px',
                  background: 'transparent',
                  color: 'var(--brand)',
                  cursor: isAnalyzing ? 'not-allowed' : 'pointer',
                  opacity: isAnalyzing ? 0.6 : 1,
                }}
              >
                {isAnalyzing ? 'Analyzing...' : 'AI Analysis'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function SecurityTesting() {
  const [activeTab, setActiveTab] = useState('scan');
  const [target, setTarget] = useState('http://localhost:3000');
  const [scanType, setScanType] = useState('deep');
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState(null);

  const [vulnerabilities, setVulnerabilities] = useState([]);
  const [scanProgress, setScanProgress] = useState([]);
  const [scanSummary, setScanSummary] = useState(null);
  const [targetInfo, setTargetInfo] = useState(null);
  const [checkResults, setCheckResults] = useState({});
  const [isScanning, setIsScanning] = useState(false);
  const [scanId, setScanId] = useState(null);

  const [aiAnalysis, setAiAnalysis] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiHistory, setAiHistory] = useState([]);
  const [aiInput, setAiInput] = useState('');
  const [selectedVuln, setSelectedVuln] = useState(null);
  const [rightPanelTab, setRightPanelTab] = useState('analysis');

  const [authTarget, setAuthTarget] = useState('http://localhost:3000/login');
  const [authUsername, setAuthUsername] = useState('admin');
  const [codePath, setCodePath] = useState('./src');

  // Deep Attack States
  const [isAttacking, setIsAttacking] = useState(false);
  const [attackProgress, setAttackProgress] = useState([]);
  const [confirmedVulns, setConfirmedVulns] = useState([]);
  const [fakeVulns, setFakeVulns] = useState([]);
  const [attackEvidence, setAttackEvidence] = useState(null);
  const [aiGuidance, setAiGuidance] = useState(null);
  const [attackSummary, setAttackSummary] = useState(null);
  const [professionalReport, setProfessionalReport] = useState(null);
  const [reportFormat, setReportFormat] = useState('json');
  const [showReportModal, setShowReportModal] = useState(false);
  const [notifyEmail, setNotifyEmail] = useState('');
  const [notifyPhone, setNotifyPhone] = useState('');
  const [notifyResult, setNotifyResult] = useState(null);

  const abortRef = useRef(null);
  const resultsRef = useRef(null);
  const attackResultsRef = useRef(null);

  useEffect(() => {
    if (vulnerabilities.length > 0 && resultsRef.current) {
      resultsRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [vulnerabilities.length]);

  const handleSecurityScan = useCallback(async () => {
    setIsScanning(true);
    setVulnerabilities([]);
    setScanProgress([]);
    setScanSummary(null);
    setTargetInfo(null);
    setCheckResults({});
    setAiAnalysis(null);
    setMsg(null);
    setScanId(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch('/api/security/scan/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target, scanType, modules: ['sqli', 'xss', 'csrf', 'auth_bypass', 'idor'] }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let eventType = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));

              switch (eventType) {
                case 'scan_start':
                  setScanId(data.scanId);
                  setScanProgress(p => [...p, { message: 'Scan initialized...', type: 'info' }]);
                  break;

                case 'progress':
                  setScanProgress(p => [...p, { message: data.message, type: 'progress' }]);
                  setCheckResults(c => ({ ...c, [data.phase]: 'running' }));
                  break;

                case 'check_pass':
                  setCheckResults(c => ({ ...c, [data.check.toLowerCase().replace(/\s+/g, '_')]: 'pass' }));
                  setScanProgress(p => [...p, { message: `✓ ${data.check} passed`, type: 'pass' }]);
                  break;

                case 'check_error':
                  setCheckResults(c => ({ ...c, [data.check.toLowerCase().replace(/\s+/g, '_')]: 'error' }));
                  setScanProgress(p => [...p, { message: `✗ ${data.check} error: ${data.error}`, type: 'error' }]);
                  break;

                case 'vulnerability':
                  setVulnerabilities(v => [...v, data.vulnerability]);
                  setCheckResults(c => ({ ...c, [data.vulnerability.type.toLowerCase().replace(/\s+/g, '_')]: 'vuln' }));
                  setScanSummary(data.summary);
                  setScanProgress(p => [...p, {
                    message: `⚠ Found ${data.vulnerability.severity}: ${data.vulnerability.type}`,
                    type: 'vuln',
                    severity: data.vulnerability.severity,
                  }]);
                  break;

                case 'target_info':
                  setTargetInfo(data.targetInfo);
                  break;

                case 'scan_complete':
                  setScanSummary(data.summary);
                  setVulnerabilities(data.vulnerabilities);
                  setScanProgress(p => [...p, { message: `Scan complete! Found ${data.summary.total} issues.`, type: 'complete' }]);
                  setIsScanning(false);

                  setResults({
                    timestamp: data.timestamp,
                    target,
                    scanType,
                    vulnerabilities: data.vulnerabilities,
                    summary: data.summary,
                    targetInfo: data.targetInfo,
                    elapsed: data.elapsed,
                    status: 'completed',
                  });

                  if (data.aiAnalysis) {
                    setAiAnalysis(data.aiAnalysis);
                  } else if (data.vulnerabilities.length > 0) {
                    handleFullAnalysis(data.vulnerabilities, target);
                  }
                  break;

                case 'ai_analysis':
                  setAiAnalysis(data.analysis);
                  setScanProgress(p => [...p, { message: 'AI deep analysis completed', type: 'pass' }]);
                  break;

                case 'scan_error':
                  setScanProgress(p => [...p, { message: `Scan error: ${data.message}`, type: 'error' }]);
                  setIsScanning(false);
                  setMsg({ type: 'error', text: data.message });
                  break;
              }
            } catch (e) {
              // skip parse errors
            }
          }
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        setScanProgress(p => [...p, { message: 'Scan cancelled by user', type: 'info' }]);
      } else {
        setMsg({ type: 'error', text: 'Scan failed: ' + err.message });
      }
    } finally {
      setIsScanning(false);
      abortRef.current = null;
    }
  }, [target, scanType]);

  const handleScanStop = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  // Professional Deep Attack Handler
  const handleDeepAttack = useCallback(async () => {
    setIsAttacking(true);
    setAttackProgress([]);
    setConfirmedVulns([]);
    setFakeVulns([]);
    setAttackEvidence(null);
    setAiGuidance(null);
    setAttackSummary(null);
    setProfessionalReport(null);
    setNotifyResult(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch('/api/security/attack/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target, scanType }),
        signal: controller.signal,
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let eventType = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) eventType = line.slice(7).trim();
          else if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));

              switch (eventType) {
                case 'attack_start':
                  setAttackProgress(p => [...p, { message: '🔬 Professional Pentest Started', type: 'info' }]);
                  break;

                case 'progress':
                  setAttackProgress(p => [...p, { message: data.message, type: 'progress' }]);
                  break;

                case 'vulnerability_confirmed':
                  setConfirmedVulns(v => [...v, data.vulnerability]);
                  setAttackProgress(p => [...p, {
                    message: `✅ CONFIRMED: ${data.vulnerability.severity} - ${data.vulnerability.type}`,
                    type: 'confirmed',
                    severity: data.vulnerability.severity,
                  }]);
                  break;

                case 'attack_fake':
                  setFakeVulns(v => [...v, data.vulnerability]);
                  setAttackProgress(p => [...p, {
                    message: `❌ FAKE: ${data.vulnerability.type} - ${data.vulnerability.description}`,
                    type: 'fake',
                  }]);
                  break;

                case 'evidence':
                  setAttackEvidence(data.data);
                  break;

                case 'ai_guidance':
                  setAiGuidance(data.guidance);
                  setAttackProgress(p => [...p, { message: '🤖 AI Exploitation Guidance Received', type: 'pass' }]);
                  break;

                case 'attack_complete':
                  setAttackSummary(data.summary);
                  setProfessionalReport(data.report);
                  setIsAttacking(false);
                  setAttackProgress(p => [...p, {
                    message: `🏁 Attack complete! ${data.summary.total} confirmed, ${data.summary.fake} fake`,
                    type: 'complete',
                  }]);
                  break;

                case 'attack_error':
                  setAttackProgress(p => [...p, { message: `✗ Error: ${data.message}`, type: 'error' }]);
                  setIsAttacking(false);
                  break;
              }
            } catch {}
          }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        setMsg({ type: 'error', text: 'Deep attack failed: ' + err.message });
      }
    } finally {
      setIsAttacking(false);
      abortRef.current = null;
    }
  }, [target, scanType]);

  const handleFullAnalysis = async (vulns, tgt) => {
    try {
      const response = await fetch('/api/security/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vulnerabilities: vulns, target: tgt }),
      });
      const data = await response.json();
      if (data.success) {
        setAiAnalysis(data.analysis);
      }
    } catch (err) {
      // silent
    }
  };

  const handleAnalyzeVuln = async (vuln) => {
    setAiLoading(true);
    setSelectedVuln(vuln);
    setRightPanelTab('analysis');

    try {
      const response = await fetch('/api/security/ai-advice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vulnerability: vuln, target }),
      });
      const data = await response.json();
      if (data.success) {
        setAiAnalysis(prev => ({
          ...prev,
          _currentAnalysis: data.analysis,
          _analyzingVuln: vuln,
        }));
      }
    } catch (err) {
      setMsg({ type: 'error', text: 'AI analysis failed: ' + err.message });
    } finally {
      setAiLoading(false);
    }
  };

  const handleAskAI = async () => {
    if (!aiInput.trim() || !vulnerabilities.length) return;

    const question = aiInput.trim();
    setAiHistory(prev => [...prev, { role: 'user', content: question }]);
    setAiInput('');

    setAiHistory(prev => [...prev, { role: 'assistant', content: 'Analyzing...', loading: true }]);

    try {
      const response = await fetch('/api/security/ai-advice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vulnerability: selectedVuln || vulnerabilities[0],
          target,
          question,
        }),
      });
      const data = await response.json();
      if (data.success) {
        setAiHistory(prev => {
          const updated = [...prev];
          updated[updated.length - 1] = { role: 'assistant', content: data.analysis, loading: false };
          return updated;
        });
      }
    } catch (err) {
      setAiHistory(prev => {
        const updated = [...prev];
        updated[updated.length - 1] = { role: 'assistant', content: 'Error: ' + err.message, loading: false };
        return updated;
      });
    }
  };

  const generateReport = () => {
    if (!results && !vulnerabilities.length) return;

    const vulns = results?.vulnerabilities || vulnerabilities;
    const tgt = results?.target || target;
    const summary = results?.summary || scanSummary;
    const tInfo = results?.targetInfo || targetInfo;

    let report = `# Security Scan Report\n\n`;
    report += `**Target:** ${tgt}\n`;
    report += `**Date:** ${new Date().toISOString()}\n`;
    report += `**Scan Type:** ${results?.scanType || scanType}\n\n`;

    report += `## Summary\n\n`;
    report += `| Severity | Count |\n|---|---|\n`;
    if (summary) {
      report += `| Critical | ${summary.critical} |\n`;
      report += `| High | ${summary.high} |\n`;
      report += `| Medium | ${summary.medium} |\n`;
      report += `| Low | ${summary.low} |\n`;
      report += `| **Total** | **${summary.total}** |\n`;
    }

    report += `\n## Target Information\n\n`;
    if (tInfo) {
      report += `- **Status:** ${tInfo.status}\n`;
      report += `- **Server:** ${tInfo.server}\n`;
      report += `- **Content Type:** ${tInfo.contentType}\n`;
    }

    report += `\n## Vulnerabilities Found\n\n`;
    vulns.forEach((v, i) => {
      report += `### ${i + 1}. ${v.type} (${v.severity})\n\n`;
      report += `- **Description:** ${v.description}\n`;
      if (v.location) report += `- **Location:** ${v.location}\n`;
      if (v.cvss) report += `- **CVSS Score:** ${v.cvss}\n`;
      if (v.payload) report += `- **Payload:** \`${v.payload}\`\n`;
      if (v.evidence) {
        report += `- **Evidence:**\n`;
        v.evidence.forEach(ev => { report += `  - \`${ev}\`\n`; });
      }
      report += `- **Recommendation:** ${v.recommendation}\n\n`;
    });

    if (aiAnalysis) {
      report += `\n## AI Security Analysis\n\n`;
      report += `**Security Score:** ${aiAnalysis.securityScore}/100\n\n`;
      report += `### Attack Vectors\n\n`;
      aiAnalysis.attackVectors?.forEach(av => {
        report += `- **${av.type}:** ${av.howItWorks}\n`;
        report += `  - Impact: ${av.impact}\n`;
        report += `  - Priority: ${av.priority}\n\n`;
      });

      report += `### Recommendations\n\n`;
      aiAnalysis.recommendations?.forEach(rec => {
        report += `- ${rec}\n`;
      });
    }

    report += `\n---\n*Report generated by Wanar AI Security Scanner v1.0.0*\n`;

    const blob = new Blob([report], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `security-report-${Date.now()}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Professional Report & Notification
  const handleProfessionalReport = async (format) => {
    if (professionalReport) {
      if (format === 'html') {
        const response = await fetch('/api/security/report', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            vulnerabilities: confirmedVulns,
            fake: fakeVulns,
            target,
            format: 'html',
          }),
        });
        const html = await response.text();
        const w = window.open('', '_blank');
        w.document.write(html);
        w.document.close();
      } else if (format === 'text') {
        const blob = new Blob([professionalReport.rawReport], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `security-report-${Date.now()}.txt`;
        a.click();
        URL.revokeObjectURL(url);
      } else {
        const blob = new Blob([JSON.stringify(professionalReport, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `security-report-${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
      }
    }
  };

  const handleSendNotification = async (type) => {
    if (type === 'email' && !notifyEmail) {
      setNotifyResult({ success: false, message: 'Please enter an email address' });
      return;
    }
    if (type === 'whatsapp' && !notifyPhone) {
      setNotifyResult({ success: false, message: 'Please enter a phone number' });
      return;
    }

    try {
      const response = await fetch('/api/security/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target,
          vulnerabilities: confirmedVulns,
          fake: fakeVulns,
          type,
          contact: type === 'email' ? notifyEmail : notifyPhone,
        }),
      });
      const data = await response.json();
      if (data.success) {
        setNotifyResult({ success: true, message: `Notification ready via ${type}` });
        if (data.preview) {
          if (type === 'whatsapp') {
            setNotifyResult({ success: true, message: data.preview.message, preview: true });
          }
        }
      } else {
        setNotifyResult({ success: false, message: data.error || 'Notification failed' });
      }
    } catch (err) {
      setNotifyResult({ success: false, message: 'Error: ' + err.message });
    }
  };

  const handleAuthTest = async () => {
    setLoading(true);
    setMsg(null);
    setResults(null);

    try {
      const response = await fetch('/api/security/auth-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: authTarget,
          username: authUsername,
          testTypes: ['bruteforce', 'bypass', 'session_hijack'],
        }),
      });
      const data = await response.json();
      if (data.success) {
        setResults(data.results);
        setMsg({ type: 'success', text: 'Auth test completed successfully!' });
      } else {
        setMsg({ type: 'error', text: data.error || 'Auth test failed' });
      }
    } catch (err) {
      setMsg({ type: 'error', text: 'Failed to connect to server: ' + err.message });
    } finally {
      setLoading(false);
    }
  };

  const handleCodeAudit = async () => {
    setLoading(true);
    setMsg(null);
    setResults(null);

    try {
      const response = await fetch('/api/security/code-audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: codePath, checks: ['sql_injection', 'xss', 'auth_bypass', 'hardcoded_secrets', 'insecure_crypto'] }),
      });
      const data = await response.json();
      if (data.success) {
        setResults(data.results);
        setMsg({ type: 'success', text: 'Code audit completed successfully!' });
      } else {
        setMsg({ type: 'error', text: data.error || 'Code audit failed' });
      }
    } catch (err) {
      setMsg({ type: 'error', text: 'Failed to connect to server: ' + err.message });
    } finally {
      setLoading(false);
    }
  };

  const handleDependencyScan = async () => {
    setLoading(true);
    setMsg(null);
    setResults(null);

    try {
      const response = await fetch('/api/security/dependency-scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await response.json();
      if (data.success) {
        setResults(data.results);
        setMsg({ type: 'success', text: 'Dependency scan completed successfully!' });
      } else {
        setMsg({ type: 'error', text: data.error || 'Dependency scan failed' });
      }
    } catch (err) {
      setMsg({ type: 'error', text: 'Failed to connect to server: ' + err.message });
    } finally {
      setLoading(false);
    }
  };

  return (
    <DashboardLayout>
      <div style={{ display: 'flex', height: 'calc(100vh - 60px)', overflow: 'hidden' }}>
        {/* Main Content */}
        <div style={{ flex: 1, overflow: 'auto', padding: '24px', minWidth: 0 }}>
          <div style={{ maxWidth: '800px', margin: '0 auto' }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
              <span style={{ fontSize: '24px' }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" fill="#d32f2f" stroke="#d32f2f" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </span>
              <div style={{ flex: 1 }}>
                <h1 style={{ fontSize: '20px', fontWeight: '600', color: 'var(--text-primary)', margin: 0 }}>Security Testing</h1>
                <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: '2px 0 0' }}>
                  {isScanning ? 'Scanning in progress...' : (vulnerabilities.length > 0 ? `${vulnerabilities.length} vulnerabilities found` : 'Real-time security vulnerability scanner')}
                </p>
              </div>
              {(results || vulnerabilities.length > 0) && (
                <button
                  onClick={generateReport}
                  style={{
                    padding: '8px 16px',
                    fontSize: '12px',
                    fontWeight: '600',
                    border: '1px solid var(--brand)',
                    borderRadius: '8px',
                    background: 'var(--brand)',
                    color: '#fff',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                    <polyline points="14 2 14 8 20 8"/>
                    <line x1="16" y1="13" x2="8" y2="13"/>
                    <line x1="16" y1="17" x2="8" y2="17"/>
                    <polyline points="10 9 9 9 8 9"/>
                  </svg>
                  Export Report
                </button>
              )}
            </div>

            {/* Alert */}
            {msg && (
              <div style={{
                padding: '10px 14px', borderRadius: '8px', marginBottom: '16px',
                fontSize: '13px', fontWeight: '500',
                background: msg.type === 'success' ? 'var(--success-bg)' : 'var(--error-bg)',
                color: msg.type === 'success' ? 'var(--success)' : 'var(--error)',
                border: `1px solid ${msg.type === 'success' ? 'var(--success)' : 'var(--error)'}`,
              }}>
                {msg.text}
              </div>
            )}

            {/* Tabs */}
            <div style={{
              display: 'flex', gap: '4px', marginBottom: '20px',
              borderBottom: '1px solid var(--border-primary)',
              overflowX: 'auto',
            }}>
              {[
                { id: 'scan', label: 'Security Scan', icon: '🔍' },
                { id: 'auth', label: 'Auth Testing', icon: '🔐' },
                { id: 'code', label: 'Code Audit', icon: '📝' },
                { id: 'deps', label: 'Dependencies', icon: '📦' },
              ].map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  style={{
                    padding: '10px 16px', border: 'none', background: 'transparent',
                    color: activeTab === tab.id ? 'var(--brand)' : 'var(--text-secondary)',
                    borderBottom: activeTab === tab.id ? '2px solid var(--brand)' : '2px solid transparent',
                    cursor: 'pointer', fontSize: '14px',
                    fontWeight: activeTab === tab.id ? '600' : '500',
                    whiteSpace: 'nowrap', transition: 'all 0.2s',
                  }}
                >
                  {tab.icon} {tab.label}
                </button>
              ))}
            </div>

            {/* Tab Content */}
            {activeTab === 'scan' && (
              <div style={{
                background: 'var(--bg-secondary)',
                padding: '24px',
                borderRadius: '12px',
                border: '1px solid var(--border-primary)',
              }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '16px' }}>
                  <div style={{ flex: 1 }}>
                    <h2 style={{ fontSize: '18px', fontWeight: '600', color: 'var(--text-primary)', marginTop: 0, marginBottom: '4px' }}>
                      Security Vulnerability Scan
                    </h2>
                    <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '20px' }}>
                      Real-time security scanning with AI-powered analysis and remediation guidance.
                    </p>

                    <div style={{ marginBottom: '14px' }}>
                      <label style={labelStyle}>Target URL</label>
                      <input
                        type="text"
                        value={target}
                        onChange={(e) => setTarget(e.target.value)}
                        placeholder="http://localhost:3000"
                        style={inputStyle}
                        disabled={isScanning}
                      />
                    </div>

                    <div style={{ marginBottom: '20px' }}>
                      <label style={labelStyle}>Scan Type</label>
                      <select
                        value={scanType}
                        onChange={(e) => setScanType(e.target.value)}
                        style={selectStyle}
                        disabled={isScanning}
                      >
                        <option value="quick">Quick Scan (Basic checks)</option>
                        <option value="full">Full Scan (Standard checks)</option>
                        <option value="deep">Deep Scan (Aggressive - all checks)</option>
                      </select>
                    </div>

                    <div style={{ display: 'flex', gap: '10px' }}>
                      {!isScanning ? (
                        <button
                          onClick={handleSecurityScan}
                          style={{
                            padding: '11px 24px',
                            background: 'var(--brand-gradient)',
                            color: 'white',
                            border: 'none',
                            borderRadius: '8px',
                            fontSize: '14px',
                            fontWeight: '600',
                            cursor: 'pointer',
                            boxShadow: '0 2px 8px rgba(99,102,241,0.3)',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                          }}
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <polygon points="5 3 19 12 5 21 5 3"/>
                          </svg>
                          Start Security Scan
                        </button>
                      ) : (
                        <button
                          onClick={handleScanStop}
                          style={{
                            padding: '11px 24px',
                            background: '#d32f2f',
                            color: 'white',
                            border: 'none',
                            borderRadius: '8px',
                            fontSize: '14px',
                            fontWeight: '600',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                          }}
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                            <rect x="6" y="6" width="12" height="12" rx="2"/>
                          </svg>
                          Stop Scan
                        </button>
                      )}
                    </div>

                    {/* Professional Deep Attack Button */}
                    <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid var(--border-primary)' }}>
                      <div style={{ fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', marginBottom: '8px' }}>
                        🔬 Professional Penetration Testing
                      </div>
                      <p style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginBottom: '10px', margin: '0 0 10px' }}>
                        Active attack dengan SQL injection, XSS, directory brute force, auth cracking, DNS enumeration, dan AI-powered exploitation guidance. Setiap temuan dikonfirmasi dengan bukti atau ditandai FAKE.
                      </p>
                      <div style={{ display: 'flex', gap: '10px' }}>
                        {!isAttacking ? (
                          <button
                            onClick={handleDeepAttack}
                            disabled={isScanning}
                            style={{
                              padding: '11px 24px',
                              background: isScanning ? 'var(--bg-tertiary)' : 'linear-gradient(135deg, #d32f2f, #b71c1c)',
                              color: isScanning ? 'var(--text-secondary)' : 'white',
                              border: 'none',
                              borderRadius: '8px',
                              fontSize: '14px',
                              fontWeight: '600',
                              cursor: isScanning ? 'not-allowed' : 'pointer',
                              boxShadow: isScanning ? 'none' : '0 2px 8px rgba(211,47,47,0.3)',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '8px',
                            }}
                          >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                            </svg>
                            Start Professional Deep Attack
                          </button>
                        ) : (
                          <button
                            onClick={() => { if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; setIsAttacking(false); } }}
                            style={{
                              padding: '11px 24px',
                              background: '#d32f2f',
                              color: 'white',
                              border: 'none',
                              borderRadius: '8px',
                              fontSize: '14px',
                              fontWeight: '600',
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '8px',
                            }}
                          >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                              <rect x="6" y="6" width="12" height="12" rx="2"/>
                            </svg>
                            Stop Attack
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Scan Progress */}
                {isScanning && (
                  <div style={{ marginTop: '20px' }}>
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px',
                    }}>
                      <div style={{
                        width: '14px', height: '14px',
                        border: '2px solid var(--brand)',
                        borderTop: '2px solid transparent',
                        borderRadius: '50%',
                        animation: 'spin 0.8s linear infinite',
                      }} />
                      <span style={{ fontSize: '13px', fontWeight: '600', color: 'var(--brand)' }}>
                        Scanning...
                      </span>
                    </div>
                    <div style={{
                      background: 'var(--bg-tertiary)',
                      borderRadius: '8px',
                      padding: '12px',
                      maxHeight: '200px',
                      overflow: 'auto',
                    }}>
                      {scanProgress.map((p, i) => (
                        <div key={i} style={{
                          display: 'flex', alignItems: 'center', gap: '6px',
                          padding: '2px 0', fontSize: '12px',
                          color: p.type === 'vuln' ? (p.severity === 'Critical' ? '#d32f2f' : p.severity === 'High' ? '#e65100' : '#f9a825') :
                            p.type === 'error' ? '#d32f2f' :
                            p.type === 'pass' ? '#2e7d32' :
                            p.type === 'complete' ? 'var(--brand)' : 'var(--text-secondary)',
                          fontWeight: p.type === 'vuln' || p.type === 'complete' ? '600' : '400',
                        }}>
                          <span>{p.message}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Target Info */}
                {targetInfo && !isScanning && !isAttacking && (
                  <div style={{
                    marginTop: '16px', padding: '12px 16px',
                    background: 'var(--bg-tertiary)', borderRadius: '8px',
                    fontSize: '12px', color: 'var(--text-secondary)',
                  }}>
                    <strong>Target Info:</strong> Status {targetInfo.status} | Server: {targetInfo.server} | {targetInfo.contentType}
                  </div>
                )}
              </div>
            )}

            {/* Deep Attack Progress */}
            {isAttacking && (
              <div style={{ marginTop: '20px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                  <div style={{
                    width: '14px', height: '14px',
                    border: '2px solid #d32f2f',
                    borderTop: '2px solid transparent',
                    borderRadius: '50%',
                    animation: 'spin 0.8s linear infinite',
                  }} />
                  <span style={{ fontSize: '13px', fontWeight: '600', color: '#d32f2f' }}>
                    Professional Pentest in Progress...
                  </span>
                </div>
                <div style={{
                  background: 'var(--bg-tertiary)',
                  borderRadius: '8px',
                  padding: '12px',
                  maxHeight: '250px',
                  overflow: 'auto',
                }}>
                  {attackProgress.map((p, i) => (
                    <div key={i} style={{
                      display: 'flex', alignItems: 'center', gap: '6px',
                      padding: '2px 0', fontSize: '12px',
                      color: p.type === 'confirmed' ? (p.severity === 'Critical' ? '#d32f2f' : p.severity === 'High' ? '#e65100' : '#2e7d32') :
                        p.type === 'fake' ? '#999' :
                        p.type === 'error' ? '#d32f2f' :
                        p.type === 'pass' ? '#2e7d32' :
                        p.type === 'complete' ? '#1a237e' : 'var(--text-secondary)',
                      fontWeight: p.type === 'confirmed' || p.type === 'complete' ? '600' : '400',
                    }}>
                      <span>{p.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Confirmed vs Fake Summary */}
            {attackSummary && !isAttacking && (
              <div style={{ marginTop: '24px' }} ref={attackResultsRef}>
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  marginBottom: '16px',
                }}>
                  <h3 style={{ fontSize: '18px', fontWeight: '700', color: 'var(--text-primary)', margin: 0 }}>
                    🔬 Professional Pentest Results
                  </h3>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <span style={{ fontSize: '13px', fontWeight: '700', color: '#d32f2f' }}>
                      {attackSummary.critical} Critical
                    </span>
                    <span style={{ fontSize: '13px', fontWeight: '700', color: '#e65100' }}>
                      {attackSummary.high} High
                    </span>
                    <span style={{ fontSize: '13px', fontWeight: '700', color: '#999', textDecoration: 'line-through' }}>
                      {attackSummary.fake} Fake
                    </span>
                  </div>
                </div>

                {/* Security Score */}
                {professionalReport?.securityScore && (
                  <div style={{
                    padding: '16px', borderRadius: '10px', marginBottom: '16px',
                    background: professionalReport.securityScore.overall >= 80 ? '#e8f5e9' : professionalReport.securityScore.overall >= 50 ? '#fff8e1' : '#ffebee',
                    border: `1px solid ${professionalReport.securityScore.overall >= 80 ? '#a5d6a7' : professionalReport.securityScore.overall >= 50 ? '#ffe082' : '#ef9a9a'}`,
                    display: 'flex', alignItems: 'center', gap: '16px',
                  }}>
                    <div style={{
                      width: '60px', height: '60px', borderRadius: '50%',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: '22px', fontWeight: '800',
                      color: professionalReport.securityScore.overall >= 80 ? '#2e7d32' : professionalReport.securityScore.overall >= 50 ? '#e65100' : '#c62828',
                      background: professionalReport.securityScore.overall >= 80 ? '#c8e6c9' : professionalReport.securityScore.overall >= 50 ? '#ffecb3' : '#ffcdd2',
                      flexShrink: 0,
                    }}>
                      {professionalReport.securityScore.overall}
                    </div>
                    <div>
                      <div style={{ fontSize: '14px', fontWeight: '600', color: 'var(--text-primary)' }}>
                        Security Score: Grade {professionalReport.securityScore.grade}
                      </div>
                      <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                        {professionalReport.executiveSummary?.overview}
                      </div>
                    </div>
                  </div>
                )}

                {/* Confirmed Vulnerabilities */}
                <h4 style={{ fontSize: '14px', fontWeight: '600', color: '#2e7d32', margin: '0 0 10px' }}>
                  ✅ Confirmed Vulnerabilities ({confirmedVulns.length})
                </h4>
                {confirmedVulns.map((vuln, i) => (
                  <div key={i} style={{
                    border: '1px solid #a5d6a7',
                    borderRadius: '8px',
                    padding: '12px',
                    marginBottom: '8px',
                    background: '#f1f8e9',
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                      <span style={{ fontWeight: '600', fontSize: '13px', color: '#2e7d32' }}>{vuln.type}</span>
                      <span style={{
                        padding: '2px 8px', borderRadius: '10px', fontSize: '10px', fontWeight: '700',
                        background: vuln.severity === 'Critical' ? '#ffebee' : vuln.severity === 'High' ? '#fff3e0' : '#e8f5e9',
                        color: vuln.severity === 'Critical' ? '#d32f2f' : vuln.severity === 'High' ? '#e65100' : '#2e7d32',
                        textTransform: 'uppercase',
                      }}>
                        {vuln.severity}
                      </span>
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '6px' }}>
                      {vuln.description}
                    </div>
                    {vuln.proof && (
                      <div style={{
                        fontSize: '11px', fontFamily: 'monospace',
                        background: '#fff', padding: '6px 8px',
                        borderRadius: '4px', border: '1px solid #c8e6c9',
                        marginBottom: '4px', color: '#1b5e20',
                      }}>
                        🏆 Proof: {vuln.proof}
                      </div>
                    )}
                    {vuln.evidence && vuln.evidence.length > 0 && (
                      <details style={{ fontSize: '11px', marginTop: '4px' }}>
                        <summary style={{ cursor: 'pointer', color: 'var(--brand)', fontWeight: '600' }}>
                          Evidence ({vuln.evidence.length} items)
                        </summary>
                        <ul style={{ margin: '6px 0 0', paddingLeft: '16px' }}>
                          {vuln.evidence.map((ev, j) => (
                            <li key={j} style={{ marginBottom: '2px', wordBreak: 'break-all', color: 'var(--text-secondary)' }}>{ev}</li>
                          ))}
                        </ul>
                      </details>
                    )}
                    {vuln.cvss && (
                      <div style={{ fontSize: '11px', color: '#666', marginTop: '2px' }}>
                        CVSS: {vuln.cvss} | CWE: {vuln.cwe || 'N/A'}
                      </div>
                    )}
                  </div>
                ))}

                {/* Fake Vulnerabilities */}
                {fakeVulns.length > 0 && (
                  <div style={{ marginTop: '16px' }}>
                    <h4 style={{ fontSize: '14px', fontWeight: '600', color: '#999', margin: '0 0 8px' }}>
                      ❌ Fake / Unconfirmed ({fakeVulns.length})
                    </h4>
                    {fakeVulns.map((vuln, i) => (
                      <div key={i} style={{
                        border: '1px dashed #ccc',
                        borderRadius: '6px',
                        padding: '8px 12px',
                        marginBottom: '6px',
                        background: '#fafafa',
                        opacity: 0.7,
                      }}>
                        <div style={{ fontSize: '12px', color: '#999', fontStyle: 'italic' }}>
                          {vuln.description}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* AI Exploitation Guidance */}
                {aiGuidance && (
                  <div style={{ marginTop: '16px' }}>
                    <h4 style={{ fontSize: '14px', fontWeight: '600', color: '#1a237e', margin: '0 0 10px' }}>
                      🤖 AI Exploitation Guidance (NVIDIA DeepSeek)
                    </h4>
                    {aiGuidance.exploitationGuide?.map((guide, i) => (
                      <div key={i} style={{
                        background: '#e8eaf6',
                        border: '1px solid #c5cae9',
                        borderRadius: '8px',
                        padding: '12px',
                        marginBottom: '10px',
                      }}>
                        <div style={{ fontWeight: '600', fontSize: '13px', color: '#283593', marginBottom: '6px' }}>
                          {guide.vulnerabilityType}
                        </div>
                        {guide.attackPath?.map((step, si) => (
                          <div key={si} style={{ fontSize: '12px', color: '#444', marginBottom: '3px', paddingLeft: '12px' }}>
                            {si + 1}. {step}
                          </div>
                        ))}
                        {guide.exploitPoC && (
                          <div style={{
                            marginTop: '6px', padding: '8px', background: '#1a1a2e',
                            color: '#00ff00', borderRadius: '4px', fontSize: '11px',
                            fontFamily: 'monospace', whiteSpace: 'pre-wrap', overflowX: 'auto',
                          }}>
                            {guide.exploitPoC}
                          </div>
                        )}
                        {guide.remediation && (
                          <div style={{
                            marginTop: '6px', padding: '8px', background: '#e8f5e9',
                            borderRadius: '4px', fontSize: '11px', color: '#2e7d32',
                          }}>
                            <strong>Fix:</strong> {guide.remediation}
                          </div>
                        )}
                      </div>
                    ))}
                    {aiGuidance.summary && (
                      <div style={{ padding: '10px', background: '#fff8e1', borderRadius: '6px', fontSize: '12px', color: '#e65100' }}>
                        {aiGuidance.summary}
                      </div>
                    )}
                  </div>
                )}

                {/* Professional Report Actions */}
                {professionalReport && (
                  <div style={{ marginTop: '20px' }}>
                    <h4 style={{ fontSize: '14px', fontWeight: '600', color: 'var(--text-primary)', margin: '0 0 12px' }}>
                      📋 Professional Report (Google Project Zero & NASA CVD Standard)
                    </h4>

                    <div style={{ display: 'flex', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' }}>
                      <button onClick={() => handleProfessionalReport('html')} style={{
                        padding: '9px 18px', fontSize: '12px', fontWeight: '600',
                        border: 'none', borderRadius: '8px',
                        background: 'linear-gradient(135deg, #1a237e, #283593)',
                        color: '#fff', cursor: 'pointer',
                      }}>
                        🌐 View HTML Report
                      </button>
                      <button onClick={() => handleProfessionalReport('text')} style={{
                        padding: '9px 18px', fontSize: '12px', fontWeight: '600',
                        border: '1px solid var(--border-primary)', borderRadius: '8px',
                        background: 'var(--bg-tertiary)', color: 'var(--text-primary)', cursor: 'pointer',
                      }}>
                        📄 Download Text Report
                      </button>
                      <button onClick={() => handleProfessionalReport('json')} style={{
                        padding: '9px 18px', fontSize: '12px', fontWeight: '600',
                        border: '1px solid var(--border-primary)', borderRadius: '8px',
                        background: 'var(--bg-tertiary)', color: 'var(--text-primary)', cursor: 'pointer',
                      }}>
                        📊 Export JSON
                      </button>
                    </div>

                    {/* Email & WhatsApp Notification */}
                    <div style={{
                      padding: '16px', background: '#f3e5f5',
                      borderRadius: '8px', border: '1px solid #ce93d8',
                    }}>
                      <div style={{ fontSize: '13px', fontWeight: '600', color: '#6a1b9a', marginBottom: '10px' }}>
                        📧 Send Report Notification
                      </div>
                      <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                        <input
                          type="email"
                          placeholder="Email pemilik website..."
                          value={notifyEmail}
                          onChange={(e) => setNotifyEmail(e.target.value)}
                          style={{ ...inputStyle, fontSize: '12px' }}
                        />
                        <button onClick={() => handleSendNotification('email')} style={{
                          padding: '8px 14px', fontSize: '11px', fontWeight: '600',
                          border: 'none', borderRadius: '6px',
                          background: '#7b1fa2', color: '#fff', cursor: 'pointer', whiteSpace: 'nowrap',
                        }}>
                          Send Email
                        </button>
                      </div>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <input
                          type="tel"
                          placeholder="Nomor WhatsApp (62xxx)..."
                          value={notifyPhone}
                          onChange={(e) => setNotifyPhone(e.target.value)}
                          style={{ ...inputStyle, fontSize: '12px' }}
                        />
                        <button onClick={() => handleSendNotification('whatsapp')} style={{
                          padding: '8px 14px', fontSize: '11px', fontWeight: '600',
                          border: 'none', borderRadius: '6px',
                          background: '#25D366', color: '#fff', cursor: 'pointer', whiteSpace: 'nowrap',
                        }}>
                          Send WA
                        </button>
                      </div>
                      {notifyResult && (
                        <div style={{
                          marginTop: '8px', padding: '6px 10px', borderRadius: '6px',
                          fontSize: '11px', fontWeight: '500',
                          background: notifyResult.success ? '#e8f5e9' : '#ffebee',
                          color: notifyResult.success ? '#2e7d32' : '#c62828',
                          whiteSpace: 'pre-wrap',
                        }}>
                          {notifyResult.message}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Auth Testing Tab */}
            {activeTab === 'auth' && (
              <div style={{ background: 'var(--bg-secondary)', padding: '20px', borderRadius: '8px', border: '1px solid var(--border-primary)' }}>
                <h2 style={{ fontSize: '18px', fontWeight: '600', color: 'var(--text-primary)', marginTop: 0, marginBottom: '8px' }}>
                  Authentication & Authorization Testing
                </h2>
                <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '20px' }}>
                  Test authentication mechanisms for vulnerabilities including brute force, bypass attempts, and session hijacking.
                </p>
                <div style={{ marginBottom: '16px' }}>
                  <label style={labelStyle}>Auth Endpoint URL</label>
                  <input type="text" value={authTarget} onChange={(e) => setAuthTarget(e.target.value)} placeholder="http://localhost:3000/login" style={inputStyle} />
                </div>
                <div style={{ marginBottom: '20px' }}>
                  <label style={labelStyle}>Username</label>
                  <input type="text" value={authUsername} onChange={(e) => setAuthUsername(e.target.value)} placeholder="admin" style={inputStyle} />
                </div>
                <button onClick={handleAuthTest} disabled={loading} style={{
                  padding: '10px 20px', background: loading ? 'var(--bg-tertiary)' : 'var(--brand-gradient)',
                  color: loading ? 'var(--text-secondary)' : 'white', border: 'none', borderRadius: '8px',
                  fontSize: '14px', fontWeight: '600', cursor: loading ? 'not-allowed' : 'pointer',
                }}>
                  {loading ? 'Testing...' : 'Start Auth Test'}
                </button>
                {results && activeTab === 'auth' && (
                  <div style={{ marginTop: '20px' }}>
                    <h3 style={{ fontSize: '14px', fontWeight: '600', color: 'var(--text-primary)', marginBottom: '10px' }}>Auth Test Results</h3>
                    {results.tests?.map((test, i) => (
                      <div key={i} style={{
                        padding: '12px', borderRadius: '8px', marginBottom: '8px',
                        background: test.result === 'failed' ? '#ffebee' : test.result === 'warning' ? '#fff8e1' : '#e8f5e9',
                        border: `1px solid ${test.result === 'failed' ? '#ef9a9a' : test.result === 'warning' ? '#ffe082' : '#a5d6a7'}`,
                      }}>
                        <div style={{ fontWeight: '600', fontSize: '13px', marginBottom: '4px' }}>{test.name}</div>
                        <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{test.details?.join(', ')}</div>
                        {test.recommendation && (
                          <div style={{ fontSize: '12px', color: '#2e7d32', marginTop: '4px' }}>Fix: {test.recommendation}</div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Code Audit Tab */}
            {activeTab === 'code' && (
              <div style={{ background: 'var(--bg-secondary)', padding: '20px', borderRadius: '8px', border: '1px solid var(--border-primary)' }}>
                <h2 style={{ fontSize: '18px', fontWeight: '600', color: 'var(--text-primary)', marginTop: 0, marginBottom: '8px' }}>
                  Static Code Security Audit
                </h2>
                <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '20px' }}>
                  Analyze your source code for security vulnerabilities, hardcoded secrets, and insecure coding patterns.
                </p>
                <div style={{ marginBottom: '20px' }}>
                  <label style={labelStyle}>Code Path</label>
                  <input type="text" value={codePath} onChange={(e) => setCodePath(e.target.value)} placeholder="./src" style={inputStyle} />
                </div>
                <button onClick={handleCodeAudit} disabled={loading} style={{
                  padding: '10px 20px', background: loading ? 'var(--bg-tertiary)' : 'var(--brand-gradient)',
                  color: loading ? 'var(--text-secondary)' : 'white', border: 'none', borderRadius: '8px',
                  fontSize: '14px', fontWeight: '600', cursor: loading ? 'not-allowed' : 'pointer',
                }}>
                  {loading ? 'Auditing...' : 'Start Code Audit'}
                </button>
                {results && activeTab === 'code' && (
                  <div style={{ marginTop: '20px' }}>
                    <h3 style={{ fontSize: '14px', fontWeight: '600', color: 'var(--text-primary)', marginBottom: '10px' }}>
                      Code Audit Results ({results.issues?.length || 0} issues)
                    </h3>
                    {results.issues?.map((issue, i) => (
                      <div key={i} style={{
                        padding: '10px 12px', borderRadius: '6px', marginBottom: '6px',
                        background: issue.severity === 'Critical' ? '#ffebee' : issue.severity === 'High' ? '#fff3e0' : '#f5f5f5',
                        border: '1px solid var(--border-primary)',
                        fontSize: '12px',
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                          <span style={{ fontWeight: '600' }}>{issue.type}</span>
                          <SeverityBadge severity={issue.severity} />
                        </div>
                        <div style={{ color: 'var(--text-secondary)' }}>{issue.file}:{issue.line}</div>
                        <code style={{ fontSize: '11px', color: 'var(--text-primary)', display: 'block', marginTop: '4px' }}>{issue.code}</code>
                        {issue.recommendation && (
                          <div style={{ color: '#2e7d32', marginTop: '4px' }}>Fix: {issue.recommendation}</div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Dependencies Tab */}
            {activeTab === 'deps' && (
              <div style={{ background: 'var(--bg-secondary)', padding: '20px', borderRadius: '8px', border: '1px solid var(--border-primary)' }}>
                <h2 style={{ fontSize: '18px', fontWeight: '600', color: 'var(--text-primary)', marginTop: 0, marginBottom: '8px' }}>
                  Dependency Vulnerability Scan
                </h2>
                <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '20px' }}>
                  Scan your project dependencies for known vulnerabilities using CVE database and security advisories.
                </p>
                <button onClick={handleDependencyScan} disabled={loading} style={{
                  padding: '10px 20px', background: loading ? 'var(--bg-tertiary)' : 'var(--brand-gradient)',
                  color: loading ? 'var(--text-secondary)' : 'white', border: 'none', borderRadius: '8px',
                  fontSize: '14px', fontWeight: '600', cursor: loading ? 'not-allowed' : 'pointer',
                }}>
                  {loading ? 'Scanning...' : 'Scan Dependencies'}
                </button>
                {results && activeTab === 'deps' && (
                  <div style={{ marginTop: '20px' }}>
                    <h3 style={{ fontSize: '14px', fontWeight: '600', color: 'var(--text-primary)', marginBottom: '10px' }}>
                      Dependencies Checked: {results.dependenciesChecked}
                    </h3>
                    {results.vulnerabilities?.map((vuln, i) => (
                      <div key={i} style={{
                        padding: '10px 12px', borderRadius: '6px', marginBottom: '6px',
                        background: '#fff3e0', border: '1px solid #ffe082', fontSize: '12px',
                      }}>
                        <div style={{ fontWeight: '600' }}>{vuln.package} ({vuln.version})</div>
                        <div style={{ color: 'var(--text-secondary)' }}>{vuln.description}</div>
                        <div style={{ color: '#2e7d32', marginTop: '4px' }}>Fix: {vuln.recommendation}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Live Vulnerability Results */}
            <div ref={resultsRef}>
              {vulnerabilities.length > 0 && !isScanning && (
                <div style={{ marginTop: '24px' }}>
                  <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    marginBottom: '16px',
                  }}>
                    <h3 style={{
                      fontSize: '16px', fontWeight: '600', color: 'var(--text-primary)',
                      margin: 0, display: 'flex', alignItems: 'center', gap: '8px',
                    }}>
                      Scan Results
                      <span style={{
                        fontSize: '12px', color: 'var(--text-secondary)', fontWeight: '400',
                      }}>
                        ({vulnerabilities.length} vulnerabilities)
                      </span>
                    </h3>
                    {scanSummary && (
                      <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                        {scanSummary.critical > 0 && (
                          <span style={{ fontSize: '11px', fontWeight: '700', color: '#d32f2f' }}>
                            {scanSummary.critical} Critical
                          </span>
                        )}
                        {scanSummary.high > 0 && (
                          <span style={{ fontSize: '11px', fontWeight: '700', color: '#e65100' }}>
                            {scanSummary.high} High
                          </span>
                        )}
                        {scanSummary.medium > 0 && (
                          <span style={{ fontSize: '11px', fontWeight: '700', color: '#f9a825' }}>
                            {scanSummary.medium} Medium
                          </span>
                        )}
                        {scanSummary.low > 0 && (
                          <span style={{ fontSize: '11px', fontWeight: '700', color: '#1565c0' }}>
                            {scanSummary.low} Low
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Security Score */}
                  {aiAnalysis?.securityScore != null && (
                    <div style={{
                      padding: '16px', borderRadius: '10px', marginBottom: '16px',
                      background: aiAnalysis.securityScore >= 80 ? '#e8f5e9' : aiAnalysis.securityScore >= 50 ? '#fff8e1' : '#ffebee',
                      border: `1px solid ${aiAnalysis.securityScore >= 80 ? '#a5d6a7' : aiAnalysis.securityScore >= 50 ? '#ffe082' : '#ef9a9a'}`,
                      display: 'flex', alignItems: 'center', gap: '16px',
                    }}>
                      <div style={{
                        width: '56px', height: '56px', borderRadius: '50%',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: '20px', fontWeight: '800',
                        color: aiAnalysis.securityScore >= 80 ? '#2e7d32' : aiAnalysis.securityScore >= 50 ? '#e65100' : '#c62828',
                        background: aiAnalysis.securityScore >= 80 ? '#c8e6c9' : aiAnalysis.securityScore >= 50 ? '#ffecb3' : '#ffcdd2',
                        flexShrink: 0,
                      }}>
                        {aiAnalysis.securityScore}
                      </div>
                      <div>
                        <div style={{ fontSize: '14px', fontWeight: '600', color: 'var(--text-primary)' }}>
                          Security Score
                        </div>
                        <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                          {aiAnalysis.securityScore >= 80 ? 'Good security posture' :
                            aiAnalysis.securityScore >= 50 ? 'Moderate risk - improvements needed' :
                            'Poor security - immediate action required'}
                        </div>
                      </div>
                    </div>
                  )}

                  {vulnerabilities.map((vuln, i) => (
                    <VulnerabilityCard
                      key={i}
                      vuln={vuln}
                      onAnalyze={handleAnalyzeVuln}
                      isAnalyzing={aiLoading && selectedVuln === vuln}
                    />
                  ))}

                  {/* Recommendations */}
                  {aiAnalysis?.recommendations && aiAnalysis.recommendations.length > 0 && (
                    <div style={{
                      marginTop: '20px', padding: '16px',
                      background: 'var(--bg-secondary)',
                      borderRadius: '10px',
                      border: '1px solid var(--border-primary)',
                    }}>
                      <h4 style={{ fontSize: '14px', fontWeight: '600', color: 'var(--text-primary)', margin: '0 0 12px' }}>
                        Security Recommendations
                      </h4>
                      <ol style={{ margin: 0, paddingLeft: '18px' }}>
                        {aiAnalysis.recommendations.map((rec, i) => (
                          <li key={i} style={{
                            fontSize: '12px', color: 'var(--text-secondary)',
                            marginBottom: '6px', lineHeight: '1.5',
                          }}>
                            {rec}
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right Panel - AI Analysis */}
        <div style={{
          width: '380px',
          borderLeft: '1px solid var(--border-primary)',
          background: 'var(--bg-secondary)',
          display: 'flex',
          flexDirection: 'column',
          flexShrink: 0,
          overflow: 'hidden',
        }}>
          {/* Panel Header */}
          <div style={{
            padding: '16px',
            borderBottom: '1px solid var(--border-primary)',
            background: 'var(--bg-primary)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--brand)" strokeWidth="2">
                <circle cx="12" cy="12" r="10"/>
                <path d="M12 16v-4"/>
                <path d="M12 8h.01"/>
              </svg>
              <span style={{ fontSize: '15px', fontWeight: '600', color: 'var(--text-primary)' }}>
                AI Security Advisor
              </span>
            </div>
            <div style={{ display: 'flex', gap: '4px' }}>
              {[
                { id: 'analysis', label: 'Analysis' },
                { id: 'chat', label: 'Chat' },
                { id: 'report', label: 'Report' },
              ].map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setRightPanelTab(tab.id)}
                  style={{
                    flex: 1, padding: '6px 8px', fontSize: '11px', fontWeight: '600',
                    border: 'none', borderRadius: '6px',
                    background: rightPanelTab === tab.id ? 'var(--brand)' : 'var(--bg-tertiary)',
                    color: rightPanelTab === tab.id ? '#fff' : 'var(--text-secondary)',
                    cursor: 'pointer', transition: 'all 0.2s',
                  }}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          {/* Panel Content */}
          <div style={{ flex: 1, overflow: 'auto', padding: '16px' }}>
            {/* Analysis Tab */}
            {rightPanelTab === 'analysis' && (
              <div>
                {!aiAnalysis && !selectedVuln && vulnerabilities.length === 0 && (
                  <div style={{
                    textAlign: 'center', padding: '40px 20px',
                    color: 'var(--text-secondary)', fontSize: '13px',
                  }}>
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ marginBottom: '12px', opacity: 0.4 }}>
                      <circle cx="12" cy="12" r="10"/>
                      <path d="M12 16v-4"/>
                      <path d="M12 8h.01"/>
                    </svg>
                    <div style={{ fontWeight: '600', marginBottom: '4px' }}>AI Security Advisor</div>
                    <div>Run a security scan to get AI-powered analysis and remediation guidance.</div>
                  </div>
                )}

                {selectedVuln && (
                  <div style={{
                    padding: '10px 12px', marginBottom: '12px',
                    background: 'var(--bg-tertiary)', borderRadius: '8px',
                    border: '1px solid var(--border-primary)',
                  }}>
                    <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '2px' }}>Analyzing</div>
                    <div style={{ fontSize: '13px', fontWeight: '600', color: 'var(--text-primary)' }}>
                      {selectedVuln.type}
                    </div>
                    <SeverityBadge severity={selectedVuln.severity} />
                  </div>
                )}

                {aiLoading && (
                  <div style={{
                    padding: '20px', textAlign: 'center', color: 'var(--text-secondary)',
                  }}>
                    <div style={{
                      width: '24px', height: '24px',
                      border: '2px solid var(--brand)',
                      borderTop: '2px solid transparent',
                      borderRadius: '50%',
                      animation: 'spin 0.8s linear infinite',
                      margin: '0 auto 8px',
                    }} />
                    <div style={{ fontSize: '13px' }}>Analyzing with AI...</div>
                  </div>
                )}

                {!aiLoading && aiAnalysis && (
                  <div style={{ fontSize: '13px', color: 'var(--text-primary)', lineHeight: '1.6' }}>
                    {selectedVuln && aiAnalysis._currentAnalysis ? (
                      <div dangerouslySetInnerHTML={{
                        __html: aiAnalysis._currentAnalysis
                          .replace(/### /g, '<div style="font-size:14px;font-weight:700;margin:14px 0 6px;color:var(--text-primary)">')
                          .replace(/\n\n/g, '</div>')
                          .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
                          .replace(/\n- /g, '<br>• ')
                          .replace(/`([^`]+)`/g, '<code style="background:var(--bg-tertiary);padding:1px 4px;border-radius:3px;font-size:11px">$1</code>')
                          .split('</div>').map((s, i) => i % 2 === 0 ? s : s + '</div>').join('')
                      }} />
                    ) : (
                      <div>
                        <div style={{ fontSize: '14px', fontWeight: '700', marginBottom: '8px' }}>
                          Security Score: {aiAnalysis.securityScore}/100
                        </div>
                        <div style={{ color: 'var(--text-secondary)', marginBottom: '12px' }}>
                          {aiAnalysis.reportSummary}
                        </div>

                        {aiAnalysis.criticalFindings?.length > 0 && (
                          <div style={{ marginBottom: '12px' }}>
                            <div style={{ fontSize: '13px', fontWeight: '700', color: '#d32f2f', marginBottom: '6px' }}>
                              Critical Findings
                            </div>
                            {aiAnalysis.criticalFindings.map((cf, i) => (
                              <div key={i} style={{
                                padding: '8px 10px', marginBottom: '6px',
                                background: '#ffebee', borderRadius: '6px',
                                border: '1px solid #ef9a9a',
                                fontSize: '12px',
                              }}>
                                <strong>{cf.type}:</strong> {cf.immediateAction}
                              </div>
                            ))}
                          </div>
                        )}

                        <div style={{ fontSize: '13px', fontWeight: '700', margin: '12px 0 6px' }}>
                          Attack Vectors
                        </div>
                        {aiAnalysis.attackVectors?.slice(0, 5).map((av, i) => (
                          <div key={i} style={{
                            padding: '10px', marginBottom: '8px',
                            background: 'var(--bg-tertiary)', borderRadius: '8px',
                            border: '1px solid var(--border-primary)',
                          }}>
                            <div style={{
                              display: 'flex', justifyContent: 'space-between',
                              alignItems: 'center', marginBottom: '4px',
                            }}>
                              <span style={{ fontWeight: '600', fontSize: '12px' }}>{av.type}</span>
                              <SeverityBadge severity={av.severity} />
                            </div>
                            <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                              {av.howItWorks}
                            </div>
                            <div style={{ fontSize: '11px', color: '#2e7d32', fontWeight: '500' }}>
                              Fix: {av.fix}
                            </div>
                            <div style={{
                              fontSize: '10px', color: 'var(--text-tertiary)',
                              marginTop: '4px', fontWeight: '600',
                            }}>
                              {av.priority}
                            </div>
                          </div>
                        ))}

                        {aiAnalysis.recommendations?.length > 0 && (
                          <div style={{ marginTop: '12px' }}>
                            <div style={{ fontSize: '13px', fontWeight: '700', marginBottom: '6px' }}>
                              Recommendations
                            </div>
                            {aiAnalysis.recommendations.map((rec, i) => (
                              <div key={i} style={{
                                display: 'flex', gap: '6px', fontSize: '12px',
                                color: 'var(--text-secondary)', marginBottom: '4px',
                              }}>
                                <span style={{ color: '#2e7d32' }}>✓</span>
                                <span>{rec}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Chat Tab */}
            {rightPanelTab === 'chat' && (
              <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                <div style={{
                  flex: 1, overflow: 'auto', marginBottom: '12px',
                  display: 'flex', flexDirection: 'column', gap: '10px',
                }}>
                  {aiHistory.length === 0 && (
                    <div style={{
                      textAlign: 'center', padding: '30px 16px',
                      color: 'var(--text-secondary)', fontSize: '13px',
                    }}>
                      <div style={{ fontWeight: '600', marginBottom: '8px' }}>Ask about vulnerabilities</div>
                      <div>Example: "How do I fix SQL injection in my code?"</div>
                    </div>
                  )}
                  {aiHistory.map((msg, i) => (
                    <div key={i} style={{
                      padding: '10px 12px',
                      borderRadius: '8px',
                      fontSize: '12px',
                      lineHeight: '1.5',
                      background: msg.role === 'user' ? 'var(--brand)' : 'var(--bg-tertiary)',
                      color: msg.role === 'user' ? '#fff' : 'var(--text-primary)',
                      alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
                      maxWidth: '85%',
                      border: msg.role === 'user' ? 'none' : '1px solid var(--border-primary)',
                    }}>
                      {msg.loading ? (
                        <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                          <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--brand)', animation: 'pulse 0.8s ease-in-out infinite' }} />
                          <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--brand)', animation: 'pulse 0.8s ease-in-out infinite 0.2s' }} />
                          <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--brand)', animation: 'pulse 0.8s ease-in-out infinite 0.4s' }} />
                        </div>
                      ) : (
                        <div dangerouslySetInnerHTML={{
                          __html: msg.content
                            .replace(/### /g, '<div style="font-weight:700;margin:8px 0 4px">')
                            .replace(/\n\n/g, '</div>')
                            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
                            .replace(/\n- /g, '<br>• ')
                            .replace(/`([^`]+)`/g, '<code style="background:rgba(0,0,0,0.1);padding:1px 4px;border-radius:3px">$1</code>')
                            .replace(/\n/g, '<br>')
                            .split('</div>').map((s, i) => i % 2 === 0 ? s : s + '</div>').join('')
                        }} />
                      )}
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <input
                    type="text"
                    value={aiInput}
                    onChange={(e) => setAiInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAskAI(); } }}
                    placeholder={vulnerabilities.length > 0 ? 'Ask about a vulnerability...' : 'Run a scan first...'}
                    disabled={vulnerabilities.length === 0}
                    style={{
                      flex: 1, padding: '8px 12px', fontSize: '12px',
                      border: '1px solid var(--border-primary)', borderRadius: '8px',
                      background: 'var(--bg-tertiary)', color: 'var(--text-primary)',
                      outline: 'none',
                    }}
                  />
                  <button
                    onClick={handleAskAI}
                    disabled={!aiInput.trim() || vulnerabilities.length === 0}
                    style={{
                      padding: '8px 12px', fontSize: '12px', fontWeight: '600',
                      border: 'none', borderRadius: '8px',
                      background: aiInput.trim() && vulnerabilities.length > 0 ? 'var(--brand)' : 'var(--bg-tertiary)',
                      color: aiInput.trim() && vulnerabilities.length > 0 ? '#fff' : 'var(--text-secondary)',
                      cursor: aiInput.trim() && vulnerabilities.length > 0 ? 'pointer' : 'not-allowed',
                    }}
                  >
                    Send
                  </button>
                </div>
              </div>
            )}

            {/* Report Tab */}
            {rightPanelTab === 'report' && (
              <div>
                {!results && vulnerabilities.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-secondary)', fontSize: '13px' }}>
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ marginBottom: '12px', opacity: 0.4 }}>
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                      <polyline points="14 2 14 8 20 8"/>
                    </svg>
                    <div style={{ fontWeight: '600', marginBottom: '4px' }}>Security Report</div>
                    <div>Complete a scan to generate a detailed security report.</div>
                  </div>
                ) : (
                  <div>
                    <div style={{ fontSize: '13px', fontWeight: '600', color: 'var(--text-primary)', marginBottom: '12px' }}>
                      Scan Summary
                    </div>

                    <div style={{
                      padding: '14px', borderRadius: '8px',
                      background: 'var(--bg-tertiary)',
                      border: '1px solid var(--border-primary)',
                      marginBottom: '12px',
                    }}>
                      <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>Target</div>
                      <div style={{ fontSize: '13px', fontWeight: '600', color: 'var(--text-primary)', fontFamily: 'monospace', wordBreak: 'break-all' }}>
                        {results?.target || target}
                      </div>
                    </div>

                    {scanSummary && (
                      <div style={{ marginBottom: '12px' }}>
                        <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '6px' }}>Severity Breakdown</div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
                          {[
                            { label: 'Critical', count: scanSummary.critical, color: '#d32f2f', bg: '#ffebee' },
                            { label: 'High', count: scanSummary.high, color: '#e65100', bg: '#fff3e0' },
                            { label: 'Medium', count: scanSummary.medium, color: '#f9a825', bg: '#fff8e1' },
                            { label: 'Low', count: scanSummary.low, color: '#1565c0', bg: '#e3f2fd' },
                          ].map(item => (
                            <div key={item.label} style={{
                              padding: '8px 10px', borderRadius: '6px',
                              background: item.bg, textAlign: 'center',
                            }}>
                              <div style={{ fontSize: '18px', fontWeight: '700', color: item.color }}>{item.count}</div>
                              <div style={{ fontSize: '10px', color: item.color, fontWeight: '600', textTransform: 'uppercase' }}>{item.label}</div>
                            </div>
                          ))}
                        </div>
                        <div style={{
                          marginTop: '8px', padding: '8px 10px', borderRadius: '6px',
                          background: 'var(--bg-primary)', textAlign: 'center',
                          border: '1px solid var(--border-primary)',
                        }}>
                          <div style={{ fontSize: '20px', fontWeight: '700', color: 'var(--text-primary)' }}>{scanSummary.total}</div>
                          <div style={{ fontSize: '10px', color: 'var(--text-secondary)', fontWeight: '600', textTransform: 'uppercase' }}>Total Vulnerabilities</div>
                        </div>
                      </div>
                    )}

                    {aiAnalysis?.securityScore != null && (
                      <div style={{
                        padding: '12px', borderRadius: '8px', marginBottom: '12px',
                        background: aiAnalysis.securityScore >= 80 ? '#e8f5e9' : aiAnalysis.securityScore >= 50 ? '#fff8e1' : '#ffebee',
                        border: `1px solid ${aiAnalysis.securityScore >= 80 ? '#a5d6a7' : aiAnalysis.securityScore >= 50 ? '#ffe082' : '#ef9a9a'}`,
                        textAlign: 'center',
                      }}>
                        <div style={{ fontSize: '24px', fontWeight: '800', color: aiAnalysis.securityScore >= 80 ? '#2e7d32' : aiAnalysis.securityScore >= 50 ? '#e65100' : '#c62828' }}>
                          {aiAnalysis.securityScore}/100
                        </div>
                        <div style={{ fontSize: '11px', color: 'var(--text-secondary)', fontWeight: '500' }}>Security Score</div>
                      </div>
                    )}

                    <div style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      <button
                        onClick={generateReport}
                        style={{
                          padding: '10px 16px', fontSize: '13px', fontWeight: '600',
                          border: 'none', borderRadius: '8px',
                          background: 'var(--brand-gradient)',
                          color: '#fff', cursor: 'pointer',
                        }}
                      >
                        Export Report (Markdown)
                      </button>
                      <button
                        onClick={() => {
                          const vulns = results?.vulnerabilities || vulnerabilities;
                          const json = JSON.stringify({
                            target: results?.target || target,
                            timestamp: results?.timestamp || new Date().toISOString(),
                            scanType: results?.scanType || scanType,
                            summary: scanSummary,
                            vulnerabilities: vulns,
                            targetInfo: targetInfo,
                          }, null, 2);
                          const blob = new Blob([json], { type: 'application/json' });
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement('a');
                          a.href = url;
                          a.download = `security-report-${Date.now()}.json`;
                          a.click();
                          URL.revokeObjectURL(url);
                        }}
                        style={{
                          padding: '10px 16px', fontSize: '13px', fontWeight: '600',
                          border: '1px solid var(--border-primary)',
                          borderRadius: '8px',
                          background: 'var(--bg-tertiary)',
                          color: 'var(--text-primary)', cursor: 'pointer',
                        }}
                      >
                        Export Report (JSON)
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        @keyframes pulse {
          0%, 100% { opacity: 0.3; }
          50% { opacity: 1; }
        }
      `}</style>
    </DashboardLayout>
  );
}