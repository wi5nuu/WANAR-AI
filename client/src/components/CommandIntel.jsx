/**
 * Pusat Kendali — "Intel" panel: live USD/IDR + other currencies, Indonesia macro
 * indicators, top tech headlines, and the nightly self-learning status.
 * Data comes from /api/command-center/intel and /learning (server-cached).
 *
 * by Wisnu Alfian Nur Ashar
 */

import { useState, useEffect, useCallback } from 'react';

const TZ = 'Asia/Jakarta';
const nf0 = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 2 });
const clock = (ms) => (ms ? new Date(ms).toLocaleTimeString('id-ID', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }) : '—');
const dayLabel = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' }) : '—');

function Spark({ points }) {
  if (!points || points.length < 2) return null;
  const vals = points.map((p) => p.idr);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const W = 240;
  const H = 56;
  const xy = vals.map((v, i) => [(i / (vals.length - 1)) * W, H - 6 - ((v - min) / span) * (H - 12)]);
  const d = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const [lx, ly] = xy[xy.length - 1];
  return (
    <svg className="ci-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Tren USD ke IDR ${points.length} hari`}>
      <path d={`${d} L${W},${H} L0,${H} Z`} className="ci-spark-fill" />
      <path d={d} className="ci-spark-line" />
      <circle cx={lx} cy={ly} r="3.5" className="ci-spark-dot" />
    </svg>
  );
}

function fmtValue(i) {
  if (i.value == null) return '—';
  if (i.unit === 'USD') return `US$ ${nf0.format(i.value)}`;
  return `${nf2.format(i.value)}${i.unit}`;
}

