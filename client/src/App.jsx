import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { Routes, Route } from 'react-router-dom';
import { useConfig } from './hooks/useConfig';
import { useSessions } from './hooks/useSessions';
import { useChat } from './hooks/useChat';
import Sidebar from './components/Sidebar';
import Header from './components/Header';
import Toolbar from './components/Toolbar';
import ChatArea from './components/ChatArea';
import InputBar from './components/InputBar';
import Footer from './components/Footer';
import Settings from './components/Settings';
import AnalyticsPageNew from './components/AnalyticsPageNew';
import JobAgent from './components/JobAgent';
import Profile from './components/Profile';
import VoiceTalk from './components/VoiceTalk';
import AgentFlow, { AgentLiveBar } from './components/AgentFlow';
import AuroraBackground from './components/AuroraBackground';
import Automation from './components/Automation';
import Worklog from './components/Worklog';
import Tracking from './components/Tracking';
import Tracker from './components/Tracker';
import CommandCenter from './components/CommandCenter';
import AgentCenter from './components/AgentCenter';
// three.js is large: the map page is fetched only when opened
const SystemMapPage = lazy(() => import('./components/SystemMapPage'));
import UpdateBanner from './components/UpdateBanner';

function ChatLayout() {
  const {
    config, usage, provider, setProvider,
    model, setModel, route, setRoute,
    providerInfo, providerConfig, PROVIDER_MAP, loadConfig,
  } = useConfig();

  const { sessions, currentId, setCurrentId, create, remove, cleanup, switchTo, reload } = useSessions();
  const [sidebarOpen, setSidebarOpen] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth > 768 : true
  );
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'light');
  const [connected, setConnected] = useState(true);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => setSidebarOpen(window.innerWidth > 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    const h = async () => {
      try { await fetch('/api/health'); setConnected(true); }
      catch { setConnected(false); }
    };
    h();
    const ih = setInterval(h, 30000);
    const ic = setInterval(loadConfig, 10000);
    return () => { clearInterval(ih); clearInterval(ic); };
  }, [loadConfig]);

  const saveSession = useCallback(async (msgs) => {
    if (!msgs || msgs.length === 0) return;
    const id = await create({
      id: currentId || undefined,
      provider, model,
      messages: msgs,
    });
    if (id) setCurrentId(id);
  }, [currentId, provider, model, create, setCurrentId]);

  const [attachments, setAttachments] = useState([]);
  const { messages, processing, status, agentFlow, send, stop, clear, loadMessages, setStatus, updateMessage } = useChat(saveSession);
  const [flowOpen, setFlowOpen] = useState(false);

  const closeSidebarMobile = useCallback(() => {
    if (typeof window !== 'undefined' && window.innerWidth <= 768) setSidebarOpen(false);
  }, []);

  const handleSwitchSession = useCallback(async (id) => {
    if (processing) return;
    closeSidebarMobile();
    setStatus({ color: 'var(--yl)', text: 'Memuat...' });
    try {
      const msgs = await switchTo(id);
      loadMessages(msgs || []);
      setCurrentId(id);
      setStatus({ color: 'var(--gr)', text: 'Ready' });
    } catch {
      setStatus({ color: 'var(--re)', text: 'Gagal memuat sesi' });
    }
  }, [processing, loadMessages, setCurrentId, closeSidebarMobile, setStatus, switchTo]);

  const handleDeleteSession = useCallback(async (id) => {
    closeSidebarMobile();
    try {
      await remove(id);
    } catch {
      await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
    }
    if (currentId === id) { setCurrentId(null); loadMessages([]); }
    reload();
  }, [currentId, closeSidebarMobile, loadMessages, reload, setCurrentId, remove]);

  const handleNewChat = useCallback(() => {
    if (processing) return;
    closeSidebarMobile();
    setCurrentId(null);
    loadMessages([]);
    setStatus({ color: 'var(--gr)', text: 'Ready' });
  }, [processing, closeSidebarMobile, loadMessages, setCurrentId, setStatus]);

  const handleProviderChange = useCallback(async (p) => {
    setProvider(p);
    const info = PROVIDER_MAP[p];
    if (!info) return;
    const cfg = config?.[info.key];
    if (cfg?.defaultModel) {
      setModel(cfg.defaultModel);
      setRoute(info.hasRoute ? '' : null);
    }
  }, [setProvider, setModel, setRoute, config, PROVIDER_MAP]);

  const handleSend = useCallback(async (text) => {
    const effectiveRoute = route === null ? '' : (route || '');
    // Teruskan teks eksplisit dari InputBar agar tidak balapan dengan DOM query.
    await send(provider, model, effectiveRoute, attachments, text ?? null);
    setAttachments([]);
  }, [send, provider, model, route, attachments]);

  const handleKey = useCallback((e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); handleNewChat(); }
    if ((e.metaKey || e.ctrlKey) && e.key === 'u') { e.preventDefault(); setTheme(t => t === 'dark' ? 'light' : 'dark'); }
    if ((e.metaKey || e.ctrlKey) && e.key === 'b') { e.preventDefault(); setSidebarOpen(o => !o); }
  }, [handleNewChat]);

  useEffect(() => {
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [handleKey]);

  useEffect(() => {
    if (!sidebarOpen || typeof window === 'undefined' || window.innerWidth > 768) return;
    const handler = (e) => {
      const sd = document.querySelector('.sidebar');
      const btn = document.querySelector('.header-toggle');
      if (sd && !sd.contains(e.target) && (!btn || !btn.contains(e.target))) {
        setSidebarOpen(false);
      }
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [sidebarOpen]);

  const handleQuickAction = useCallback((prompt) => {
    if (processing) return;
    send(provider, model, route === null ? '' : (route || ''), [], prompt);
  }, [processing, send, provider, model, route]);

  const models = providerConfig ? providerConfig.models : [];
  const providers = Object.entries(PROVIDER_MAP).map(([k, v]) => ({ key: k, label: v.label + (config && config[v.key] && config[v.key].configured === false ? ' — kunci API belum diisi' : '') }));

  return (
    <>
    <AuroraBackground />
    <div className="app">
      <Sidebar
        sessions={sessions}
        currentId={currentId}
        onSwitch={handleSwitchSession}
        onDelete={handleDeleteSession}
        onCleanup={cleanup}
        onNew={handleNewChat}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />
      <div className="main">
        <Header
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen(o => !o)}
          theme={theme}
          onThemeToggle={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
          connected={connected}
          provider={providerInfo?.label || provider}
          model={model}
        />
        <Toolbar
          onClear={clear}
          connected={connected}
          modelCount={models.length}
          usage={usage}
          config={config}
          onFlow={() => setFlowOpen(true)}
          flowStage={agentFlow?.stage}
        />
        <AgentLiveBar flow={agentFlow} />
        <ChatArea messages={messages} processing={processing} onEdit={updateMessage} onQuickAction={handleQuickAction} />
        <InputBar
          onSend={handleSend} processing={processing} onStop={stop}
          route={route} onRouteChange={setRoute}
          hasRoute={providerInfo?.hasRoute}
          attachments={attachments}
          onAttachmentsChange={setAttachments}
          provider={provider}
          model={model}
          providers={providers}
          models={models}
          onProviderChange={handleProviderChange}
          onModelChange={setModel}
          messages={messages}
        />
        <Footer
          provider={providerInfo?.label || ''}
          model={model}
          route={route || 'default'}
        />
      </div>
      {flowOpen && <AgentFlow flow={agentFlow} onClose={() => setFlowOpen(false)} />}
    </div>
    </>
  );
}

export default function App() {
  return (
    <>
    <UpdateBanner />
    <Routes>
      <Route path="/" element={<ChatLayout />} />
      <Route path="/settings" element={<Settings />} />
      <Route path="/dashboard" element={<AnalyticsPageNew />} />
      <Route path="/analytics" element={<AnalyticsPageNew />} />
      <Route path="/profile" element={<Profile />} />
      <Route path="/job-agent" element={<JobAgent />} />
      <Route path="/voice" element={<VoiceTalk />} />
      <Route path="/automation" element={<Automation />} />
      <Route path="/worklog" element={<Worklog />} />
      <Route path="/tracking" element={<Tracking />} />
      <Route path="/track" element={<Tracker />} />
      <Route path="/command-center" element={<CommandCenter />} />
      <Route path="/agent-center" element={<AgentCenter />} />
      <Route path="/system-map" element={<Suspense fallback={<div style={{ padding: 24 }}>Memuat peta 3D…</div>}><SystemMapPage /></Suspense>} />
    </Routes>
    </>
  );
}
