/**
 * Sidebar Component - Enterprise v2.0
 * by Wisnu Alfian Nur Ashar
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

export default function Sidebar({ 
  sessions, 
  currentId, 
  onSwitch, 
  onDelete, 
  onNew, 
  open,
}) {
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');
  
  const filteredSessions = sessions.filter(session =>
    (session.title || '').toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <aside className={`sidebar ${open ? '' : 'hidden'}`}>
      {/* Sidebar Header */}
      <div className="sidebar-header">
        <div className="sidebar-logo">
          <img 
            src="/logo.png" 
            alt="Wanar AI Logo" 
            className="sidebar-logo-image"
            style={{
              height: '32px',
              width: 'auto',
              objectFit: 'contain',
              marginRight: 'var(--space-sm)'
            }}
          />
          <div className="sidebar-logo-text">
            <div className="sidebar-logo-title">Wanar AI</div>
            <div className="sidebar-logo-subtitle">v1.0.1</div>
          </div>
        </div>
        
        <button 
          className="sidebar-new-chat" 
          onClick={onNew}
          aria-label="New chat"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19"/>
            <line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          New Chat
        </button>
      </div>

      {/* Search Bar */}
      <div className="sidebar-search">
        <input 
          type="text"
          className="sidebar-search-input"
          placeholder="Search conversations..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          aria-label="Search conversations"
        />
      </div>

      {/* Sessions List */}
      <div className="sidebar-sessions">
        {filteredSessions.length > 0 ? (
          filteredSessions.map(session => (
            <div 
              key={session.id} 
              className={`sidebar-session ${session.id === currentId ? 'active' : ''}`}
              onClick={() => onSwitch(session.id)}
              role="button"
              tabIndex={0}
              onKeyPress={(e) => {
                if (e.key === 'Enter') onSwitch(session.id);
              }}
              style={{ overflow: 'hidden' }}
            >
              <span
                className="sidebar-session-title"
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  display: 'block',
                  minWidth: 0,
                  flex: 1,
                }}
                title={session.title || 'New conversation'}
              >
                {session.title || 'New conversation'}
              </span>
              <button 
                className="sidebar-session-delete"
                onClick={(e) => { 
                  e.stopPropagation(); 
                  onDelete(session.id); 
                }}
                aria-label="Delete conversation"
                title="Delete conversation"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18"/>
                  <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>
          ))
        ) : (
          <div style={{
            padding: '2rem 1rem',
            color: 'var(--text-tertiary)',
            fontSize: '13px',
            textAlign: 'center'
          }}>
            {searchQuery ? 'No conversations found' : 'No conversations yet'}
          </div>
        )}
      </div>

      {/* Sidebar Footer */}
      <div className="sidebar-footer">
        <button 
          className="sidebar-footer-btn"
          onClick={() => navigate('/settings')}
          title="Settings"
          aria-label="Settings"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M12 1v6m0 6v6m0-12l-5.2 3m10.4 0L12 7m0 10l-5.2-3m10.4 0L12 17"/>
          </svg>
        </button>
        
        <button 
          className="sidebar-footer-btn"
          onClick={() => navigate('/dashboard')}
          title="Analytics Dashboard"
          aria-label="Analytics"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="18" y1="20" x2="18" y2="10"/>
            <line x1="12" y1="20" x2="12" y2="4"/>
            <line x1="6" y1="20" x2="6" y2="14"/>
          </svg>
        </button>
        
        <button 
          className="sidebar-footer-btn"
          onClick={() => navigate('/security')}
          title="Security Testing"
          aria-label="Security Testing"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
          </svg>
        </button>

        <button
          className="sidebar-footer-btn"
          onClick={() => navigate('/profile')}
          title="Profil & Lamaran"
          aria-label="Profil & Lamaran"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
            <circle cx="12" cy="7" r="4"/>
          </svg>
        </button>

        <button
          className="sidebar-footer-btn"
          onClick={() => navigate('/job-agent')}
          title="Job Application Agent"
          aria-label="Job Agent"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="7" width="20" height="14" rx="2"/>
            <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/>
            <line x1="12" y1="12" x2="12" y2="16"/>
            <line x1="10" y1="14" x2="14" y2="14"/>
          </svg>
        </button>
        
        <div style={{
          flex: 1,
          fontSize: '11px',
          color: 'var(--text-tertiary)',
          textAlign: 'right',
          fontWeight: 600
        }}>
          v1.0.1
        </div>
      </div>
    </aside>
  );
}
