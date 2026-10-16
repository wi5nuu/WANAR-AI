/**
 * Pasar & investasi — live quotes, watchlist, price alerts (to Telegram), a neutral AI
 * digest and a scenario calculator. Information only: it never trades and never
 * tells you to buy or sell.
 *
 * by Wisnu Alfian Nur Ashar
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const rp = (n) => `Rp${Math.round(Number(n) || 0).toLocaleString('id-ID')}`;

function priceText(q) {
  const n = Number(q.price);
  const cur = String(q.currency || '');
  if (cur.startsWith('IDR')) return `Rp${n.toLocaleString('id-ID', { maximumFractionDigits: 0 })}${cur === 'IDR/gram' ? '/g' : ''}`;
  return `${n.toLocaleString('id-ID', { maximumFractionDigits: n < 10 ? 4 : 2 })} ${cur}`.trim();
}

function Spark({ points, up }) {
  if (!points || points.length < 2) return <span className="mk-spark empty" aria-hidden="true" />;
  const w = 74; const h = 24;
  const min = Math.min(...points); const max = Math.max(...points);
  const span = max - min || 1;
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${((i / (points.length - 1)) * w).toFixed(1)},${(h - 2 - ((p - min) / span) * (h - 4)).toFixed(1)}`).join(' ');
  return (
    <svg className="mk-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <path d={d} fill="none" stroke={up ? '#16a34a' : '#dc2626'} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

const OP_LABEL = { gte: 'naik ke / di atas', lte: 'turun ke / di bawah', pct_up: 'naik hari ini ≥ (%)', pct_down: 'turun hari ini ≥ (%)' };

export default function MarketCard({ api, notify }) {
  const [tab, setTab] = useState('watch');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [sym, setSym] = useState('');
  const [alert, setAlert] = useState({ symbol: '', op: 'lte', value: '' });
  const [sim, setSim] = useState({ principal: '1000000', monthly: '0', months: '12', annualPct: '', target: '' });
  const [simOut, setSimOut] = useState(null);
  const [digest, setDigest] = useState(null);
  const timer = useRef(null);

  const load = useCallback(async (force = false) => {
    try {
      const d = await api(`/market${force ? '?force=1' : ''}`);
      setData(d);
      setError('');
    } catch (e) {
      setError(e.message);
    }
  }, [api]);

  useEffect(() => {
    load();
    const tick = () => { if (!document.hidden) load(); };
    timer.current = setInterval(tick, 20000);
    return () => clearInterval(timer.current);
  }, [load]);

  const act = async (key, fn, ok) => {
    setBusy(key);
    try {
      const r = await fn();
      if (ok) notify('ok', typeof ok === 'function' ? ok(r) : ok);
      await load(true);
      return r;
    } catch (e) {
      notify('err', e.message);
      return null;
    } finally {
      setBusy('');
    }
  };

  const quotes = data?.quotes || [];
  const armed = useMemo(() => (data?.alerts || []).filter((a) => a.status === 'armed'), [data]);
  const fired = useMemo(() => (data?.alerts || []).filter((a) => a.status === 'fired').slice(0, 5), [data]);
  const anyDelayed = quotes.some((q) => q.delayed);

  return (
    <div className="au-card cc-gap mk-card">
      <h3>
        <span className="cc-title">📈 Pasar &amp; investasi</span>
        <small>{data?.at ? `diperbarui ${new Date(data.at).toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB` : 'memuat…'}{data?.stale ? ' · data lama (sumber gagal)' : ''}</small>
      </h3>

      <div className="mk-tabs" role="tablist">
        {[['watch', 'Watchlist'], ['alerts', `Alarm harga${armed.length ? ` (${armed.length})` : ''}`], ['sim', 'Simulasi'], ['ai', 'Ringkasan AI']].map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>

      {error && <div className="au-alert err">{error}</div>}

      {tab === 'watch' && (
        <>
          {!data && !error && <div className="au-muted">Memuat harga…</div>}
          <div className="mk-list">
            {quotes.map((q) => {
              const up = (q.changePct ?? 0) >= 0;
              return (
                <div key={q.symbol} className="mk-row">
                  <div className="mk-name">
                    <b>{q.label}</b>
                    <small>{q.symbol}{q.delayed ? ' · tertunda' : ''}</small>
                  </div>
                  <Spark points={q.spark} up={up} />
                  <div className="mk-price">
                    <b>{priceText(q)}</b>
                    <span className={Number.isFinite(q.changePct) ? (up ? 'up' : 'down') : ''}>
                      {Number.isFinite(q.changePct) ? `${up ? '▲' : '▼'} ${Math.abs(q.changePct).toFixed(2)}%` : '—'}
                    </span>
                  </div>
                  <button className="mk-x" aria-label={`Hapus ${q.symbol}`} title="Hapus dari watchlist" disabled={!!busy}
                    onClick={() => act(`rm${q.symbol}`, () => api(`/market/watch/${encodeURIComponent(q.symbol)}`, { method: 'DELETE' }), `${q.symbol} dihapus`)}>×</button>
                </div>
              );
            })}
            {data && quotes.length === 0 && <div className="au-muted">Belum ada data. {(data.errors || []).join('; ')}</div>}
          </div>
          <form className="mk-add" onSubmit={(e) => { e.preventDefault(); if (!sym.trim()) return; act('add', () => api('/market/watch', { method: 'POST', body: { symbol: sym.trim() } }), 'Ditambahkan ke watchlist').then((r) => { if (r) setSym(''); }); }}>
            <input className="au-input" value={sym} onChange={(e) => setSym(e.target.value)} placeholder="tambah kode: BBCA, BTC, EMAS, NASDAQ:AAPL" aria-label="Kode" />
            <button className="au-btn primary" type="submit" disabled={!!busy}>Pantau</button>
            <button className="au-btn" type="button" disabled={!!busy} onClick={() => load(true)}>↻</button>
          </form>
          {(data?.errors?.length > 0) && <div className="au-tiny">Sebagian sumber bermasalah: {data.errors.join('; ')}</div>}
        </>
      )}

      {tab === 'alerts' && (
        <>
          <div className="au-muted">Dicek tiap menit di server. Saat tersentuh, dikabari ke Telegram (sekali jalan).</div>
          <div className="au-list">
            {armed.length === 0 && <div className="au-muted">Belum ada alarm. Atau lewat Telegram: "kabari kalau BBCA di bawah 6000".</div>}
            {armed.map((a) => (
              <div key={a.id} className="au-item">
                <div className="cc-ellipsis">
                  <div className="t">{a.symbol} <span className="au-chip info">{a.opLabel} {a.op.startsWith('pct') ? `${a.value}%` : Number(a.value).toLocaleString('id-ID')}</span></div>
                </div>
                <div className="au-actions"><button className="au-btn sm danger" disabled={!!busy} onClick={() => act(`da${a.id}`, () => api(`/market/alerts/${a.id}`, { method: 'DELETE' }), 'Alarm dihapus')}>Hapus</button></div>
              </div>
            ))}
          </div>
          <form className="mk-alertform" onSubmit={(e) => { e.preventDefault(); act('alert', () => api('/market/alerts', { method: 'POST', body: { symbol: alert.symbol, op: alert.op, value: Number(String(alert.value).replace(/\./g, '').replace(',', '.')) } }), 'Alarm dipasang').then((r) => { if (r) setAlert((x) => ({ ...x, value: '' })); }); }}>
            <select className="au-input" value={alert.symbol} onChange={(e) => setAlert({ ...alert, symbol: e.target.value })} required aria-label="Kode">
              <option value="">kode…</option>
              {(data?.watchlist || []).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <select className="au-input" value={alert.op} onChange={(e) => setAlert({ ...alert, op: e.target.value })} aria-label="Jenis alarm">
              {Object.entries(OP_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <input className="au-input" inputMode="decimal" value={alert.value} onChange={(e) => setAlert({ ...alert, value: e.target.value })} placeholder="nilai" required aria-label="Nilai" />
            <button className="au-btn primary" type="submit" disabled={!!busy}>Pasang</button>
          </form>
          {fired.length > 0 && (
            <>
              <div className="au-tiny" style={{ marginTop: '0.6rem' }}>Terpicu terakhir</div>
              {fired.map((a) => (
                <div key={a.id} className="mk-fired">
                  <span>{a.symbol} {a.opLabel} {a.op.startsWith('pct') ? `${a.value}%` : Number(a.value).toLocaleString('id-ID')}</span>
                  <small>{a.fired_at ? new Date(a.fired_at).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }) : ''} · {Number(a.fired_price).toLocaleString('id-ID')}</small>
                </div>
              ))}
            </>
          )}
        </>
      )}

      {tab === 'sim' && (
        <>
          <div className="au-muted">Kalkulator dari asumsi Anda sendiri — bukan prediksi. Kosongkan imbal hasil untuk melihat tiga ilustrasi.</div>
          <form className="mk-sim" onSubmit={async (e) => {
            e.preventDefault();
            const r = await act('sim', () => api('/market/scenario', { method: 'POST', body: sim }));
            if (r) setSimOut(r);
          }}>
            <label>Modal awal (Rp)<input className="au-input" inputMode="numeric" value={sim.principal} onChange={(e) => setSim({ ...sim, principal: e.target.value })} /></label>
            <label>Setoran per bulan (Rp)<input className="au-input" inputMode="numeric" value={sim.monthly} onChange={(e) => setSim({ ...sim, monthly: e.target.value })} /></label>
            <label>Lama (bulan)<input className="au-input" inputMode="numeric" value={sim.months} onChange={(e) => setSim({ ...sim, months: e.target.value })} /></label>
            <label>Asumsi imbal hasil (%/tahun)<input className="au-input" inputMode="decimal" placeholder="mis. 8" value={sim.annualPct} onChange={(e) => setSim({ ...sim, annualPct: e.target.value })} /></label>
            <label>Target nilai (Rp, opsional)<input className="au-input" inputMode="numeric" value={sim.target} onChange={(e) => setSim({ ...sim, target: e.target.value })} /></label>
            <button className="au-btn primary" type="submit" disabled={!!busy}>Hitung</button>
          </form>
          {simOut && (
            <div className="mk-simout">
              {simOut.results.map((r) => (
                <div key={r.id} className="mk-sim-row">
                  <b>{r.label}</b>
                  <div>Disetor total <b>{rp(r.contributed)}</b> → nilai akhir <b>{rp(r.finalValue)}</b></div>
                  <div className={r.gain >= 0 ? 'up' : 'down'}>Selisih {r.gain >= 0 ? '+' : ''}{rp(r.gain)} ({r.gainPct}%) dalam {r.months} bulan</div>
                  {r.monthsToTarget && <div className="au-tiny">Mencapai target ±{r.monthsToTarget} bulan</div>}
                </div>
              ))}
              <div className="au-tiny">{simOut.disclaimer}</div>
            </div>
          )}
        </>
      )}

      {tab === 'ai' && (
        <>
          <div className="au-muted">Ringkasan netral dari data di atas: apa yang naik/turun dan hal yang perlu dicermati. Tanpa rekomendasi beli/jual.</div>
          <button className="au-btn primary" disabled={!!busy} onClick={async () => { const r = await act('digest', () => api('/market/digest', { method: 'POST' })); if (r) setDigest(r); }}>
            {busy === 'digest' ? 'Menyusun…' : 'Buat ringkasan sekarang'}
          </button>
          {digest && <pre className="cc-brief" style={{ marginTop: '0.7rem' }}>{digest.text}{digest.ai ? '' : '\n\n(ringkasan otomatis dari data; AI tidak tersedia)'}</pre>}
          <div className="au-tiny">Atau di Telegram: "ringkas pasar".</div>
        </>
      )}

      <div className="au-tiny mk-disc">Informasi pasar, bukan nasihat investasi. {anyDelayed ? 'Data bursa Indonesia bisa tertunda ±10–15 menit. ' : ''}Tidak ada jaminan untung; investasi bisa rugi.</div>
    </div>
  );
}
