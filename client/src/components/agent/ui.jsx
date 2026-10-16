/**
 * Small presentational pieces shared by the Agent Center tabs. No data fetching in here.
 */

export function ScoreRing({ value, size = 52, label = 'cocok' }) {
  const r = (size - 8) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  const tone = v >= 62 ? 'good' : v >= 42 ? 'mid' : 'low';
  return (
    <div className={`ag-ring ${tone}`} style={{ width: size, height: size }} title={`Skor ${label} ${v} dari 100`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} className="trk" />
        <circle cx={size / 2} cy={size / 2} r={r} className="val" strokeDasharray={`${(v / 100) * c} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      </svg>
      <b>{v}</b>
    </div>
  );
}

export function Kpi({ label, value, hint, tone }) {
  return (
    <div className={`ag-kpi ${tone || ''}`}>
      <span className="ag-kpi-v">{value}</span>
      <span className="ag-kpi-l">{label}</span>
      {hint ? <small>{hint}</small> : null}
    </div>
  );
}

export function Badge({ tone = 'neutral', children }) {
  return <span className={`ag-badge t-${tone}`}>{children}</span>;
}

export function Empty({ title, hint, children }) {
  return (
    <div className="ag-empty">
      <strong>{title}</strong>
      {hint ? <p>{hint}</p> : null}
      {children}
    </div>
  );
}

export function Skeleton({ rows = 3 }) {
  return (
    <div className="ag-skel" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => <i key={i} style={{ width: `${92 - i * 14}%` }} />)}
    </div>
  );
}

export function Section({ title, hint, action, children, className = '' }) {
  return (
    <section className={`ag-card ${className}`}>
      <header className="ag-card-h">
        <div><h2>{title}</h2>{hint ? <p>{hint}</p> : null}</div>
        {action || null}
      </header>
      {children}
    </section>
  );
}

export function Chips({ items, tone, max = 3, open = false }) {
  const list = open ? items : items.slice(0, max);
  return list.map((t) => <span key={t} className={`ag-chip ${tone}`}>{t}</span>);
}

export function Filters({ value, onChange, options }) {
  return (
    <div className="ag-filters" role="tablist">
      {options.map(([k, label, count]) => (
        <button key={k || 'all'} type="button" role="tab" aria-selected={value === k} className={value === k ? 'on' : ''} onClick={() => onChange(k)}>
          {label}{count != null ? <em>{count}</em> : null}
        </button>
      ))}
    </div>
  );
}
