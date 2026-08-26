import { useState, useEffect, useRef, useCallback } from 'react';

const FRAMEWORKS = [
  { value: 'next.js', label: 'Next.js (Full-Stack)', hint: 'React SSR + API Routes, siap deploy Vercel' },
  { value: 'react-express', label: 'React + Express (MERN)', hint: 'SPA React + backend Node/Express + MongoDB' },
  { value: 'laravel', label: 'Laravel (PHP)', hint: 'Full-stack PHP: Blade + Eloquent + migrations' },
  { value: 'go-fiber', label: 'Golang Fiber + HTML', hint: 'Backend Go cepat + template HTML' },
  { value: 'vue-fastapi', label: 'Vue 3 + FastAPI (Python)', hint: 'Frontend Vue + backend Python modern' },
  { value: 'html-css-js', label: 'HTML/CSS/JS Murni', hint: 'Static site, tanpa build step' },
];

const APP_TYPES = [
  { value: 'landing-page', label: 'Landing Page' },
  { value: 'dashboard', label: 'Dashboard Admin' },
  { value: 'erp', label: 'ERP' },
  { value: 'cms', label: 'CMS' },
  { value: 'ecommerce', label: 'E-Commerce' },
  { value: 'saas', label: 'SaaS App' },
  { value: 'blog', label: 'Blog' },
  { value: 'web-app', label: 'Web App Umum' },
];

