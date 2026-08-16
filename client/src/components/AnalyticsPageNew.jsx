import React, { useState, useEffect, useCallback, useRef } from 'react';
import DashboardLayout from './DashboardLayout';

// ── Format helpers ──────────────────────────────────────────────
function fmt(n) {
  if (!n && n !== 0) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}
function fmtTime(ms) {
  if (ms == null) return '-';
  if (ms < 1000) return Math.round(ms) + 'ms';
  return (ms / 1000).toFixed(2) + 's';
}
function fmtSpeed(tps) {
  if (!tps && tps !== 0) return '-';
  if (tps >= 1000) return (tps / 1000).toFixed(1) + 'K t/s';
  return tps.toFixed(1) + ' t/s';
}
function fmtDate(str) {
  if (!str) return '-';
  return str.replace('T', ' ').slice(0, 19);
}

const PERIODS = [
  { label: '24j', hours: 24 },
  { label: '7h', hours: 168 },
  { label: '30h', hours: 720 },
  { label: 'Semua', hours: 8760 },
];

const PROVIDER_COLORS = [
  '#f97316', '#6366f1', '#22c55e', '#3b82f6',
  '#a855f7', '#ec4899', '#14b8a6', '#f59e0b',
];

// ── Mini SVG Bar Chart ───────────────────────────────────────────
function BarChart({ data, valueKey, labelKey, color = '#f97316', height = 160 }) {
  const [tooltip, setTooltip] = useState(null);
  const svgRef = useRef(null);

  if (!data || data.length === 0) {
    return (
      <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)', fontSize: 13 }}>
        Belum ada data untuk periode ini
      </div>
    );
  }

  const maxVal = Math.max(...data.map(d => d[valueKey] || 0), 1);
  const barW = Math.max(8, Math.min(40, Math.floor(600 / data.length) - 4));
  const svgW = data.length * (barW + 4);
  const padT = 20, padB = 32;
  const chartH = height - padT - padB;

  return (
    <div style={{ position: 'relative', overflowX: 'auto' }}>
      <svg ref={svgRef} width={Math.max(svgW, 300)} height={height} style={{ display: 'block' }}>
        {/* Y-axis grid lines */}
        {[0, 0.25, 0.5, 0.75, 1].map(f => {
          const y = padT + chartH * (1 - f);
          return (
            <g key={f}>
              <line x1={0} x2={Math.max(svgW, 300)} y1={y} y2={y}
                stroke="var(--border-secondary)" strokeWidth={1} strokeDasharray="3,3" />
              <text x={2} y={y - 3} fontSize={9} fill="var(--text-tertiary)">
                {f === 0 ? '' : fmt(maxVal * f)}
              </text>
            </g>
          );
        })}

        {/* Bars */}
        {data.map((d, i) => {
          const val = d[valueKey] || 0;
          const barH = Math.max(2, (val / maxVal) * chartH);
          const x = i * (barW + 4) + 2;
          const y = padT + chartH - barH;
          return (
            <g key={i}>
              <rect
                x={x} y={y} width={barW} height={barH}
                rx={3}
                fill={color}
                opacity={tooltip?.i === i ? 0.7 : 1}
                style={{ cursor: 'pointer', transition: 'opacity 0.15s' }}
                onMouseEnter={() => setTooltip({ i, val, label: d[labelKey] })}
                onMouseLeave={() => setTooltip(null)}
              />
              {/* X label */}
              <text
                x={x + barW / 2} y={height - 4}
                textAnchor="middle" fontSize={9}
                fill="var(--text-tertiary)"
                transform={data.length > 14 ? `rotate(-40, ${x + barW / 2}, ${height - 4})` : undefined}
              >
                {String(d[labelKey] || '').slice(-5)}
              </text>
            </g>
          );
        })}

        {/* Tooltip */}
        {tooltip && (() => {
          const i = tooltip.i;
          const x = i * (barW + 4) + 2;
          const tx = Math.min(x + barW / 2, Math.max(svgW, 300) - 80);
          return (
            <g>
              <rect x={tx - 2} y={4} width={80} height={28} rx={4}
                fill="var(--bg-primary)" stroke="var(--border-primary)" strokeWidth={1} />
              <text x={tx + 38} y={16} textAnchor="middle" fontSize={10} fill="var(--text-tertiary)">
                {tooltip.label}
              </text>
              <text x={tx + 38} y={28} textAnchor="middle" fontSize={11} fontWeight="700" fill={color}>
                {fmt(tooltip.val)}
              </text>
            </g>
          );
        })()}
      </svg>
    </div>
  );
}

