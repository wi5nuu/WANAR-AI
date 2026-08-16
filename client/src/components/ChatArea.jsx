/**
 * ChatArea Component - Enterprise v2.0
 * by Wisnu Alfian Nur Ashar
 */

import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import MessageBubble from './MessageBubble';

export default function ChatArea({ messages, processing, onEdit, onQuickAction }) {
  const chatRef = useRef(null);
  const nearBottomRef = useRef(true);

  useEffect(() => {
    const el = chatRef.current;
    if (!el) return;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    nearBottomRef.current = isNearBottom;
    if (isNearBottom || processing) {
      el.scrollTop = el.scrollHeight;
    }
  });

  useEffect(() => {
    const el = chatRef.current;
    if (!el) return;
    const handleScroll = () => {
      const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
      nearBottomRef.current = isNearBottom;
    };
    el.addEventListener('scroll', handleScroll);
    return () => el.removeEventListener('scroll', handleScroll);
  }, []);

  const hasMessages = messages.length > 0;

  return (
    <>
      <div className="chat-container" ref={chatRef}>
        {hasMessages ? (
          <div className="chat-messages">
            {messages.map((message, index) => (
              <MessageBubble 
                key={index} 
                msg={message} 
                index={index} 
                onEdit={onEdit}
                processing={processing && index === messages.length - 1 && message.role === 'assistant' && !message.content}
              />
            ))}
          </div>
        ) : (
          <WelcomeScreen onQuickAction={onQuickAction} />
        )}
      </div>
      
      <ScrollToBottomButton 
        visible={!nearBottomRef.current && hasMessages} 
        onClick={() => {
          chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: 'smooth' });
        }} 
      />
    </>
  );
}

function ScrollToBottomButton({ visible, onClick }) {
  if (!visible) return null;
  
  return (
    <button 
      className="scroll-to-bottom-btn glass"
      onClick={onClick}
      aria-label="Scroll to bottom"
      style={{
        position: 'fixed',
        bottom: '140px',
        right: '32px',
        width: '40px',
        height: '40px',
        borderRadius: '50%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: '1px solid var(--border-primary)',
        cursor: 'pointer',
        boxShadow: 'var(--shadow-lg)',
        transition: 'all var(--transition-fast)',
        zIndex: 50
      }}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <line x1="12" y1="5" x2="12" y2="19"/>
        <polyline points="19 12 12 19 5 12"/>
      </svg>
    </button>
  );
}

function WelcomeScreen({ onQuickAction }) {
  const navigate = useNavigate();

  const quickActions = [
    {
      icon: (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
      ),
      label: 'Scan Lowongan Kerja',
      desc: 'Cari & scan job listing dari Jobstreet, LinkedIn, dll',
      prompt: 'Tolong scan lowongan kerja Full-Stack Engineer di Jobstreet Indonesia untuk saya. Cari posisi yang cocok dengan profil saya.',
      color: '#6366f1',
    },
    {
      icon: (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/>
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
        </svg>
      ),
      label: 'Buka Browser Agent',
      desc: 'Suruh AI browse & extract informasi dari website manapun',
      prompt: 'Tolong buka https://www.jobstreet.co.id dan carikan lowongan Full-Stack Engineer terbaru yang cocok untuk saya.',
      color: '#0ea5e9',
    },
    {
      icon: (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/>
          <line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>
        </svg>
      ),
      label: 'Auto-Apply Lamaran',
      desc: 'Isi form lamaran otomatis menggunakan data profilmu',
      prompt: 'Tolong bantu saya apply ke lowongan kerja. Berikan URL halaman lamaran yang ingin diisi, saya akan gunakan data profil saya untuk auto-fill form.',
      color: '#10b981',
    },
    {
      icon: (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
          <circle cx="12" cy="7" r="4"/>
        </svg>
      ),
      label: 'Lihat Profil Saya',
      desc: 'Kelola data diri & riwayat lamaran kerja',
      action: () => navigate('/profile'),
      color: '#f59e0b',
    },
    {
      icon: (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
        </svg>
      ),
      label: 'Security Testing',
      desc: 'Penetration testing & vulnerability assessment',
      action: () => navigate('/security'),
      color: '#ef4444',
    },
    {
      icon: (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
        </svg>
      ),
      label: 'Code Review',
      desc: 'Review kode, debug, dan optimasi performa',
      prompt: 'Tolong review kode saya dan berikan saran perbaikan. Paste kode yang ingin direview.',
      color: '#8b5cf6',
    },
  ];

  return (
    <div className="welcome-screen fade-in" style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '100%',
      padding: '32px 24px',
      textAlign: 'center',
    }}>
      {/* Logo & Title */}
      <img
        src="/logo.png"
        alt="Wanar AI Logo"
        style={{
          height: '72px',
          width: 'auto',
          objectFit: 'contain',
          marginBottom: '20px',
          filter: 'drop-shadow(0 4px 12px rgba(0,0,0,0.10))'
        }}
      />
      <h1 style={{
        fontSize: '28px',
        fontWeight: '700',
        marginBottom: '6px',
        color: 'var(--text-primary)',
        lineHeight: 1.2,
      }}>
        Selamat datang, <span className="text-gradient">Wisnu</span>
      </h1>
      <p style={{
        fontSize: '14px',
        color: 'var(--text-secondary)',
        marginBottom: '36px',
      }}>
        Wanar AI v1.0.1 — Personal AI Agent kamu siap bekerja
      </p>

      {/* Quick Action Grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
        gap: '12px',
        width: '100%',
        maxWidth: '720px',
        marginBottom: '32px',
      }}>
        {quickActions.map((action, i) => (
          <button
            key={i}
            onClick={() => action.action ? action.action() : onQuickAction?.(action.prompt)}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: '12px',
              padding: '14px 16px',
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border-primary)',
              borderRadius: '12px',
              cursor: 'pointer',
              textAlign: 'left',
              transition: 'all 0.15s ease',
              color: 'var(--text-primary)',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.borderColor = action.color;
              e.currentTarget.style.background = 'var(--bg-tertiary)';
              e.currentTarget.style.transform = 'translateY(-2px)';
              e.currentTarget.style.boxShadow = `0 4px 16px ${action.color}22`;
            }}
            onMouseLeave={e => {
              e.currentTarget.style.borderColor = 'var(--border-primary)';
              e.currentTarget.style.background = 'var(--bg-secondary)';
              e.currentTarget.style.transform = 'translateY(0)';
              e.currentTarget.style.boxShadow = 'none';
            }}
          >
            <div style={{
              width: '38px',
              height: '38px',
              borderRadius: '8px',
              background: action.color + '18',
              color: action.color,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}>
              {action.icon}
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{
                fontSize: '13px',
                fontWeight: '600',
                marginBottom: '3px',
                color: 'var(--text-primary)',
              }}>
                {action.label}
              </div>
              <div style={{
                fontSize: '12px',
                color: 'var(--text-tertiary)',
                lineHeight: 1.4,
              }}>
                {action.desc}
              </div>
            </div>
          </button>
        ))}
      </div>

      <p style={{
        fontSize: '12px',
        color: 'var(--text-tertiary)',
      }}>
        Atau ketik pesan langsung di bawah untuk memulai percakapan
      </p>
    </div>
  );
}
