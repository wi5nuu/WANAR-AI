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
    // Auto-scroll hanya jika user sudah di dekat bawah atau sedang streaming.
    // Deps eksplisit agar tidak memaksa scroll saat user membaca riwayat.
    if (nearBottomRef.current || processing) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, processing]);

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
          <rect x="3" y="7" width="18" height="13" rx="2.5"/>
          <path d="M8 7V5.5A1.5 1.5 0 0 1 9.5 4h5A1.5 1.5 0 0 1 16 5.5V7"/>
          <path d="M12 11v3l2 1.2"/>
        </svg>
      ),
      label: 'Jurnal Kerja',
      desc: 'Jam kerja, tugas, keuangan & laporan harian',
      action: () => navigate('/worklog'),
      color: '#0ea5e9',
    },
    {
      icon: (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
        </svg>
      ),
      label: 'Otomasi Kerja',
      desc: 'Jadwal harian, email massal & tulis dengan AI',
      action: () => navigate('/automation'),
      color: '#f59e0b',
    },
    {
      icon: (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
          <path d="M9 12l2 2 4-4"/>
        </svg>
      ),
      label: 'Rule Base Simulator',
      desc: 'Uji & simulasi rule set / system prompt secara lokal',
      action: () => navigate('/prompt-lab'),
      color: '#6366f1',
    },
    {
      icon: (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="7" width="20" height="14" rx="2"/>
          <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/>
        </svg>
      ),
      label: 'Auto-Apply Magang',
      desc: 'Cari & lamar posisi magang yang cocok otomatis',
      prompt: 'Tolong carikan lowongan magang (internship) terbaru di Indonesia yang cocok dengan profil saya, lalu bantu saya apply otomatis. Mulai dari scan lowongan yang paling relevan.',
      color: '#10b981',
    },
    {
      icon: (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="23 7 16 12 23 17 23 7"/>
          <rect x="1" y="5" width="15" height="14" rx="2"/>
        </svg>
      ),
      label: 'Nonton YouTube',
      desc: 'Rekomendasi & ringkasan video tech Favoritmu',
      prompt: 'Rekomendasikan video YouTube terbaru dan paling bermanfaat tentang teknologi/AI/programming untuk saya tonton hari ini. Berikan judul, channel, dan kenapa video itu layak ditonton. Kalau saya kasih link video, buatkan ringkasannya.',
      color: '#ef4444',
    },
    {
      icon: (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/>
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
        </svg>
      ),
      label: 'Browsing Web',
      desc: 'Suruh AI browse & rangkum info dari web manapun',
      prompt: 'Saya mau kamu browsing web untuk saya. Tanyakan URL atau topik apa yang ingin saya cari, lalu extract dan rangkum informasi pentingnya.',
      color: '#0ea5e9',
    },
    {
      icon: (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
        </svg>
      ),
      label: 'Bantu Ngoding',
      desc: 'Review kode, debug, dan belajar tech baru',
      prompt: 'Saya mau ngoding. Tanyakan apa yang ingin saya buat, perbaiki, atau pelajari — lalu bantu saya langkah demi langkah dengan contoh kode.',
      color: '#8b5cf6',
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
        Wanar AI v1.0.5 — dibuat oleh Wisnu
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