// ── Donut Chart ──────────────────────────────────────────────────
function DonutChart({ data, colors }) {
  const [hovered, setHovered] = useState(null);
  const size = 120, cx = 60, cy = 60, r = 46, innerR = 28;
  const total = data.reduce((s, d) => s + d.value, 0);
  if (total === 0) return null;

  let startAngle = -Math.PI / 2;
  const slices = data.map((d, i) => {
    const angle = (d.value / total) * 2 * Math.PI;
    const endAngle = startAngle + angle;
    const x1 = cx + r * Math.cos(startAngle);
    const y1 = cy + r * Math.sin(startAngle);
    const x2 = cx + r * Math.cos(endAngle);
    const y2 = cy + r * Math.sin(endAngle);
    const xi1 = cx + innerR * Math.cos(startAngle);
    const yi1 = cy + innerR * Math.sin(startAngle);
    const xi2 = cx + innerR * Math.cos(endAngle);
    const yi2 = cy + innerR * Math.sin(endAngle);
    const largeArc = angle > Math.PI ? 1 : 0;
    const path = [
      `M ${x1} ${y1}`,
      `A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`,
      `L ${xi2} ${yi2}`,
      `A ${innerR} ${innerR} 0 ${largeArc} 0 ${xi1} ${yi1}`,
      'Z',
    ].join(' ');
    const slice = { ...d, path, color: colors[i % colors.length], pct: Math.round((d.value / total) * 100) };
    startAngle = endAngle;
    return slice;
  });

  const hov = hovered !== null ? slices[hovered] : null;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
      <svg width={size} height={size}>
        {slices.map((s, i) => (
          <path key={i} d={s.path}
            fill={s.color}
            opacity={hovered !== null && hovered !== i ? 0.5 : 1}
            style={{ cursor: 'pointer', transition: 'opacity 0.15s' }}
            onMouseEnter={() => setHovered(i)}
            onMouseLeave={() => setHovered(null)}
          />
        ))}
        <text x={cx} y={cy - 6} textAnchor="middle" fontSize={11} fill="var(--text-secondary)">
          {hov ? hov.pct + '%' : fmt(total)}
        </text>
        <text x={cx} y={cy + 8} textAnchor="middle" fontSize={9} fill="var(--text-tertiary)">
          {hov ? hov.label : 'total'}
        </text>
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {slices.map((s, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
            onMouseEnter={() => setHovered(i)} onMouseLeave={() => setHovered(null)}>
            <div style={{ width: 10, height: 10, borderRadius: 2, background: s.color, flexShrink: 0 }} />
            <span style={{ fontSize: 12, color: 'var(--text-primary)', fontWeight: 500 }}>{s.label}</span>
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)', marginLeft: 'auto', paddingLeft: 8 }}>
              {fmt(s.value)} ({s.pct}%)
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Stat Card ────────────────────────────────────────────────────
function StatCard({ label, value, sub, color, icon }) {
  return (
    <div style={{
      background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)',
      borderRadius: 14, padding: '18px 20px',
      boxShadow: '0 2px 12px rgba(0,0,0,0.06)',
      display: 'flex', alignItems: 'center', gap: 14,
    }}>
      <div style={{
        width: 48, height: 48, borderRadius: 12,
        background: color + '18', color,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 22, flexShrink: 0,
      }}>
        {icon}
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 600, marginBottom: 2, textTransform: 'uppercase', letterSpacing: '0.4px' }}>{label}</div>
        <div style={{ fontSize: 26, fontWeight: 800, color, lineHeight: 1.1 }}>{value}</div>
        {sub && <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>{sub}</div>}
      </div>
    </div>
  );
}

