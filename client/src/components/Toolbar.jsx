/**
 * Toolbar Component - Enterprise v2.0
 * by Wisnu Alfian Nur Ashar
 */

function fmt(n) {
  if (!n && n !== 0) return '0';
  if (n >= 1e8) return (n / 1e6).toFixed(0) + 'M';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}

export default function Toolbar({ onClear, connected, modelCount, usage, config }) {
  const limit = config?.tokens?.dailyLimit || 300000000;
  const u = usage?.today || usage;
  const used = u?.total || 0;
  const pct = Math.min(100, Math.round((used / limit) * 100));

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 'var(--space-sm)',
      padding: '6px var(--space-lg)',
      background: 'var(--bg-primary)',
      flexWrap: 'wrap',
      minHeight: '40px'
    }}>
      {/* Model Count */}
      <span style={{
        fontSize: '12px',
        color: 'var(--text-secondary)',
        fontWeight: '500'
      }}>
        {modelCount} model{modelCount !== 1 ? 's' : ''}
      </span>

      {/* Divider */}
      <div style={{ width: '1px', height: '16px', background: 'var(--border-secondary)' }} />

      {/* Token Usage */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs)' }}>
        <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
          Tokens:
        </span>
        <span style={{
          fontSize: '12px',
          fontWeight: '600',
          color: pct > 80 ? 'var(--error)' : pct > 50 ? 'var(--warning)' : 'var(--text-primary)'
        }}>
          {fmt(used)}
        </span>
        <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>
          / {fmt(limit)}
        </span>
        {/* Progress bar */}
        <div style={{
          width: '60px',
          height: '4px',
          background: 'var(--border-secondary)',
          borderRadius: 'var(--radius-full)',
          overflow: 'hidden'
        }}>
          <div style={{
            width: `${pct}%`,
            height: '100%',
            background: pct > 80 ? 'var(--error)' : pct > 50 ? 'var(--warning)' : 'var(--brand-primary)',
            borderRadius: 'var(--radius-full)',
            transition: 'width var(--transition-base)'
          }} />
        </div>
      </div>

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Clear Button */}
      <button
        onClick={onClear}
        style={{
          fontSize: '12px',
          fontWeight: '500',
          padding: '4px 12px',
          background: 'var(--bg-tertiary)',
          border: '1px solid var(--border-primary)',
          borderRadius: 'var(--radius-md)',
          color: 'var(--text-secondary)',
          cursor: 'pointer',
          transition: 'all var(--transition-fast)'
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'var(--error-bg)';
          e.currentTarget.style.color = 'var(--error)';
          e.currentTarget.style.borderColor = 'var(--error)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'var(--bg-tertiary)';
          e.currentTarget.style.color = 'var(--text-secondary)';
          e.currentTarget.style.borderColor = 'var(--border-primary)';
        }}
      >
        Clear
      </button>
    </div>
  );
}
