import React, { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import Header from './Header';

// Icon Components
const ChatIcon = ({ color }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M20 2H4C2.9 2 2.01 2.9 2.01 4L2 22L6 18H20C21.1 18 22 17.1 22 16V4C22 2.9 21.1 2 20 2ZM18 14H6V12H18V14ZM18 11H6V9H18V11ZM18 8H6V6H18V8Z" fill={color}/>
  </svg>
);

const AnalyticsIcon = ({ color }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M19 3H5C3.9 3 3 3.9 3 5V19C3 20.1 3.9 21 5 21H19C20.1 21 21 20.1 21 19V5C21 3.9 20.1 3 19 3ZM9 17H7V10H9V17ZM13 17H11V7H13V17ZM17 17H15V13H17V17Z" fill={color}/>
  </svg>
);

const SettingsIcon = ({ color }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M19.14 12.94C19.18 12.64 19.2 12.33 19.2 12C19.2 11.68 19.18 11.36 19.13 11.06L21.16 9.48C21.34 9.34 21.39 9.07 21.28 8.87L19.36 5.55C19.24 5.33 18.99 5.26 18.77 5.33L16.38 6.29C15.88 5.91 15.35 5.59 14.76 5.35L14.4 2.81C14.36 2.57 14.16 2.4 13.92 2.4H10.08C9.84 2.4 9.65 2.57 9.61 2.81L9.25 5.35C8.66 5.59 8.12 5.92 7.63 6.29L5.24 5.33C5.02 5.25 4.77 5.33 4.65 5.55L2.74 8.87C2.62 9.08 2.66 9.34 2.86 9.48L4.89 11.06C4.84 11.36 4.8 11.69 4.8 12C4.8 12.31 4.82 12.64 4.87 12.94L2.84 14.52C2.66 14.66 2.61 14.93 2.72 15.13L4.64 18.45C4.76 18.67 5.01 18.74 5.23 18.67L7.62 17.71C8.12 18.09 8.65 18.41 9.24 18.65L9.6 21.19C9.65 21.43 9.84 21.6 10.08 21.6H13.92C14.16 21.6 14.36 21.43 14.39 21.19L14.75 18.65C15.34 18.41 15.88 18.09 16.37 17.71L18.76 18.67C18.98 18.75 19.23 18.67 19.35 18.45L21.27 15.13C21.39 14.91 21.34 14.66 21.15 14.52L19.14 12.94ZM12 15.6C10.02 15.6 8.4 13.98 8.4 12C8.4 10.02 10.02 8.4 12 8.4C13.98 8.4 15.6 10.02 15.6 12C15.6 13.98 13.98 15.6 12 15.6Z" fill={color}/>
  </svg>
);

const ProfileIcon = ({ color }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 2C6.48 2 2 6.48 2 12C2 17.52 6.48 22 12 22C17.52 22 22 17.52 22 12C22 6.48 17.52 2 12 2ZM12 5C13.66 5 15 6.34 15 8C15 9.66 13.66 11 12 11C10.34 11 9 9.66 9 8C9 6.34 10.34 5 12 5ZM12 19.2C9.5 19.2 7.29 17.92 6 15.98C6.03 13.99 10 12.9 12 12.9C13.99 12.9 17.97 13.99 18 15.98C16.71 17.92 14.5 19.2 12 19.2Z" fill={color}/>
  </svg>
);

const SecurityIcon = ({ color }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z" fill={color}/>
  </svg>
);

const PentestIcon = ({ color }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" fill={color}/>
  </svg>
);

export default function DashboardLayout({ children }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'light');

  React.useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  const menuItems = [
    { path: '/', label: 'Chat', icon: ChatIcon },
    { path: '/dashboard', label: 'Analytics', icon: AnalyticsIcon },
    { path: '/security', label: 'Security', icon: SecurityIcon },
    { path: '/security/professional', label: 'Pentest', icon: PentestIcon },
    { path: '/settings', label: 'Settings', icon: SettingsIcon },
    { path: '/profile', label: 'Profile', icon: ProfileIcon },
  ];

  const isActive = (path) => location.pathname === path;

  return (
    <div style={{ display: 'flex', height: '100vh', background: 'var(--bg-primary)' }}>
      {/* Sidebar */}
      <aside style={{
        width: sidebarOpen ? '240px' : '60px',
        background: 'var(--bg-secondary)',
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
            const iconColor = isActive(item.path) ? 'white' : '#ff9800';
            
            return (
              <button
                key={item.path}
                onClick={() => navigate(item.path)}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  padding: sidebarOpen ? '10px 12px' : '10px',
                  justifyContent: sidebarOpen ? 'flex-start' : 'center',
                  background: isActive(item.path) ? 'var(--brand-gradient)' : 'transparent',
                  border: 'none',
                  color: isActive(item.path) ? 'white' : 'var(--text-secondary)',
                  fontSize: '14px',
                  fontWeight: isActive(item.path) ? '600' : '500',
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                  borderRadius: '8px',
                  marginBottom: '4px',
                }}
                onMouseEnter={(e) => {
                  if (!isActive(item.path)) {
                    e.currentTarget.style.background = 'var(--hover-bg)';
                    e.currentTarget.style.color = 'var(--text-primary)';
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isActive(item.path)) {
                    e.currentTarget.style.background = 'transparent';
                    e.currentTarget.style.color = 'var(--text-secondary)';
                  }
                }}
              >
                <IconComponent color={iconColor} />
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
        <main style={{
          flex: 1,
          overflow: 'auto',
          background: 'var(--bg-primary)',
        }}>
          {children}
        </main>
      </div>
    </div>
  );
}
