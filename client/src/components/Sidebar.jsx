/**
 * Sidebar Component - Enterprise v2.0
 * by Wisnu Alfian Nur Ashar
 *
 * Sidebar dibuat minimal: logo, New Chat, dan riwayat percakapan.
 * Pengaturan provider/model ada di InputBar, fitur lain ada di menu header.
 */

import { useMemo, useState } from 'react';

const DAY = 86_400_000;

/** SQLite stores "YYYY-MM-DD HH:MM:SS" in UTC. */
function toMs(value) {
  if (!value) return 0;
  const t = Date.parse(String(value).includes('T') ? value : `${String(value).replace(' ', 'T')}Z`);
  return Number.isFinite(t) ? t : 0;
}

function groupLabel(ms, now) {
  const startToday = new Date(now);
  startToday.setHours(0, 0, 0, 0);
  const age = startToday.getTime() - ms;
  if (ms >= startToday.getTime()) return 'Hari ini';
  if (age <= DAY) return 'Kemarin';
  if (age <= 7 * DAY) return '7 hari terakhir';
  if (age <= 30 * DAY) return '30 hari terakhir';
  return 'Lebih lama';
}

const GROUP_ORDER = ['Hari ini', 'Kemarin', '7 hari terakhir', '30 hari terakhir', 'Lebih lama'];

export default function Sidebar({
  sessions,
  currentId,
  onSwitch,
  onDelete,
  onCleanup,
  onNew,
  open,
  onClose,
}) {
  const [query, setQuery] = useState('');
  const [cleaning, setCleaning] = useState(false);
  const all = sessions || [];

  // A session with no messages is not a conversation: hide it (except the one
  // currently open) so leftovers never clutter the history.
  const nonEmpty = useMemo(
    () => all.filter((s) => (s.msg_count ?? 1) > 0 || s.id === currentId),
    [all, currentId]
  );
  const emptyCount = all.length - nonEmpty.length;

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const now = Date.now();
    const buckets = new Map();
    for (const s of nonEmpty) {
      if (q && !String(s.title || '').toLowerCase().includes(q)) continue;
      const label = groupLabel(toMs(s.updated_at || s.created_at), now);
      if (!buckets.has(label)) buckets.set(label, []);
      buckets.get(label).push(s);
    }
    return GROUP_ORDER.filter((l) => buckets.has(l)).map((l) => ({ label: l, items: buckets.get(l) }));
  }, [nonEmpty, query]);

  const list = nonEmpty;

  const runCleanup = async () => {
    if (!onCleanup || cleaning) return;
    setCleaning(true);
    try { await onCleanup(); } finally { setCleaning(false); }
  };

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
        {list.length > 6 && (
          <div className="sidebar-search">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Cari percakapan…"
              aria-label="Cari percakapan"
            />
          </div>
        )}
        {list.length > 0 && groups.length === 0 && (
          <div className="sidebar-empty-note">Tidak ada percakapan yang cocok.</div>
        )}
        {list.length > 0 ? (
          groups.map((g) => (
            <div key={g.label} className="sidebar-group">
              <div className="sidebar-group-label">{g.label}</div>
              {g.items.map(session => (
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
              ))}
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

      {emptyCount > 0 && onCleanup && (
        <div className="sidebar-cleanup">
          <button type="button" onClick={runCleanup} disabled={cleaning}>
            {cleaning ? 'Membersihkan…' : `Bersihkan ${emptyCount} sesi kosong`}
          </button>
        </div>
      )}
      </aside>
    </>
  );
}
