import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';

function fmt(n) {
  if (!n && n !== 0) return '0';
  if (n >= 1e8) return (n / 1e6).toFixed(0) + 'M';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}
function fmtTime(ms) {
  if (ms == null) return '-';
  if (ms < 1000) return ms + 'ms';
  return (ms / 1000).toFixed(2) + 's';
}
function fmtSpeed(tps) {
  if (!tps && tps !== 0) return '-';
  if (tps >= 1000) return (tps / 1000).toFixed(1) + 'K t/s';
  return tps.toFixed(1) + ' t/s';
}
function fmtDateTime(str) {
  if (!str) return '-';
  return str.slice(11, 19);
}
function fmtDate(str) {
  if (!str) return '-';
  return str.slice(0, 10) + ' ' + str.slice(11, 19);
}
function shortId(id) {
  if (!id) return '-';
  return id.length > 12 ? id.slice(0, 12) + '...' : id;
}

const PERIODS = [
  { label: 'Today', hours: 24 },
  { label: 'This Week', hours: 168 },
  { label: 'This Month', hours: 720 },
  { label: 'All Time', hours: 8760 },
];

export default function AnalyticsPage() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [hours, setHours] = useState(24);
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [activePeriod, setActivePeriod] = useState('Today');
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [expandedRow, setExpandedRow] = useState(null);
  const [filterProv, setFilterProv] = useState('all');
  const [filterStatus, setFilterStatus] = useState('all');
  const pageSize = 10;

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const url = activePeriod === 'Custom' && customFrom && customTo
        ? `/api/analytics?hours=${hours}&from=${customFrom}&to=${customTo}`
        : `/api/analytics?hours=${hours}`;
      const r = await fetch(url);
      setData(await r.json());
    } catch {} finally { setLoading(false); }
  }, [hours, activePeriod, customFrom, customTo]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(0); setExpandedRow(null); }, [hours, filterProv, filterStatus]);

  const summary = data?.summary || {};
  const requests = data?.requests || [];

  const providers = useMemo(() => {
    const set = new Set(requests.map(r => r.provider).filter(Boolean));
    return ['all', ...Array.from(set)];
  }, [requests]);

  const filtered = useMemo(() => requests.filter(r => {
    if (filterProv !== 'all' && r.provider !== filterProv) return false;
    if (filterStatus !== 'all' && r.status !== filterStatus) return false;
    return true;
  }), [requests, filterProv, filterStatus]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const pageItems = filtered.slice(page * pageSize, (page + 1) * pageSize);

  const cardData = [
    { label: 'Total Requests', value: fmt(summary.total_requests), color: 'var(--brand-primary)', icon: '⚡' },
    { label: 'Total Tokens', value: fmt(summary.total_tokens), color: '#6366f1', icon: '◈' },
    { label: 'Avg Latency', value: fmtTime(summary.avg_response_time_ms), color: '#22c55e', icon: '◷' },
    { label: 'Avg Speed', value: fmtSpeed(summary.avg_tokens_per_second), color: '#f59e0b', icon: '▶' },
  ];

  const thStyle = {
    padding: '10px 12px',
    textAlign: 'left',
    fontSize: '11px',
    fontWeight: '600',
    color: 'var(--text-tertiary)',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
    borderBottom: '1px solid var(--border-primary)',
    background: 'var(--bg-secondary)',
    whiteSpace: 'nowrap',
  };

  const tdStyle = {
    padding: '10px 12px',
    fontSize: '12px',
    color: 'var(--text-primary)',
    borderBottom: '1px solid var(--border-secondary)',
    verticalAlign: 'middle',
  };

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-primary)', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <header style={{
        background: 'var(--bg-glass)',
        backdropFilter: 'blur(20px)',
        borderBottom: '1px solid var(--border-primary)',
        padding: '0 var(--space-lg)',
        height: 'var(--header-height)',
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-md)',
        position: 'sticky',
        top: 0,
        zIndex: 90,
      }}>
        <button
          onClick={() => navigate('/')}
          style={{
            display: 'flex', alignItems: 'center', gap: 'var(--space-xs)',
            background: 'none', border: 'none', color: 'var(--text-secondary)',
            cursor: 'pointer', fontSize: '14px', fontWeight: '500',
            padding: 'var(--space-xs) var(--space-sm)', borderRadius: 'var(--radius-md)',
            transition: 'all var(--transition-fast)',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'var(--hover-bg)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
          Back to Chat
        </button>

        <div style={{ width: '1px', height: '20px', background: 'var(--border-secondary)' }} />

        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
          <img src="/logo.png" alt="Wanar AI" style={{ height: '24px', width: 'auto' }} />
          <span style={{ fontSize: '15px', fontWeight: '700', color: 'var(--text-primary)' }}>Analytics</span>
        </div>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 'var(--space-xs)' }}>
          <button
            onClick={load}
            style={{
              display: 'flex', alignItems: 'center', gap: '6px',
              background: 'none', border: '1px solid var(--border-primary)',
              color: 'var(--text-secondary)', cursor: 'pointer',
              fontSize: '13px', fontWeight: '500',
              padding: '6px 12px', borderRadius: 'var(--radius-md)',
              transition: 'all var(--transition-fast)',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--hover-bg)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
            </svg>
            Refresh
          </button>
        </div>
      </header>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 'var(--space-xl)', maxWidth: '1100px', margin: '0 auto', width: '100%' }}>

        {/* Period Selector */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs)', marginBottom: 'var(--space-lg)', flexWrap: 'wrap' }}>
          {PERIODS.map(p => (
            <button
              key={p.label}
              onClick={() => { setActivePeriod(p.label); setHours(p.hours); }}
              style={{
                padding: '7px 16px', fontSize: '13px', fontWeight: '600',
                borderRadius: 'var(--radius-md)', border: 'none', cursor: 'pointer',
                transition: 'all var(--transition-fast)',
                background: activePeriod === p.label ? 'var(--brand-gradient)' : 'var(--bg-secondary)',
                color: activePeriod === p.label ? 'white' : 'var(--text-secondary)',
                boxShadow: activePeriod === p.label ? 'var(--shadow-sm)' : 'none',
              }}
            >
              {p.label}
            </button>
          ))}
          <button
            onClick={() => setActivePeriod('Custom')}
            style={{
              padding: '7px 16px', fontSize: '13px', fontWeight: '600',
              borderRadius: 'var(--radius-md)', border: 'none', cursor: 'pointer',
              transition: 'all var(--transition-fast)',
              background: activePeriod === 'Custom' ? 'var(--brand-gradient)' : 'var(--bg-secondary)',
              color: activePeriod === 'Custom' ? 'white' : 'var(--text-secondary)',
            }}
          >
            Custom
          </button>

          {activePeriod === 'Custom' && (
            <>
              <input type="datetime-local" value={customFrom} onChange={e => setCustomFrom(e.target.value)}
                style={{ padding: '6px 10px', fontSize: '12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-primary)', background: 'var(--bg-secondary)', color: 'var(--text-primary)' }} />
              <span style={{ color: 'var(--text-tertiary)', fontSize: '12px' }}>to</span>
              <input type="datetime-local" value={customTo} onChange={e => setCustomTo(e.target.value)}
                style={{ padding: '6px 10px', fontSize: '12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-primary)', background: 'var(--bg-secondary)', color: 'var(--text-primary)' }} />
              <button onClick={load} style={{
                padding: '6px 14px', fontSize: '12px', fontWeight: '600',
                background: 'var(--brand-gradient)', color: 'white', border: 'none',
                borderRadius: 'var(--radius-md)', cursor: 'pointer',
              }}>Apply</button>
            </>
          )}
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: 'var(--space-xl)', color: 'var(--text-tertiary)', fontSize: '14px' }}>
            Loading analytics...
          </div>
        ) : (
          <>
            {/* Summary Cards */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--space-md)', marginBottom: 'var(--space-xl)' }}>
              {cardData.map(c => (
                <div key={c.label} style={{
                  background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)',
                  borderRadius: 'var(--radius-xl)', padding: 'var(--space-lg)',
                  boxShadow: 'var(--shadow-sm)', display: 'flex', alignItems: 'center', gap: 'var(--space-md)',
                }}>
                  <div style={{
                    width: '44px', height: '44px', borderRadius: 'var(--radius-lg)',
                    background: c.color + '18', color: c.color,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '20px', flexShrink: 0,
                  }}>
                    {c.icon}
                  </div>
                  <div>
                    <div style={{ fontSize: '12px', color: 'var(--text-tertiary)', fontWeight: '500', marginBottom: '2px' }}>{c.label}</div>
                    <div style={{ fontSize: '22px', fontWeight: '800', color: c.color, lineHeight: 1 }}>{c.value}</div>
                  </div>
                </div>
              ))}
            </div>

            {/* Provider Breakdown */}
            {summary.by_provider && Object.keys(summary.by_provider).length > 0 && (
              <div style={{
                background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)',
                borderRadius: 'var(--radius-xl)', padding: 'var(--space-lg)',
                marginBottom: 'var(--space-lg)', boxShadow: 'var(--shadow-sm)',
              }}>
                <div style={{ fontSize: '14px', fontWeight: '700', color: 'var(--text-primary)', marginBottom: 'var(--space-md)' }}>
                  Provider Breakdown
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
                  {Object.entries(summary.by_provider).map(([prov, stats]) => {
                    const pct = summary.total_requests > 0
                      ? Math.round((stats.count / summary.total_requests) * 100)
                      : 0;
                    return (
                      <div key={prov}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                          <span style={{ fontSize: '13px', fontWeight: '600', color: 'var(--text-primary)', textTransform: 'capitalize' }}>{prov}</span>
                          <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>{fmt(stats.count)} reqs · {fmt(stats.tokens)} tokens</span>
                        </div>
                        <div style={{ height: '6px', background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-full)', overflow: 'hidden' }}>
                          <div style={{
                            height: '100%', width: pct + '%',
                            background: 'var(--brand-gradient)',
                            borderRadius: 'var(--radius-full)',
                            transition: 'width 0.6s ease',
                          }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Requests Table */}
            <div style={{
              background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)',
              borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-sm)', overflow: 'hidden',
            }}>
              {/* Table Header */}
              <div style={{
                padding: 'var(--space-md) var(--space-lg)',
                borderBottom: '1px solid var(--border-primary)',
                display: 'flex', alignItems: 'center', gap: 'var(--space-md)', flexWrap: 'wrap',
              }}>
                <span style={{ fontSize: '14px', fontWeight: '700', color: 'var(--text-primary)', flex: 1 }}>
                  Requests
                  <span style={{
                    marginLeft: '8px', fontSize: '12px', fontWeight: '500',
                    color: 'var(--text-tertiary)', background: 'var(--bg-tertiary)',
                    padding: '2px 8px', borderRadius: 'var(--radius-full)',
                  }}>
                    {filtered.length}
                  </span>
                </span>

                {/* Filters */}
                <select
                  value={filterProv}
                  onChange={e => setFilterProv(e.target.value)}
                  style={{
                    padding: '6px 10px', fontSize: '12px', fontWeight: '500',
                    border: '1px solid var(--border-primary)', borderRadius: 'var(--radius-md)',
                    background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', cursor: 'pointer',
                  }}
                >
                  {providers.map(p => (
                    <option key={p} value={p}>{p === 'all' ? 'All Providers' : p}</option>
                  ))}
                </select>

                <select
                  value={filterStatus}
                  onChange={e => setFilterStatus(e.target.value)}
                  style={{
                    padding: '6px 10px', fontSize: '12px', fontWeight: '500',
                    border: '1px solid var(--border-primary)', borderRadius: 'var(--radius-md)',
                    background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', cursor: 'pointer',
                  }}
                >
                  <option value="all">All Status</option>
                  <option value="ok">OK</option>
                  <option value="error">Error</option>
                </select>
              </div>

              {filtered.length > 0 ? (
                <>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr>
                          <th style={{ ...thStyle, width: 70 }}>Time</th>
                          <th style={{ ...thStyle, width: 100 }}>Session</th>
                          <th style={{ ...thStyle, width: 70 }}>Provider</th>
                          <th style={thStyle}>Model</th>
                          <th style={{ ...thStyle, textAlign: 'right', width: 70 }}>Tokens</th>
                          <th style={{ ...thStyle, textAlign: 'right', width: 70 }}>Latency</th>
                          <th style={{ ...thStyle, textAlign: 'right', width: 70 }}>Speed</th>
                          <th style={{ ...thStyle, textAlign: 'center', width: 60 }}>Status</th>
                          <th style={{ ...thStyle, width: 24 }}></th>
                        </tr>
                      </thead>
                      <tbody>
                        {pageItems.map(r => (
                          <React.Fragment key={r.id}>
                            <tr
                              onClick={() => setExpandedRow(expandedRow === r.id ? null : r.id)}
                              style={{ cursor: 'pointer', transition: 'background var(--transition-fast)' }}
                              onMouseEnter={e => e.currentTarget.style.background = 'var(--hover-bg)'}
                              onMouseLeave={e => e.currentTarget.style.background = expandedRow === r.id ? 'var(--bg-tertiary)' : 'transparent'}
                            >
                              <td style={{ ...tdStyle, fontSize: 11, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>{fmtDateTime(r.created_at)}</td>
                              <td
                                style={{ ...tdStyle, fontSize: 11, fontFamily: 'monospace', color: 'var(--brand-primary)', cursor: 'pointer' }}
                                onClick={e => { e.stopPropagation(); navigate('/?session=' + r.session_id); }}
                              >
                                {shortId(r.session_id)}
                              </td>
                              <td style={{ ...tdStyle, fontSize: 11, fontWeight: 600 }}>{r.provider}</td>
                              <td style={{ ...tdStyle, fontSize: 11, maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.model}>{r.model}</td>
                              <td style={{ ...tdStyle, fontSize: 11, textAlign: 'right' }}>{fmt(r.total_tokens)}</td>
                              <td style={{ ...tdStyle, fontSize: 11, textAlign: 'right', color: 'var(--text-secondary)' }}>{fmtTime(r.response_time_ms)}</td>
                              <td style={{ ...tdStyle, fontSize: 11, textAlign: 'right', color: 'var(--brand-primary)' }}>{fmtSpeed(r.tokens_per_second)}</td>
                              <td style={{ ...tdStyle, textAlign: 'center' }}>
                                <span style={{
                                  fontSize: '10px', fontWeight: '700',
                                  padding: '2px 8px', borderRadius: 'var(--radius-full)',
                                  background: r.status === 'ok' ? '#22c55e18' : '#ef444418',
                                  color: r.status === 'ok' ? '#22c55e' : '#ef4444',
                                  border: `1px solid ${r.status === 'ok' ? '#22c55e' : '#ef4444'}`,
                                }}>
                                  {r.status === 'ok' ? 'OK' : 'ERR'}
                                </span>
                              </td>
                              <td style={{ ...tdStyle, textAlign: 'center', fontSize: 10, color: 'var(--text-tertiary)' }}>
                                {expandedRow === r.id ? '▲' : '▼'}
                              </td>
                            </tr>

                            {expandedRow === r.id && (
                              <tr>
                                <td colSpan={9} style={{ padding: 0, background: 'var(--bg-tertiary)', borderBottom: '1px solid var(--border-primary)' }}>
                                  <div style={{ padding: 'var(--space-md) var(--space-lg)', display: 'flex', flexWrap: 'wrap', gap: 'var(--space-lg)' }}>
                                    <div>
                                      <div style={{ fontSize: '11px', fontWeight: '600', color: 'var(--text-tertiary)', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Full Time</div>
                                      <div style={{ fontSize: '12px', color: 'var(--text-primary)' }}>{fmtDate(r.created_at)}</div>
                                    </div>
                                    <div>
                                      <div style={{ fontSize: '11px', fontWeight: '600', color: 'var(--text-tertiary)', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Session ID</div>
                                      <div style={{ fontSize: '11px', fontFamily: 'monospace', color: 'var(--text-primary)' }}>{r.session_id}</div>
                                    </div>
                                    {r.prompt_tokens != null && (
                                      <div>
                                        <div style={{ fontSize: '11px', fontWeight: '600', color: 'var(--text-tertiary)', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Tokens</div>
                                        <div style={{ fontSize: '12px', color: 'var(--text-primary)' }}>
                                          {fmt(r.prompt_tokens)} prompt + {fmt(r.completion_tokens)} completion = {fmt(r.total_tokens)}
                                        </div>
                                      </div>
                                    )}
                                    {r.error_message && (
                                      <div style={{ flex: '1 1 100%' }}>
                                        <div style={{ fontSize: '11px', fontWeight: '600', color: '#ef4444', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Error</div>
                                        <div style={{ fontSize: '12px', color: '#ef4444', fontFamily: 'monospace' }}>{r.error_message}</div>
                                      </div>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Pagination */}
                  {totalPages > 1 && (
                    <div style={{
                      padding: 'var(--space-md) var(--space-lg)',
                      borderTop: '1px solid var(--border-primary)',
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    }}>
                      <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>
                        Showing {page * pageSize + 1}–{Math.min((page + 1) * pageSize, filtered.length)} of {filtered.length}
                      </span>
                      <div style={{ display: 'flex', gap: 'var(--space-xs)', alignItems: 'center' }}>
                        <button
                          disabled={page === 0}
                          onClick={() => setPage(p => p - 1)}
                          style={{
                            padding: '5px 12px', fontSize: '12px', fontWeight: '600',
                            border: '1px solid var(--border-primary)', borderRadius: 'var(--radius-md)',
                            background: 'var(--bg-tertiary)', color: page === 0 ? 'var(--text-tertiary)' : 'var(--text-secondary)',
                            cursor: page === 0 ? 'not-allowed' : 'pointer',
                          }}
                        >
                          &laquo; Prev
                        </button>

                        {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                          const start = Math.max(0, Math.min(page - 2, totalPages - 5));
                          const p = start + i;
                          return (
                            <button
                              key={p}
                              onClick={() => setPage(p)}
                              style={{
                                padding: '5px 10px', fontSize: '12px', fontWeight: '600',
                                border: '1px solid var(--border-primary)', borderRadius: 'var(--radius-md)',
                                background: p === page ? 'var(--brand-gradient)' : 'var(--bg-tertiary)',
                                color: p === page ? 'white' : 'var(--text-secondary)',
                                cursor: 'pointer', minWidth: '32px',
                              }}
                            >
                              {p + 1}
                            </button>
                          );
                        })}

                        <button
                          disabled={page >= totalPages - 1}
                          onClick={() => setPage(p => p + 1)}
                          style={{
                            padding: '5px 12px', fontSize: '12px', fontWeight: '600',
                            border: '1px solid var(--border-primary)', borderRadius: 'var(--radius-md)',
                            background: 'var(--bg-tertiary)', color: page >= totalPages - 1 ? 'var(--text-tertiary)' : 'var(--text-secondary)',
                            cursor: page >= totalPages - 1 ? 'not-allowed' : 'pointer',
                          }}
                        >
                          Next &raquo;
                        </button>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div style={{ color: 'var(--text-tertiary)', fontSize: '14px', padding: '40px', textAlign: 'center' }}>
                  No requests found. Start chatting with AI to see analytics.
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