export default function Generator() {
  const [description, setDescription] = useState('');
  const [framework, setFramework] = useState('next.js');
  const [appType, setAppType] = useState('dashboard');
  const [projectName, setProjectName] = useState('');
  const [extra, setExtra] = useState('');
  const [maxFiles, setMaxFiles] = useState(40);

  const [projects, setProjects] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [project, setProject] = useState(null);
  const [events, setEvents] = useState([]);
  const [selectedFile, setSelectedFile] = useState(null);
  const [fileContent, setFileContent] = useState('');
  const [starting, setStarting] = useState(false);
  const [cfgProviders, setCfgProviders] = useState([]);
  const [cfg, setCfg] = useState(null);
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const esRef = useRef(null);
  const feedRef = useRef(null);

  // Muat daftar provider + model dari config
  useEffect(() => {
    fetch('/api/config').then(r => r.json()).then(data => {
      setCfg(data);
      const provs = (data.providers || []).filter(p => {
        if (p === 'puter') return data.puter?.enabled;
        return true;
      });
      setCfgProviders(provs);
      // Default: nvidia jika ada, selain itu default server
      const preferred = provs.includes('nvidia') ? 'nvidia' : (data.defaultProvider || provs[0]);
      setProvider(preferred);
      const defModel = data[preferred]?.defaultModel || data[preferred]?.models?.[0]?.id || '';
      setModel(defModel);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    fetch('/api/config').then(r => r.json()).then(cfg => {
      const m = cfg[provider];
      if (m?.defaultModel) setModel(m.defaultModel);
    }).catch(() => {});
  }, [provider]);

  const loadProjects = useCallback(async () => {
    try {
      const res = await fetch('/api/generator/projects');
      const data = await res.json();
      setProjects(data.projects || []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadProjects(); }, [loadProjects]);
  useEffect(() => () => { if (esRef.current) esRef.current.close(); }, []);

  useEffect(() => {
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [events]);

  // Poll project status while running
  useEffect(() => {
    if (!activeId) return;
    let stop = false;
    const poll = async () => {
      try {
        const res = await fetch(`/api/generator/${activeId}`);
        if (res.ok && !stop) setProject(await res.json());
      } catch { /* ignore */ }
    };
    poll();
    const iv = setInterval(poll, 4000);
    return () => { stop = true; clearInterval(iv); };
  }, [activeId]);

  const openProject = useCallback(async (id) => {
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
    setActiveId(id);
    setSelectedFile(null);
    setFileContent('');
    setEvents([]);
    try {
      const res = await fetch(`/api/generator/${id}`);
      const data = await res.json();
      setProject(data);
      // Rekonstruksi tampilan dari state server
      setEvents((data.plan || []).slice(0, 0)); // reset
      for (const f of data.files || []) {
        setEvents(ev => [...ev, { type: 'file_done', path: f.path, size: f.size }]);
      }
      if (data.status === 'running') connectSSE(id);
    } catch { /* ignore */ }
  }, []);

  const connectSSE = useCallback((id) => {
    if (esRef.current) esRef.current.close();
    const es = new EventSource(`/api/generator/${id}/events`);
    esRef.current = es;
    es.onmessage = (e) => {
      try {
        const evt = JSON.parse(e.data);
        if (evt.type === 'connected') return;
        setEvents(ev => [...ev.slice(-500), evt]);
        if (evt.type === 'plan') {
          setProject(p => p ? { ...p, plan: evt.files || p.plan, name: evt.name || p.name } : p);
        }
        if (evt.type === 'complete' || evt.type === 'error') {
          es.close(); esRef.current = null;
          loadProjects();
          fetch(`/api/generator/${id}`).then(r => r.json()).then(setProject).catch(() => {});
        }
      } catch { /* ignore */ }
    };
    es.onerror = () => { /* EventSource auto-reconnect; biarkan */ };
  }, [loadProjects]);

  const handleStart = useCallback(async () => {
    if (!description.trim() || starting) return;
    setStarting(true);
    try {
      const res = await fetch('/api/generator/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description, framework, appType, projectName, extra, maxFiles, provider, model }),
      });
      const data = await res.json();
      if (data.id) {
        setActiveId(data.id);
        setProject({ id: data.id, status: 'queued', files: [], plan: [] });
        setEvents([]);
        setSelectedFile(null);
        connectSSE(data.id);
        loadProjects();
      } else {
        alert(data.error || 'Gagal memulai generator');
      }
    } catch (e) {
      alert('Error: ' + e.message);
    } finally {
      setStarting(false);
    }
  }, [description, framework, appType, projectName, extra, maxFiles, provider, model, starting, connectSSE, loadProjects]);

  const viewFile = useCallback(async (path) => {
    setSelectedFile(path);
    setFileContent('Loading...');
    try {
      const res = await fetch(`/api/generator/${activeId}/file?path=${encodeURIComponent(path)}`);
      const data = await res.json();
      setFileContent(data.content ?? '// file tidak ditemukan');
    } catch {
      setFileContent('// gagal memuat file');
    }
  }, [activeId]);

  const running = project && ['running', 'stopping', 'queued'].includes(project.status);
  const doneCount = (project?.files || []).length;
  const totalPlanned = (project?.plan || []).length;
  const pct = totalPlanned ? Math.round((doneCount / totalPlanned) * 100) : 0;

  const styles = {
    wrap: { minHeight: '100vh', background: 'var(--bg, #f6f8fb)', padding: '24px', fontFamily: 'system-ui, sans-serif' },
    header: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 },
    logo: { width: 40, height: 40, borderRadius: 10, background: 'linear-gradient(135deg,#0066ff,#00ccff)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 800, fontSize: 18 },
    grid: { display: 'grid', gridTemplateColumns: '380px 1fr', gap: 20, maxWidth: 1400, margin: '0 auto' },
    card: { background: '#fff', borderRadius: 14, padding: 20, boxShadow: '0 1px 4px rgba(0,0,0,.08)' },
    label: { display: 'block', fontSize: 12, fontWeight: 600, color: '#555', margin: '12px 0 6px' },
    input: { width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: 8, border: '1px solid #d9e2ec', fontSize: 13, outline: 'none' },
    select: { width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #d9e2ec', fontSize: 13, background: '#fff' },
    btn: { width: '100%', marginTop: 16, padding: '12px', borderRadius: 10, border: 'none', background: 'linear-gradient(90deg,#0066ff,#00aaFF)', color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer' },
    btnGhost: { padding: '8px 14px', borderRadius: 8, border: '1px solid #d9e2ec', background: '#fff', cursor: 'pointer', fontSize: 13 },
    btnZip: { display: 'inline-block', padding: '10px 22px', borderRadius: 10, background: '#16a34a', color: '#fff', fontWeight: 700, textDecoration: 'none', fontSize: 14 },
    barOuter: { height: 8, background: '#e8eef5', borderRadius: 99, overflow: 'hidden', margin: '10px 0' },
    barInner: { height: '100%', background: 'linear-gradient(90deg,#0066ff,#00ccff)', transition: 'width .4s' },
    fileList: { maxHeight: 380, overflowY: 'auto', marginTop: 10 },
    fileItem: { display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 7, cursor: 'pointer', fontSize: 13, borderBottom: '1px solid #f0f3f7' },
    code: { background: '#0d1220', color: '#d6e2ff', borderRadius: 10, padding: 16, overflow: 'auto', maxHeight: 480, fontSize: 12.5, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: "'Cascadia Code','Fira Code',monospace" },
    eventLine: { fontSize: 12.5, padding: '4px 0', borderBottom: '1px dashed #eef2f7' },
    pill: { fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 99 },
  };

  const statusColor = { running: '#f59e0b', done: '#16a34a', error: '#dc2626', stopped: '#6b7280', queued: '#3b82f6', stopping: '#f59e0b' };

  return (
    <div style={styles.wrap}>
      <div style={{ ...styles.grid }}>
        {/* ── KOLOM KIRI: FORM ── */}
        <div>
          <div style={styles.card}>
            <div style={styles.header}>
              <div style={styles.logo}>{'</>'}</div>
              <div>
                <h2 style={{ margin: 0, fontSize: 17 }}>AI Project Generator</h2>
                <div style={{ fontSize: 12, color: '#777' }}>Full-stack app otomatis — UI interaktif + backend</div>
              </div>
            </div>

            <label style={styles.label}>Jenis Aplikasi</label>
            <select style={styles.select} value={appType} onChange={e => setAppType(e.target.value)}>
              {APP_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>

            <label style={styles.label}>Framework / Stack</label>
            <select style={styles.select} value={framework} onChange={e => setFramework(e.target.value)}>
              {FRAMEWORKS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
            <div style={{ fontSize: 11.5, color: '#889', marginTop: 4 }}>
              {FRAMEWORKS.find(f => f.value === framework)?.hint}
            </div>

            <label style={styles.label}>Deskripsi Project *</label>
            <textarea
              style={{ ...styles.input, minHeight: 110, resize: 'vertical' }}
              placeholder="Contoh: Sistem manajemen inventori gudang dengan multi-user, laporan stok real-time, export Excel, dan dark mode..."
              value={description}
              onChange={e => setDescription(e.target.value)}
            />

            <label style={styles.label}>Nama Project (opsional)</label>
            <input style={styles.input} placeholder="my-inventory-app" value={projectName} onChange={e => setProjectName(e.target.value)} />

            <label style={styles.label}>Fitur Tambahan (opsional)</label>
            <input style={styles.input} placeholder="auth JWT, chart, CRUD kategori..." value={extra} onChange={e => setExtra(e.target.value)} />

            <label style={styles.label}>Provider AI *</label>
            <select style={styles.select} value={provider} onChange={e => setProvider(e.target.value)}>
              {cfgProviders.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
            <div style={{ fontSize: 11.5, color: '#889', marginTop: 4 }}>
              Gunakan provider gratis yang sehat (mis. nvidia) agar tidak boros saldo
            </div>

            <label style={styles.label}>Model AI</label>
            <select style={styles.select} value={model} onChange={e => setModel(e.target.value)}>
              <option value="">(default provider)</option>
              {(cfg?.[provider]?.models || []).map(m => (
                <option key={m.id} value={m.id}>{m.label || m.id}{m.rec ? ' ★' : ''}</option>
              ))}
            </select>

            <label style={styles.label}>Maks File: <b>{maxFiles}</b></label>
            <input type="range" min="10" max="80" step="5" value={maxFiles} onChange={e => setMaxFiles(+e.target.value)} style={{ width: '100%' }} />

            <button style={{ ...styles.btn, opacity: starting || !description.trim() ? .6 : 1 }} onClick={handleStart} disabled={starting}>
              {starting ? 'Memulai...' : '🚀 Generate Project'}
            </button>
          </div>

          {/* Riwayat */}
          <div style={{ ...styles.card, marginTop: 16 }}>
            <h3 style={{ margin: '0 0 10px', fontSize: 14 }}>📁 Riwayat Project</h3>
            {projects.length === 0 && <div style={{ fontSize: 12.5, color: '#999' }}>Belum ada project.</div>}
            {projects.map(pr => (
              <div key={pr.id} style={{ ...styles.fileItem, background: pr.id === activeId ? '#eff6ff' : 'transparent' }} onClick={() => openProject(pr.id)}>
                <span style={{ width: 8, height: 8, borderRadius: 99, background: statusColor[pr.status] || '#999', flexShrink: 0 }} />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pr.name}</span>
                <span style={{ fontSize: 11, color: '#889' }}>{pr.files?.length || 0} file</span>
                {pr.status !== 'running' && (
                  <button title="Hapus" onClick={async (e) => { e.stopPropagation(); await fetch(`/api/generator/${pr.id}`, { method: 'DELETE' }); if (activeId === pr.id) { setActiveId(null); setProject(null); } loadProjects(); }}
                    style={{ border: 'none', background: 'none', color: '#c66', cursor: 'pointer', fontWeight: 700 }}>×</button>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* ── KOLOM KANAN: PROGRESS & PREVIEW ── */}
        <div style={styles.card}>
          {!activeId && (
            <div style={{ textAlign: 'center', padding: '70px 20px', color: '#98a6b8' }}>
              <div style={{ fontSize: 44, marginBottom: 12 }}>⚙️</div>
              <div style={{ fontSize: 15, fontWeight: 600, color: '#556' }}>Belum ada project aktif</div>
              <div style={{ fontSize: 13, marginTop: 6 }}>Isi formulir di kiri, klik Generate, dan AI akan membangun<br />project lengkap file demi file — lalu unduh sebagai ZIP.</div>
            </div>
          )}

          {activeId && project && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <h2 style={{ margin: 0, fontSize: 18 }}>{project.name}</h2>
                <span style={{ ...styles.pill, background: `${statusColor[project.status] || '#999'}1a`, color: statusColor[project.status] }}>
                  {(project.status || '').toUpperCase()}
                </span>
                <span style={{ fontSize: 12, color: '#779' }}>{project.framework} · {project.appType}</span>
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                  {running && (
                    <button style={styles.btnGhost} onClick={async () => { await fetch(`/api/generator/${activeId}/stop`, { method: 'POST' }); }}>⏹ Stop</button>
                  )}
                  {['done', 'stopped'].includes(project.status) && doneCount > 0 && (
                    <a style={styles.btnZip} href={`/api/generator/${activeId}/download`}>⬇ Download ZIP ({doneCount} file)</a>
                  )}
                </div>
              </div>

              {/* Progress bar */}
              <div style={styles.barOuter}><div style={{ ...styles.barInner, width: `${pct}%` }} /></div>
              <div style={{ fontSize: 12, color: '#667', display: 'flex', justifyContent: 'space-between' }}>
                <span>{doneCount}/{totalPlanned || '?'} file selesai {pct ? `(${pct}%)` : ''}</span>
                {project.failed?.length > 0 && <span style={{ color: '#dc2626' }}>{project.failed.length} gagal</span>}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 16, marginTop: 16 }}>
                {/* File tree */}
                <div>
                  <h4 style={{ margin: '0 0 6px', fontSize: 12.5, color: '#556', textTransform: 'uppercase', letterSpacing: .5 }}>Files</h4>
                  <div style={styles.fileList}>
                    {[...new Set(events.filter(e => e.type === 'file_done').map(e => JSON.stringify(e)))]
                      .map(s => JSON.parse(s))
                      .map(e => (
                        <div key={e.path} style={{ ...styles.fileItem, background: selectedFile === e.path ? '#eff6ff' : 'transparent' }} onClick={() => viewFile(e.path)}>
                          <span style={{ color: '#16a34a' }}>✓</span>
                          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left' }}>{e.path}</span>
                          <span style={{ fontSize: 10.5, color: '#99a' }}>{Math.max(1, Math.round(e.size / 1024))}k</span>
                        </div>
                      ))}
                    {events.some(e => e.type === 'file_start') && running && (
                      <div style={{ ...styles.fileItem, color: '#f59e0b' }}>
                        <span className="spinner">⟳</span>
                        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {events.filter(e => e.type === 'file_start').slice(-1)[0]?.path}
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Preview / Feed */}
                <div>
                  {selectedFile ? (
                    <>
                      <h4 style={{ margin: '0 0 6px', fontSize: 12.5, color: '#556' }}>{selectedFile}
                        <button style={{ ...styles.btnGhost, marginLeft: 10, padding: '3px 10px', fontSize: 11 }} onClick={() => setSelectedFile(null)}>tutup</button>
                      </h4>
                      <pre style={styles.code}>{fileContent}</pre>
                    </>
                  ) : (
                    <>
                      <h4 style={{ margin: '0 0 6px', fontSize: 12.5, color: '#556', textTransform: 'uppercase', letterSpacing: .5 }}>Live Activity</h4>
                      <div ref={feedRef} style={{ ...styles.fileList, maxHeight: 480, background: '#fafcff', border: '1px solid #eef2f7', borderRadius: 10, padding: 10 }}>
                        {events.length === 0 && <div style={{ color: '#99a', fontSize: 12 }}>Menunggu aktivitas AI...</div>}
                        {events.map((e, i) => (
                          <div key={i} style={styles.eventLine}>
                            {e.type === 'start' && <span>🎬 Memulai generate <b>{e.name}</b> ({e.framework})</span>}
                            {e.type === 'phase' && <span>📌 Fase: <b>{e.phase}</b></span>}
                            {e.type === 'plan' && <span>🗺️ Rencana disusun: <b>{e.total} file</b></span>}
                            {e.type === 'file_start' && <span>✏️ Menulis <code>{e.path}</code> ({e.index}/{e.total})</span>}
                            {e.type === 'file_done' && <span style={{ color: '#16794a' }}>✅ Selesai <code>{e.path}</code></span>}
                            {e.type === 'file_failed' && <span style={{ color: '#dc2626' }}>❌ Gagal <code>{e.path}</code></span>}
                            {e.type === 'info' && <span style={{ color: '#b45309' }}>ℹ️ {e.message}</span>}
                            {e.type === 'complete' && <span style={{ color: '#16a34a', fontWeight: 700 }}>🎉 SELESAI! {e.filesDone} file dibuat. Siap di-download ZIP.</span>}
                            {e.type === 'error' && <span style={{ color: '#dc2626', fontWeight: 700 }}>💥 Error: {e.message}</span>}
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