export default function CommandIntel({ api }) {
  const [intel, setIntel] = useState(null);
  const [learn, setLearn] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(async (refresh = false) => {
    try {
      const [i, l] = await Promise.all([api(`/intel${refresh ? '?refresh=1' : ''}`), api('/learning')]);
      setIntel(i);
      setLearn(l);
      setErr('');
    } catch (e) {
      setErr(e.message || 'Gagal memuat intel');
    }
  }, [api]);

  useEffect(() => {
    load();
    const t = setInterval(() => load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  const runLearning = async () => {
    setBusy('learn');
    try {
      setLearn(await api('/learning/run', { method: 'POST' }));
    } catch (e) {
      setErr(e.message || 'Gagal menjalankan pembelajaran');
    } finally {
      setBusy('');
    }
  };

  if (!intel && !err) return <div className="au-card au-empty cc-gap">Memuat intel pasar…</div>;
  if (!intel?.enabled && !err) return null;

  const fx = intel?.fx;
  const eco = intel?.economy;
  const tech = intel?.tech;
  const trendClass = fx?.trend === 'weaker' ? 'ci-up' : fx?.trend === 'stronger' ? 'ci-down' : '';
  const last = learn?.last;

  return (
    <section className="ci-wrap cc-gap" aria-label="Intel pasar, ekonomi, dan teknologi">
      {err && <div className="au-alert err">{err}</div>}

      <div className="au-grid cols-2">
        {/* USD / IDR */}
        <div className="au-card ci-fx">
          <h3>
            <span className="cc-title">Kurs Rupiah</span>
            <small>{fx?.ok ? `diperbarui ${clock(fx.updatedAt)}${fx.stale ? ' · data lama' : ''}` : 'tidak tersedia'}</small>
          </h3>
          {fx?.ok ? (
            <>
              <div className="ci-big">
                <span className="cc-tabular">Rp {nf0.format(fx.usdIdr)}</span>
                <em>per 1 USD</em>
              </div>
              <div className={`ci-delta ${trendClass}`}>
                {fx.changePct == null ? 'Perubahan belum tersedia' : (
                  <>
                    {fx.change > 0 ? '▲' : fx.change < 0 ? '▼' : '■'} {nf2.format(Math.abs(fx.change))} ({nf2.format(Math.abs(fx.changePct))}%)
                    <span> · rupiah {fx.trend === 'weaker' ? 'melemah' : fx.trend === 'stronger' ? 'menguat' : 'stabil'}</span>
                  </>
                )}
              </div>
              <Spark points={fx.history} />
              {fx.history?.length > 1 && (
                <div className="ci-range">
                  <span>{dayLabel(fx.history[0].date)}</span>
                  <span>Terendah Rp {nf0.format(fx.rangeLow)} · Tertinggi Rp {nf0.format(fx.rangeHigh)}</span>
                  <span>{dayLabel(fx.history.at(-1).date)}</span>
                </div>
              )}
              <div className="ci-rates">
                {fx.rates.filter((r) => r.code !== 'USD').map((r) => (
                  <div key={r.code} className="ci-rate">
                    <b>{r.code}</b>
                    <span className="cc-tabular">Rp {nf0.format(r.idr)}</span>
                    <small>{r.per > 1 ? `per ${r.per}` : r.name}</small>
                  </div>
                ))}
              </div>
            </>
          ) : <div className="au-muted">Sumber kurs sedang tidak dapat dijangkau. {fx?.error}</div>}
        </div>

        {/* Indonesia economy */}
        <div className="au-card ci-eco">
          <h3>
            <span className="cc-title">Ekonomi Indonesia</span>
            <small>{eco?.ok ? 'World Bank · data tahunan terbaru' : 'tidak tersedia'}</small>
          </h3>
          {eco?.ok ? (
            <div className="ci-eco-grid">
              {eco.indicators.map((i) => (
                <div key={i.key} className="ci-eco-item">
                  <small>{i.label}</small>
                  <b className="cc-tabular">{fmtValue(i)}</b>
                  <span>{i.year ? `data ${i.year}` : 'belum ada data'}</span>
                </div>
              ))}
            </div>
          ) : <div className="au-muted">Data ekonomi belum dapat dimuat. {eco?.error}</div>}

          {intel?.insights?.length > 0 && (
            <ul className="ci-insights">
              {intel.insights.map((t, n) => <li key={n}>{t}</li>)}
            </ul>
          )}
        </div>
      </div>

      <div className="au-grid cols-2 cc-gap">
        {/* Tech */}
        <div className="au-card">
          <h3>
            <span className="cc-title">Teknologi terbaru</span>
            <small>{tech?.ok ? `Hacker News · ${clock(tech.updatedAt)}` : 'tidak tersedia'}</small>
          </h3>
          {tech?.ok ? (
            <div className="au-list">
              {tech.items.map((n) => (
                <a key={n.id} className="au-item ci-news" href={n.url} target="_blank" rel="noopener noreferrer">
                  <div className="t cc-ellipsis">{n.title}</div>
                  <div className="au-muted ci-news-meta">{n.host} · {nf0.format(n.score)} poin · {nf0.format(n.comments)} komentar</div>
                </a>
              ))}
            </div>
          ) : <div className="au-muted">Berita teknologi belum dapat dimuat. {tech?.error}</div>}
        </div>

        {/* Nightly learning */}
        <div className="au-card">
          <h3>
            <span className="cc-title">Belajar otomatis</span>
            <small>tiap {learn?.schedule || '00:00'} {learn?.timezone === 'Asia/Jakarta' ? 'WIB' : learn?.timezone || ''}</small>
          </h3>
          {learn?.enabled ? (
            <>
              <div className="au-row ci-learn-head">
                <span className="au-chip brand">{last ? `Terakhir: ${dayLabel(last.date)} ${clock(last.at)}` : 'Belum pernah berjalan'}</span>
                {last && <span className="au-chip info">{last.lessons.length} pelajaran</span>}
                <button className="au-btn sm" disabled={busy === 'learn'} onClick={runLearning}>
                  {busy === 'learn' ? 'Mempelajari…' : 'Pelajari sekarang'}
                </button>
              </div>
              {last ? (
                <>
                  <div className="ci-learn-stats">
                    <div><b className="cc-tabular">{nf0.format(last.stats.userMessages)}</b><small>pesan dipelajari</small></div>
                    <div><b className="cc-tabular">{nf0.format(last.stats.requests)}</b><small>permintaan AI</small></div>
                    <div><b className="cc-tabular">{nf0.format(last.stats.errors)}</b><small>gagal</small></div>
                    <div><b className="cc-tabular">{nf0.format(last.stats.corrections)}</b><small>koreksi pengguna</small></div>
                  </div>
                  <ul className="ci-lessons">
                    {last.lessons.length ? last.lessons.map((l, n) => (
                      <li key={n}><span className={`ci-tag ${l.kind}`}>{l.kind}</span>{l.text}</li>
                    )) : <li className="au-muted">Belum ada pola yang menonjol — kualitas stabil.</li>}
                  </ul>
                </>
              ) : <div className="au-muted">Setelah tengah malam, agent meninjau percakapan & kegagalan 24 jam terakhir lalu menyuntikkan pelajarannya ke prompt.</div>}
            </>
          ) : <div className="au-muted">Pembelajaran otomatis dimatikan (WANAR_NIGHTLY_LEARNING=false).</div>}
        </div>
      </div>
    </section>
  );
}
