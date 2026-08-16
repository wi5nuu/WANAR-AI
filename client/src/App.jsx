import { useState, useEffect, useCallback, useRef } from 'react';
import { Routes, Route, useNavigate } from 'react-router-dom';
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
import AnalyticsPage from './components/AnalyticsPage';
import AnalyticsPageNew from './components/AnalyticsPageNew';
import JobAgent from './components/JobAgent';
import Profile from './components/Profile';
import SecurityTesting from './components/SecurityTesting';
import ProfessionalAttack from './components/ProfessionalAttack';

function ChatLayout() {
  const {
    config, usage, provider, setProvider,
    model, setModel, route, setRoute,
    providerInfo, providerConfig, PROVIDER_MAP, loadConfig,
  } = useConfig();

  const { sessions, currentId, setCurrentId, create, remove, switchTo, reload } = useSessions();
  const [sidebarOpen, setSidebarOpen] = useState(window.innerWidth > 768);
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'light');
  const [connected, setConnected] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  useEffect(() => {
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
  const { messages, processing, status, send, stop, clear, loadMessages, setStatus, updateMessage } = useChat(saveSession);

  const closeSidebarMobile = useCallback(() => {
    if (window.innerWidth <= 768) setSidebarOpen(false);
  }, []);

  const handleSwitchSession = useCallback(async (id) => {
    if (processing) return;
    closeSidebarMobile();
    setStatus({ color: 'var(--yl)', text: 'Memuat...' });
    try {
      const res = await fetch(`/api/sessions/${id}`);
      const data = await res.json();
      loadMessages(data.messages || []);
      setCurrentId(id);
      setStatus({ color: 'var(--gr)', text: 'Ready' });
    } catch {
      setStatus({ color: 'var(--re)', text: 'Gagal memuat sesi' });
    }
  }, [processing, loadMessages, setCurrentId, closeSidebarMobile, setStatus]);

  const handleDeleteSession = useCallback(async (id) => {
    closeSidebarMobile();
    await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
    if (currentId === id) { setCurrentId(null); loadMessages([]); }
    reload();
  }, [currentId, closeSidebarMobile, loadMessages, reload, setCurrentId]);

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

  const handleSend = useCallback(async () => {
    const effectiveRoute = route === null ? '' : (route || '');
    await send(provider, model, effectiveRoute, attachments);
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
    if (!sidebarOpen || window.innerWidth > 768) return;
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
  const providers = Object.entries(PROVIDER_MAP).map(([k, v]) => ({ key: k, label: v.label }));

  return (
    <div className="app">
      <Sidebar
        sessions={sessions}
        currentId={currentId}
        onSwitch={handleSwitchSession}
        onDelete={handleDeleteSession}
        onNew={handleNewChat}
        open={sidebarOpen}
        onSettings={() => navigate('/settings')}
        onAnalytics={() => navigate('/dashboard')}
        onClose={() => setSidebarOpen(false)}
        provider={provider}
        model={model}
        providers={providers}
        models={models}
        onProviderChange={handleProviderChange}
        onModelChange={setModel}
      />
      <div className="main">
        <Header
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen(o => !o)}
          theme={theme}
          onThemeToggle={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
        />
        <Toolbar
          onClear={clear}
          connected={connected}
          modelCount={models.length}
          usage={usage}
          config={config}
        />
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
        />
        <Footer
          provider={providerInfo?.label || ''}
          model={model}
          route={route || 'default'}
        />
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<ChatLayout />} />
      <Route path="/settings" element={<Settings />} />
      <Route path="/dashboard" element={<AnalyticsPageNew />} />
      <Route path="/analytics" element={<AnalyticsPageNew />} />
      <Route path="/profile" element={<Profile />} />
      <Route path="/security" element={<SecurityTesting />} />
      <Route path="/security/professional" element={<ProfessionalAttack />} />
      <Route path="/job-agent" element={<JobAgent />} />
    </Routes>
  );
}
