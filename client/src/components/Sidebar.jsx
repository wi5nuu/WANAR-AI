/**
 * Sidebar Component - Enterprise v2.0
 * by Wisnu Alfian Nur Ashar
 *
 * Sidebar dibuat minimal: logo, New Chat, dan riwayat percakapan.
 * Pengaturan provider/model ada di InputBar, fitur lain ada di menu header.
 */

export default function Sidebar({
  sessions,
  currentId,
  onSwitch,
  onDelete,
  onNew,
  open,
  onClose,
}) {
  const list = sessions || [];

  return (
    <>
      {/* Backdrop untuk mobile — klik di luar menutup sidebar */}
      <div
        className={`sidebar-backdrop ${open ? 'visible' : ''}`}
        onClick={onClose}
        aria-hidden={!open}
      />
      <aside className={`sidebar ${open ? '' : 'hidden'}`} aria-hidden={!open}>
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
            <div className="sidebar-logo-subtitle">v1.0.5</div>
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
          <span>New Chat</span>
        </button>
        <button
          className="sidebar-close-btn"
          onClick={onClose}
          aria-label="Tutup sidebar"
          title="Tutup sidebar"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>

      {/* Sessions List */}
      <div className="sidebar-sessions">
        {list.length > 0 ? (
          list.map(session => (
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
            No conversations yet
          </div>
        )}
      </div>

      {/* Sidebar Footer — versi saja, dibuat samar */}
      <div className="sidebar-footer sidebar-footer-min">
        <span className="sidebar-ver">v1.0.5</span>
      </div>
      </aside>
    </>
  );
}