// ── Main Component ───────────────────────────────────────────────
export default function AnalyticsPageNew() {
  const [hours, setHours] = useState(168);
  const [activePeriod, setActivePeriod] = useState('7h');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [expandedRow, setExpandedRow] = useState(null);
  const [filterProvider, setFilterProvider] = useState('all');
  const [filterStatus, setFilterStatus] = useState('all');
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 15;

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch(`/api/analytics?hours=${hours}`);
      if (!res.ok) throw new Error('API error');
      const json = await res.json();
      setData(json);
      setLastUpdated(new Date());
    } catch (e) {
      console.error('Analytics load failed:', e);
    } finally {
      setLoading(false);
    }
  }, [hours]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(0); setExpandedRow(null); }, [hours, filterProvider, filterStatus]);

  // Auto-refresh every 30s
  useEffect(() => {
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [load]);

  const recent = data?.recent || [];
  const models = data?.models || [];
  const providers = data?.providers || [];
  const hourly = data?.hourly || [];

  // Build daily chart data from hourly (group by date)
  const dailyMap = {};
  hourly.forEach(h => {
    const date = (h.hour || '').slice(0, 8); // YYYYMMDD or date part
    if (!dailyMap[date]) dailyMap[date] = { date, requests: 0, tokens: 0 };
    dailyMap[date].requests += h.count || 0;
    dailyMap[date].tokens += h.tokens || 0;
  });
  const dailyChart = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));

  // Filter recent logs
  const filteredLogs = recent.filter(r => {
    if (filterProvider !== 'all' && r.provider !== filterProvider) return false;
    if (filterStatus !== 'all' && r.status !== filterStatus) return false;
    return true;
  });
  const totalPages = Math.max(1, Math.ceil(filteredLogs.length / PAGE_SIZE));
  const pageItems = filteredLogs.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const allProviders = ['all', ...new Set(recent.map(r => r.provider).filter(Boolean))];

  // Summary stats
  const totalRequests = data?.total || 0;
  const totalTokens = data?.totalTokens || 0;
  const avgResponse = data?.avgResponse || 0;
  const avgSpeed = data?.avgSpeed || 0;
  const totalInput = data?.totalInput || 0;
  const totalOutput = data?.totalOutput || 0;

  const thStyle = {
    padding: '10px 14px', textAlign: 'left', fontSize: 11,
    fontWeight: 700, color: 'var(--text-tertiary)',
    textTransform: 'uppercase', letterSpacing: '0.5px',
    borderBottom: '1px solid var(--border-primary)',
    background: 'var(--bg-tertiary)', whiteSpace: 'nowrap',
  };
  const tdStyle = {
    padding: '10px 14px', fontSize: 12,
    color: 'var(--text-primary)',
    borderBottom: '1px solid var(--border-secondary)',
    verticalAlign: 'middle',
  };

  return (
    <DashboardLayout>
      <div style={{ padding: '24px 20px', maxWidth: 1280, margin: '0 auto', width: '100%' }}>

        {/* ── Header ── */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>
              Analytics Dashboard
            </h1>
            {lastUpdated && (
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 3 }}>
                Diperbarui: {lastUpdated.toLocaleTimeString('id-ID')} · auto-refresh 30s
              </div>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {/* Period buttons */}
            <div style={{ display: 'flex', background: 'var(--bg-secondary)', borderRadius: 8, border: '1px solid var(--border-primary)', padding: 3, gap: 2 }}>
              {PERIODS.map(p => (
                <button key={p.label} onClick={() => { setActivePeriod(p.label); setHours(p.hours); }}
                  style={{
                    padding: '5px 14px', fontSize: 12, fontWeight: 600,
                    borderRadius: 6, border: 'none', cursor: 'pointer',
                    transition: 'all 0.15s',
                    background: activePeriod === p.label ? 'var(--brand-primary)' : 'transparent',
                    color: activePeriod === p.label ? 'white' : 'var(--text-secondary)',
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>

            <button onClick={load} disabled={loading}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                background: loading ? 'var(--bg-tertiary)' : 'none',
                border: '1px solid var(--border-primary)',
                color: loading ? 'var(--text-tertiary)' : 'var(--text-secondary)',
                cursor: loading ? 'not-allowed' : 'pointer',
                fontSize: 12, fontWeight: 500,
                padding: '6px 14px', borderRadius: 8,
              }}
            >
              <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round"
                style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }}>
                <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
              {loading ? 'Memuat...' : 'Refresh'}
            </button>
          </div>
        </div>

        {/* ── Stat Cards ── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 12, marginBottom: 20 }}>
          <StatCard label="Total Request" value={fmt(totalRequests)} sub={`periode ${activePeriod}`} color="var(--brand-primary)" icon="⚡" />
          <StatCard label="Total Token" value={fmt(totalTokens)} sub={`${fmt(totalInput)} input · ${fmt(totalOutput)} output`} color="#6366f1" icon="◈" />
          <StatCard label="Avg Latensi" value={fmtTime(avgResponse)} sub="waktu respons rata-rata" color="#22c55e" icon="◷" />
          <StatCard label="Avg Kecepatan" value={fmtSpeed(avgSpeed)} sub="token per detik" color="#f59e0b" icon="▶" />
        </div>

        {/* ── Charts Row ── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 16, marginBottom: 20, alignItems: 'start' }}>

          {/* Daily Requests Chart */}
          <div style={{
            background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)',
            borderRadius: 14, padding: '18px 20px', boxShadow: '0 2px 12px rgba(0,0,0,0.06)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>
                Request per Hari
              </div>
              <span style={{
                fontSize: 11, fontWeight: 600, padding: '2px 10px', borderRadius: 20,
                background: 'var(--brand-primary)18', color: 'var(--brand-primary)',
              }}>
                {totalRequests} total
              </span>
            </div>
            <BarChart data={dailyChart.length > 0 ? dailyChart : recent.reduce((acc, r) => {
              const date = (r.created_at || '').slice(0, 10);
              const existing = acc.find(d => d.date === date);
              if (existing) { existing.requests++; existing.tokens += r.total_tokens || 0; }
              else acc.push({ date, requests: 1, tokens: r.total_tokens || 0 });
              return acc;
            }, []).sort((a, b) => a.date.localeCompare(b.date))}
              valueKey="requests" labelKey="date" color="var(--brand-primary)" height={160}
            />
          </div>

          {/* Provider Donut */}
          {providers.length > 0 && (
            <div style={{
              background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)',
              borderRadius: 14, padding: '18px 20px', boxShadow: '0 2px 12px rgba(0,0,0,0.06)',
              minWidth: 240,
            }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 14 }}>
                Provider
              </div>
              <DonutChart
                data={providers.map(p => ({ label: p.provider, value: p.count }))}
                colors={PROVIDER_COLORS}
              />
            </div>
          )}
        </div>

        {/* ── Token Chart ── */}
        <div style={{
          background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)',
          borderRadius: 14, padding: '18px 20px', marginBottom: 20, boxShadow: '0 2px 12px rgba(0,0,0,0.06)',
        }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 14 }}>
            Token per Hari
          </div>
          <BarChart data={dailyChart.length > 0 ? dailyChart : recent.reduce((acc, r) => {
            const date = (r.created_at || '').slice(0, 10);
            const existing = acc.find(d => d.date === date);
            if (existing) { existing.requests++; existing.tokens += r.total_tokens || 0; }
            else acc.push({ date, requests: 1, tokens: r.total_tokens || 0 });
            return acc;
          }, []).sort((a, b) => a.date.localeCompare(b.date))}
            valueKey="tokens" labelKey="date" color="#6366f1" height={120}
          />
        </div>

        {/* ── Model Table ── */}
        {models.length > 0 && (
          <div style={{
            background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)',
            borderRadius: 14, marginBottom: 20, boxShadow: '0 2px 12px rgba(0,0,0,0.06)', overflow: 'hidden',
          }}>
            <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border-primary)', fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>
              Penggunaan per Model
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={thStyle}>Model</th>
                    <th style={{ ...thStyle, textAlign: 'right' }}>Request</th>
                    <th style={{ ...thStyle, textAlign: 'right' }}>Token</th>
                    <th style={{ ...thStyle, textAlign: 'right' }}>Avg Speed</th>
                    <th style={{ ...thStyle, width: 140 }}>Porsi</th>
                  </tr>
                </thead>
                <tbody>
                  {models.map((m, i) => {
                    const pct = totalRequests > 0 ? Math.round((m.count / totalRequests) * 100) : 0;
                    return (
                      <tr key={i} style={{ transition: 'background 0.1s' }}
                        onMouseEnter={e => e.currentTarget.style.background = 'var(--hover-bg)'}
                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                        <td style={tdStyle}>
                          <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: 13 }}>{m.model}</div>
                        </td>
                        <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700, color: 'var(--brand-primary)' }}>{fmt(m.count)}</td>
                        <td style={{ ...tdStyle, textAlign: 'right', color: '#6366f1', fontWeight: 600 }}>{fmt(m.tokens)}</td>
                        <td style={{ ...tdStyle, textAlign: 'right', color: '#f59e0b', fontWeight: 600 }}>{fmtSpeed(m.avg_speed)}</td>
                        <td style={tdStyle}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <div style={{ flex: 1, height: 6, background: 'var(--bg-tertiary)', borderRadius: 999, overflow: 'hidden' }}>
                              <div style={{
                                width: pct + '%', height: '100%',
                                background: PROVIDER_COLORS[i % PROVIDER_COLORS.length],
                                borderRadius: 999, transition: 'width 0.6s ease',
                              }} />
                            </div>
                            <span style={{ fontSize: 11, color: 'var(--text-tertiary)', minWidth: 28 }}>{pct}%</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── Logs Table ── */}
        <div style={{
          background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)',
          borderRadius: 14, boxShadow: '0 2px 12px rgba(0,0,0,0.06)', overflow: 'hidden',
        }}>
          {/* Table toolbar */}
          <div style={{
            padding: '12px 20px', borderBottom: '1px solid var(--border-primary)',
            display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', flex: 1 }}>
              Log Request
              <span style={{
                marginLeft: 8, fontSize: 11, fontWeight: 500,
                background: 'var(--bg-tertiary)', color: 'var(--text-tertiary)',
                padding: '2px 8px', borderRadius: 20,
              }}>{filteredLogs.length}</span>
            </span>

            <select value={filterProvider} onChange={e => { setFilterProvider(e.target.value); setPage(0); }}
              style={{
                padding: '5px 10px', fontSize: 12, borderRadius: 7,
                border: '1px solid var(--border-primary)',
                background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', cursor: 'pointer',
              }}>
              {allProviders.map(p => <option key={p} value={p}>{p === 'all' ? 'Semua Provider' : p}</option>)}
            </select>

            <select value={filterStatus} onChange={e => { setFilterStatus(e.target.value); setPage(0); }}
              style={{
                padding: '5px 10px', fontSize: 12, borderRadius: 7,
                border: '1px solid var(--border-primary)',
                background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', cursor: 'pointer',
              }}>
              <option value="all">Semua Status</option>
              <option value="ok">OK</option>
              <option value="error">Error</option>
            </select>
          </div>

          {pageItems.length > 0 ? (
            <>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={thStyle}>Waktu</th>
                      <th style={thStyle}>Provider</th>
                      <th style={thStyle}>Model</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>Input</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>Output</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>Total Token</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>Latensi</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>Speed</th>
                      <th style={{ ...thStyle, textAlign: 'center' }}>Status</th>
                      <th style={{ ...thStyle, width: 20 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageItems.map(r => (
                      <React.Fragment key={r.id}>
                        <tr
                          onClick={() => setExpandedRow(expandedRow === r.id ? null : r.id)}
                          style={{ cursor: 'pointer', transition: 'background 0.1s', background: expandedRow === r.id ? 'var(--bg-tertiary)' : 'transparent' }}
                          onMouseEnter={e => { if (expandedRow !== r.id) e.currentTarget.style.background = 'var(--hover-bg)'; }}
                          onMouseLeave={e => { if (expandedRow !== r.id) e.currentTarget.style.background = 'transparent'; }}
                        >
                          <td style={{ ...tdStyle, fontSize: 11, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
                            {fmtDate(r.created_at)}
                          </td>
                          <td style={{ ...tdStyle, fontSize: 11 }}>
                            <span style={{
                              fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20,
                              background: 'var(--brand-primary)18', color: 'var(--brand-primary)',
                            }}>{r.provider}</span>
                          </td>
                          <td style={{ ...tdStyle, fontSize: 11, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }} title={r.model}>
                            {r.model}
                          </td>
                          <td style={{ ...tdStyle, fontSize: 11, textAlign: 'right', color: 'var(--text-tertiary)' }}>
                            {fmt(r.input_chars)} chr
                          </td>
                          <td style={{ ...tdStyle, fontSize: 11, textAlign: 'right', color: 'var(--text-tertiary)' }}>
                            {fmt(r.output_chars)} chr
                          </td>
                          <td style={{ ...tdStyle, fontSize: 12, textAlign: 'right', fontWeight: 700, color: '#6366f1' }}>
                            {fmt(r.total_tokens)}
                          </td>
                          <td style={{ ...tdStyle, fontSize: 11, textAlign: 'right', color: 'var(--text-secondary)' }}>
                            {fmtTime(r.response_time_ms)}
                          </td>
                          <td style={{ ...tdStyle, fontSize: 11, textAlign: 'right', color: '#f59e0b', fontWeight: 600 }}>
                            {fmtSpeed(r.tokens_per_second)}
                          </td>
                          <td style={{ ...tdStyle, textAlign: 'center' }}>
                            <span style={{
                              fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20,
                              background: r.status === 'ok' ? '#22c55e18' : '#ef444418',
                              color: r.status === 'ok' ? '#22c55e' : '#ef4444',
                              border: `1px solid ${r.status === 'ok' ? '#22c55e44' : '#ef444444'}`,
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
                            <td colSpan={10} style={{ padding: 0, background: 'var(--bg-tertiary)', borderBottom: '1px solid var(--border-primary)' }}>
                              <div style={{ padding: '14px 20px', display: 'flex', flexWrap: 'wrap', gap: 24 }}>
                                <div>
                                  <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>ID</div>
                                  <div style={{ fontSize: 12, fontFamily: 'monospace', color: 'var(--text-primary)' }}>#{r.id}</div>
                                </div>
                                <div>
                                  <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>Waktu Lengkap</div>
                                  <div style={{ fontSize: 12, color: 'var(--text-primary)' }}>{fmtDate(r.created_at)}</div>
                                </div>
                                <div>
                                  <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>Karakter</div>
                                  <div style={{ fontSize: 12, color: 'var(--text-primary)' }}>
                                    {fmt(r.input_chars)} input · {fmt(r.output_chars)} output
                                  </div>
                                </div>
                                <div>
                                  <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>Token</div>
                                  <div style={{ fontSize: 12, color: '#6366f1', fontWeight: 700 }}>{fmt(r.total_tokens)} total</div>
                                </div>
                                <div>
                                  <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>Kecepatan</div>
                                  <div style={{ fontSize: 12, color: '#f59e0b', fontWeight: 700 }}>{fmtSpeed(r.tokens_per_second)}</div>
                                </div>
                                {r.session_id && (
                                  <div>
                                    <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>Session</div>
                                    <div style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--brand-primary)' }}>{r.session_id.slice(0, 20)}...</div>
                                  </div>
                                )}
                                {r.ip && (
                                  <div>
                                    <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>IP</div>
                                    <div style={{ fontSize: 12, fontFamily: 'monospace', color: 'var(--text-secondary)' }}>{r.ip}</div>
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
                  padding: '10px 20px', borderTop: '1px solid var(--border-primary)',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                }}>
                  <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                    {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, filteredLogs.length)} dari {filteredLogs.length}
                  </span>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button disabled={page === 0} onClick={() => setPage(p => p - 1)}
                      style={{
                        padding: '4px 12px', fontSize: 12, fontWeight: 600, borderRadius: 6,
                        border: '1px solid var(--border-primary)', background: 'var(--bg-tertiary)',
                        color: page === 0 ? 'var(--text-tertiary)' : 'var(--text-secondary)',
                        cursor: page === 0 ? 'not-allowed' : 'pointer',
                      }}>‹ Prev</button>
                    {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                      const start = Math.max(0, Math.min(page - 2, totalPages - 5));
                      const p = start + i;
                      return (
                        <button key={p} onClick={() => setPage(p)}
                          style={{
                            padding: '4px 10px', fontSize: 12, fontWeight: 600, borderRadius: 6,
                            border: '1px solid var(--border-primary)', minWidth: 32,
                            background: p === page ? 'var(--brand-primary)' : 'var(--bg-tertiary)',
                            color: p === page ? 'white' : 'var(--text-secondary)',
                            cursor: 'pointer',
                          }}>{p + 1}</button>
                      );
                    })}
                    <button disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}
                      style={{
                        padding: '4px 12px', fontSize: 12, fontWeight: 600, borderRadius: 6,
                        border: '1px solid var(--border-primary)', background: 'var(--bg-tertiary)',
                        color: page >= totalPages - 1 ? 'var(--text-tertiary)' : 'var(--text-secondary)',
                        cursor: page >= totalPages - 1 ? 'not-allowed' : 'pointer',
                      }}>Next ›</button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 14 }}>
              Belum ada request dalam periode ini. Mulai chat dengan AI untuk melihat log.
            </div>
          )}
        </div>

        {/* CSS for spin animation */}
        <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      </div>
    </DashboardLayout>
  );
}
