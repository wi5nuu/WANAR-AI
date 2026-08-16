/**
 * Footer Component - Enterprise v2.0
 * by Wisnu Alfian Nur Ashar
 */

export default function Footer({ provider, model, route }) {
  return (
    <footer className="footer" style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 'var(--space-sm)',
      padding: '8px var(--space-lg)',
      background: 'var(--bg-glass)',
      backdropFilter: 'blur(10px)',
      borderTop: '1px solid var(--border-secondary)',
      flexWrap: 'wrap'
    }}>
      <span style={{
        fontSize: '11px',
        color: 'var(--text-tertiary)',
        fontWeight: '500'
      }}>
        Powered by{' '}
        <span style={{
          fontWeight: '700',
          background: 'var(--brand-gradient)',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          backgroundClip: 'text'
        }}>
          Powered by Wanar AI v1.0.1 · by Wisnu & Zahra
        </span>
      </span>

      {provider && (
        <>
          <div style={{ width: '1px', height: '12px', background: 'var(--border-secondary)' }} />
          <span style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
            {provider}
            {model && <> · <span style={{ color: 'var(--text-secondary)', fontWeight: '500' }}>{model}</span></>}
            {route && route !== 'default' && <> · {route}</>}
          </span>
        </>
      )}
    </footer>
  );
}
