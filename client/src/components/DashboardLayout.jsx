import React, { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import Header from './Header';

import AuroraBackground from './AuroraBackground';
import {
  IconChat, IconVoice, IconBolt, IconWorklog, IconChart, IconShield, IconTarget,
  IconFlask, IconSettings, IconUser, IconRadar,
} from './icons';

export default function DashboardLayout({ children }) {
  const navigate = useNavigate();
  const location = useLocation();
  // Phones get the 60px icon rail by default; a 240px sidebar would eat most of the screen.
  const [sidebarOpen, setSidebarOpen] = useState(() =>
    typeof window === 'undefined' ? true : window.innerWidth > 768
  );
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'light');

  React.useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  const menuItems = [
    { path: '/', label: 'Chat', icon: IconChat },
    { path: '/command-center', label: 'Pusat Kendali', icon: IconRadar },
    { path: '/worklog', label: 'Jurnal Kerja', icon: IconWorklog },
    { path: '/automation', label: 'Otomasi', icon: IconBolt },
    { path: '/voice', label: 'Voice Talk', icon: IconVoice },
    { path: '/dashboard', label: 'Analytics', icon: IconChart },
    { path: '/security', label: 'Security', icon: IconShield },
    { path: '/security/professional', label: 'Pentest', icon: IconTarget },
    { path: '/prompt-lab', label: 'Rule Lab', icon: IconFlask },
    { path: '/settings', label: 'Settings', icon: IconSettings },
    { path: '/profile', label: 'Profile', icon: IconUser },
  ];

  const isActive = (path) => location.pathname === path;

  return (
    <div className="dash-root" style={{ display: 'flex', height: '100vh', position: 'relative' }}>
      <AuroraBackground density={55} />
      {/* Phones: tap outside the opened menu to close it */}
      {sidebarOpen && <div className="dash-backdrop" onClick={() => setSidebarOpen(false)} aria-hidden="true" />}
      {/* Sidebar */}
      <aside className="dash-aside" style={{
        width: sidebarOpen ? '240px' : '60px',
        position: 'relative',
        borderRight: '1px solid var(--border-primary)',
        display: 'flex',
        flexDirection: 'column',
        transition: 'width 0.3s ease',
        zIndex: 100,
      }}>
        {/* Logo */}
        <div style={{
          padding: '16px',
          borderBottom: '1px solid var(--border-primary)',
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
        }}>
          <img 
            src="/logo.png" 
            alt="Wanar AI Logo" 
            style={{
              width: '32px',
              height: '32px',
              borderRadius: '8px',
              objectFit: 'cover',
            }}
          />
          {sidebarOpen && (
            <div style={{ fontSize: '15px', fontWeight: '600', color: 'var(--text-primary)' }}>
              Wanar AI
            </div>
          )}
        </div>

        {/* Menu Items */}
        <nav style={{ flex: 1, padding: '12px 8px' }}>
          {menuItems.map((item) => {
            const IconComponent = item.icon;
            const active = isActive(item.path);
            return (
              <button
                key={item.path}
                onClick={() => navigate(item.path)}
                className={`dash-nav ${active ? 'active' : ''} ${sidebarOpen ? '' : 'collapsed'}`}
                aria-current={active ? 'page' : undefined}
                title={sidebarOpen ? undefined : item.label}
              >
                <IconComponent size={19} />
                {sidebarOpen && <span>{item.label}</span>}
              </button>
            );
          })}
        </nav>

        {/* Sidebar Toggle */}
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          style={{
            padding: '12px',
            background: 'none',
            border: 'none',
            borderTop: '1px solid var(--border-primary)',
            color: 'var(--text-tertiary)',
            cursor: 'pointer',
            fontSize: '14px',
            fontWeight: '500',
          }}
        >
          {sidebarOpen ? '←' : '→'}
        </button>
      </aside>

      {/* Main Content */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Header */}
        <Header
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
          theme={theme}
          onThemeToggle={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
          connected={true}
        />

        {/* Page Content */}
        <main className="dash-main" style={{
          flex: 1,
          overflow: 'auto',
          position: 'relative',
        }}>
          {children}
        </main>
      </div>
    </div>
  );
}
