/**
 * MessageBubble Component - Enterprise v2.0
 * by Wisnu Alfian Nur Ashar
 */

import { useMemo, useState, useRef, useEffect } from 'react';
import { marked } from 'marked';
// Use the "common" build (~37 popular languages) instead of the full highlight.js
// bundle (190+ languages, ~900 kB). Covers JS/TS/Python/JSON/bash/SQL/etc.; any
// unknown language falls back to highlightAuto over the registered set.
import hljs from 'highlight.js/lib/common';

// Configure marked for better markdown rendering
marked.setOptions({
  breaks: true,
  gfm: true,
  highlight: (code, lang) => {
    if (lang && hljs.getLanguage(lang)) {
      try { 
        return hljs.highlight(code, { language: lang }).value; 
      } catch (error) {
        console.error(`[MessageBubble] Syntax highlighting failed for language "${lang}":`, error.message);
        // Fallback to auto-detection
        return hljs.highlightAuto(code).value;
      }
    }
    return hljs.highlightAuto(code).value;
  },
});

export default function MessageBubble({ msg, index, onEdit, processing }) {
  const isUser = msg.role === 'user';
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(msg.content);
  const [copied, setCopied] = useState(false);
  const textRef = useRef(null);

  useEffect(() => {
    if (editing && textRef.current) {
      textRef.current.focus();
      textRef.current.setSelectionRange(textRef.current.value.length, textRef.current.value.length);
    }
  }, [editing]);

  useEffect(() => {
    setEditText(msg.content);
  }, [msg.content]);

  const handleCopy = async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(msg.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error('[MessageBubble] Failed to copy message to clipboard:', error.message);
      // Fallback: Show user-friendly error notification
      alert('Failed to copy to clipboard. Please try again or copy manually.');
    }
  };

  const handleEdit = (e) => {
    e.stopPropagation();
    setEditText(msg.content);
    setEditing(true);
  };

  const handleSave = () => {
    if (onEdit && editText.trim()) {
      onEdit(index, editText);
    }
    setEditing(false);
  };

  const handleCancel = () => {
    setEditText(msg.content);
    setEditing(false);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSave();
    }
    if (e.key === 'Escape') {
      handleCancel();
    }
  };

  const html = useMemo(() => {
    if (editing) return '';
    if (isUser) {
      return `<p>${escapeHtml(msg.content).replace(/\n/g, '<br>')}</p>`;
    }
    return sanitizeAssistantHtml(marked.parse(msg.content || ''));
  }, [msg.content, isUser, editing]);

  // Format timestamp: jam + tanggal (hanya tanggal shown jika bukan hari ini)
  const { timeLabel, showDate, dateLabel } = useMemo(() => {
    if (!msg.timestamp) return { timeLabel: '', showDate: false, dateLabel: '' };
    const d = new Date(msg.timestamp);
    if (isNaN(d.getTime())) return { timeLabel: '', showDate: false, dateLabel: '' };
    const time = d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    const today = new Date();
    const isToday = d.toDateString() === today.toDateString();
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
    const isYesterday = d.toDateString() === yesterday.toDateString();
    let date = '';
    if (isToday) date = 'Hari ini';
    else if (isYesterday) date = 'Kemarin';
    else date = d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: d.getFullYear() !== today.getFullYear() ? 'numeric' : undefined });
    return { timeLabel: time, showDate: !isToday, dateLabel: date };
  }, [msg.timestamp]);

  return (
    <div className={`message ${isUser ? 'user' : 'assistant'}`}>
      {/* Avatar */}
      <div className="message-avatar">
        {isUser ? (
          'U'
        ) : (
          <img 
            src="/logo.png" 
            alt="AI" 
            style={{ 
              width: '100%', 
              height: '100%', 
              objectFit: 'contain',
              filter: 'none',
              imageRendering: 'auto'
            }} 
          />
        )}
      </div>

      {/* Message Content */}
      <div className="message-content">
        {/* Header */}
        <div className="message-header">
          <span className="message-role">
            {isUser ? 'You' : 'Wanar AI'}
          </span>
          {(timeLabel || showDate) && (
            <span className="message-time" title={dateLabel ? `${dateLabel} · ${timeLabel}` : timeLabel}>
              {showDate && <span className="message-date">{dateLabel}</span>}
              {timeLabel}
            </span>
          )}
        </div>

        {/* Body */}
        <div className="message-body">
          {editing ? (
            <div className="message-edit-container">
              <textarea
                ref={textRef}
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                onKeyDown={handleKeyDown}
                style={{
                  width: '100%',
                  minHeight: '100px',
                  padding: 'var(--space-md)',
                  background: 'var(--bg-tertiary)',
                  border: '1px solid var(--border-primary)',
                  borderRadius: 'var(--radius-md)',
                  color: 'var(--text-primary)',
                  fontSize: '15px',
                  lineHeight: '1.6',
                  resize: 'vertical',
                  fontFamily: 'inherit'
                }}
              />
              <div style={{
                display: 'flex',
                gap: 'var(--space-sm)',
                marginTop: 'var(--space-sm)',
                justifyContent: 'flex-end'
              }}>
                <button
                  onClick={handleCancel}
                  style={{
                    padding: 'var(--space-xs) var(--space-md)',
                    background: 'var(--bg-tertiary)',
                    border: '1px solid var(--border-primary)',
                    borderRadius: 'var(--radius-md)',
                    color: 'var(--text-secondary)',
                    fontSize: '14px',
                    fontWeight: '500',
                    cursor: 'pointer',
                    transition: 'all var(--transition-fast)'
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  style={{
                    padding: 'var(--space-xs) var(--space-md)',
                    background: 'var(--brand-gradient)',
                    border: 'none',
                    borderRadius: 'var(--radius-md)',
                    color: 'white',
                    fontSize: '14px',
                    fontWeight: '600',
                    cursor: 'pointer',
                    transition: 'all var(--transition-fast)'
                  }}
                >
                  Save (Ctrl+Enter)
                </button>
              </div>
            </div>
          ) : (
            <>
              {processing ? (
                <div className="loading-dots">
                  <div className="loading-dot"></div>
                  <div className="loading-dot"></div>
                  <div className="loading-dot"></div>
                </div>
              ) : (
                <>
                  <div 
                    className="message-text"
                    dangerouslySetInnerHTML={{ __html: html }} 
                  />
                  
                  {/* Action Buttons */}
                  <div className="message-actions" style={{
                    display: 'flex',
                    gap: 'var(--space-xs)',
                    marginTop: 'var(--space-sm)',
                    opacity: 0,
                    transition: 'opacity var(--transition-fast)'
                  }}>
                    <MessageActionButton
                      onClick={handleCopy}
                      title={copied ? 'Copied!' : 'Copy'}
                      icon={
                        copied ? (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                            <polyline points="20 6 9 17 4 12"/>
                          </svg>
                        ) : (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                          </svg>
                        )
                      }
                    />
                    
                    {isUser && (
                      <MessageActionButton
                        onClick={handleEdit}
                        title="Edit"
                        icon={
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                          </svg>
                        }
                      />
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function MessageActionButton({ onClick, title, icon }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        background: 'var(--bg-tertiary)',
        border: '1px solid var(--border-secondary)',
        borderRadius: 'var(--radius-sm)',
        padding: 'var(--space-xs)',
        color: 'var(--text-secondary)',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'all var(--transition-fast)'
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--hover-bg)';
        e.currentTarget.style.color = 'var(--text-primary)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'var(--bg-tertiary)';
        e.currentTarget.style.color = 'var(--text-secondary)';
      }}
    >
      {icon}
    </button>
  );
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Sanitasi HTML hasil markdown model agar tidak bisa XSS.
 * Menghapus <script>/<iframe>/<object>/<embed>, event handler on*,
 * dan javascript:/data:text/html URL.
 */
function sanitizeAssistantHtml(html) {
  if (typeof html !== 'string' || !html) return '';
  let out = String(html);
  out = out.replace(/<(script|iframe|object|embed|form|base|link|meta)[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  out = out.replace(/<(script|iframe|object|embed|form|base|link|meta)[^>]*\/?>/gi, '');
  out = out.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  out = out.replace(/(href|src|xlink:href)\s*=\s*("|\')\s*javascript:[^"']*("|\')/gi, '$1="#"');
  out = out.replace(/(href|src)\s*=\s*("|\')\s*data:text\/html[^"']*("|\')/gi, '$1="#"');
  return out;
}
