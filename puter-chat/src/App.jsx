import { useState, useRef, useEffect } from 'react';
import { usePuterChat } from './hooks/usePuterChat';
import './App.css';

function Message({ role, content }) {
  return (
    <div className={`message message--${role}`}>
      <div className="message-avatar">{role === 'user' ? 'You' : 'AI'}</div>
      <div className="message-body">
        <span className="message-role">{role === 'user' ? 'You' : 'Assistant'}</span>
        <div className="message-content">
          {content || (role === 'assistant' ? '…' : '')}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const {
    ready,
    sessions,
    activeId,
    messages,
    model,
    setModel,
    models,
    loading,
    send,
    stop,
    startNewChat,
    switchSession,
    deleteSession,
  } = usePuterChat();

  const [input, setInput] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const endRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  const handleSend = () => {
    if (!input.trim() || loading) return;
    const text = input;
    setInput('');
    send(text);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  if (!ready) {
    return (
      <div className="app app--loading">
        <div className="loader">Loading chat…</div>
      </div>
    );
  }

  return (
    <div className="app">
      <aside className={`sidebar ${sidebarOpen ? 'sidebar--open' : ''}`}>
        <div className="sidebar-header">
          <button type="button" className="btn btn--primary" onClick={startNewChat}>
            + New chat
          </button>
        </div>
        <nav className="session-list">
          {sessions.map(s => (
            <div
              key={s.id}
              className={`session-item ${s.id === activeId ? 'session-item--active' : ''}`}
            >
              <button
                type="button"
                className="session-item-btn"
                onClick={() => switchSession(s.id)}
              >
                {s.title || 'New chat'}
              </button>
              <button
                type="button"
                className="session-item-delete"
                onClick={() => deleteSession(s.id)}
                aria-label="Delete chat"
              >
                ×
              </button>
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span>Powered by Puter.js</span>
          <a href="https://developer.puter.com" target="_blank" rel="noreferrer">
            Docs
          </a>
        </div>
      </aside>

      <main className="main">
        <header className="header">
          <button
            type="button"
            className="btn btn--ghost header-toggle"
            onClick={() => setSidebarOpen(o => !o)}
            aria-label="Toggle sidebar"
          >
            ☰
          </button>
          <h1 className="header-title">Puter AI Chat</h1>
          <select
            className="model-select"
            value={model}
            onChange={e => setModel(e.target.value)}
            disabled={loading}
          >
            {models.map(m => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        </header>

        <div className="chat-area">
          {messages.length === 0 ? (
            <div className="empty-state">
              <h2>What can I help you with?</h2>
              <p>
                No backend, no API keys — Puter.js runs AI directly in your browser.
                Sign in with Puter on your first message.
              </p>
              <div className="suggestions">
                {[
                  'Explain quantum computing simply',
                  'Write a Python fibonacci function',
                  'Plan a weekend trip to Tokyo',
                ].map(s => (
                  <button
                    key={s}
                    type="button"
                    className="suggestion"
                    onClick={() => { setInput(s); inputRef.current?.focus(); }}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="messages">
              {messages.map((m, i) => (
                <Message key={i} role={m.role} content={m.content} />
              ))}
              <div ref={endRef} />
            </div>
          )}
        </div>

        <footer className="input-bar">
          <textarea
            ref={inputRef}
            className="input"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message Puter AI…"
            rows={1}
            disabled={loading}
          />
          {loading ? (
            <button type="button" className="btn btn--stop" onClick={stop}>
              Stop
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--send"
              onClick={handleSend}
              disabled={!input.trim()}
            >
              Send
            </button>
          )}
        </footer>
      </main>
    </div>
  );
}
