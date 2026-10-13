#!/usr/bin/env node
/**
 * scripts/verify-realtime.mjs
 *
 * Measures — with real requests, on the real running server — whether the
 * "realtime" claims hold. Nothing is simulated or assumed; every number is a
 * wall-clock measurement printed at the end.
 *
 *   node scripts/verify-realtime.mjs                      # dashboard + SSE
 *   node scripts/verify-realtime.mjs --reminder           # + reminder delivery to Telegram
 *   node scripts/verify-realtime.mjs --email              # + inbound email via IMAP IDLE
 *   node scripts/verify-realtime.mjs --base http://127.0.0.1:3100 --token ...
 *
 * Run it ON the server (loopback needs no token). --reminder sends one real
 * Telegram message to the owner; --email sends one real email to the owner's
 * own mailbox. Both clean up after themselves where possible.
 */

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };

const BASE = opt('base', 'http://127.0.0.1:3100').replace(/\/$/, '');
const TOKEN = opt('token', process.env.AUTOMATION_TOKEN || '');
const H = TOKEN ? { 'X-Automation-Token': TOKEN } : {};
const J = { ...H, 'Content-Type': 'application/json' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ms = (t0) => Math.round(performance.now() - t0);
const results = [];
const record = (name, value, unit, verdict, note = '') => { results.push({ name, value, unit, verdict, note }); };

async function call(path, init = {}) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...(init.method && init.method !== 'GET' ? J : H), ...(init.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, ms: ms(t0) };
}

/** Opens the dashboard SSE stream; resolves events as {source,type,t}. */
async function openEvents() {
  const ac = new AbortController();
  const res = await fetch(`${BASE}/api/command-center/events`, { headers: { ...H, Accept: 'text/event-stream' }, signal: ac.signal });
  if (!res.ok) throw new Error(`SSE ditolak: HTTP ${res.status}`);
  const waiters = [];
  const seen = [];
  (async () => {
    const dec = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (!data) continue;
          let ev;
          try { ev = JSON.parse(data); } catch { continue; }
          const rec = { ...ev, t: performance.now() };
          seen.push(rec);
          for (const w of [...waiters]) if (w.match(rec)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(rec); }
        }
      }
    } catch { /* closed */ }
  })();
  return {
    waitFor(match, timeoutMs = 10_000) {
      return new Promise((resolve) => {
        const hit = seen.find(match);
        if (hit) return resolve(hit);
        const w = { match, resolve };
        waiters.push(w);
        setTimeout(() => { const k = waiters.indexOf(w); if (k >= 0) { waiters.splice(k, 1); resolve(null); } }, timeoutMs);
        return undefined;
      });
    },
    close: () => ac.abort(),
  };
}

const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const tomorrow = () => new Date(Date.now() + 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });

async function main() {
  console.log(`Target: ${BASE}\n`);

  // 1. dashboard payload speed ------------------------------------------------
  const samples = [];
  let first;
  for (let i = 0; i < 7; i++) {
    const r = await call('/api/command-center/overview');
    if (r.status !== 200) throw new Error(`overview HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 120)}`);
    first = first || r.body;
    samples.push(r.ms);
  }
  const med = median(samples);
  record('Muat dashboard (overview)', `${med} ms median (maks ${Math.max(...samples)} ms)`, '', med < 500 ? 'OK' : 'LAMBAT', 'tanpa AI, murni data lokal');

  // 2. SSE push latency -------------------------------------------------------
  const ev = await openEvents();
  await sleep(300);

  const date = tomorrow();
  const t0 = performance.now();
  const add = await call('/api/command-center/reminders', { method: 'POST', body: JSON.stringify({ date, time: '03:00', text: 'verifikasi realtime (otomatis dihapus)' }) });
  if (add.status !== 200) throw new Error(`tambah pengingat gagal: ${JSON.stringify(add.body)}`);
  const id = add.body.reminder.id;
  const pushed = await ev.waitFor((e) => e.t >= t0 && e.source === 'worklog', 8000);
  record('Server -> dashboard (SSE) saat pengingat dibuat', pushed ? `${Math.round(pushed.t - t0)} ms` : 'tidak ada event', '', pushed && pushed.t - t0 < 1000 ? 'OK' : 'GAGAL');

  // read-your-write: the aggregated view must already contain it
  const after = await call('/api/command-center/overview');
  const visible = after.body.work.reminders.some((r) => r.id === id);
  record('Data konsisten setelah event', visible ? 'pengingat langsung terlihat di overview' : 'belum terlihat', '', visible ? 'OK' : 'GAGAL');

  const t1 = performance.now();
  await call(`/api/command-center/reminders/${id}`, { method: 'DELETE' });
  const pushed2 = await ev.waitFor((e) => e.t >= t1 && e.source === 'worklog', 8000);
  record('Server -> dashboard (SSE) saat pengingat dibatalkan', pushed2 ? `${Math.round(pushed2.t - t1)} ms` : 'tidak ada event', '', pushed2 && pushed2.t - t1 < 1000 ? 'OK' : 'GAGAL');

  // 3. reminder delivery to Telegram (optional) -------------------------------
  if (flag('reminder')) {
    const nowIso = new Date();
    const due = new Date(nowIso.getTime() + 75_000);
    const hm = due.toLocaleTimeString('en-GB', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' });
    const day = due.toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
    const r = await call('/api/command-center/reminders', { method: 'POST', body: JSON.stringify({ date: day, time: hm, text: 'Tes verifikasi realtime Wanar AI (abaikan)' }) });
    if (r.status !== 200) throw new Error(`pengingat uji gagal: ${JSON.stringify(r.body)}`);
    const rid = r.body.reminder.id;
    const dueAt = r.body.reminder.at;
    console.log(`Menunggu pengingat uji jatuh tempo pukul ${hm} WIB (maks 3 menit)…`);
    let sentAt = null;
    const deadline = Date.now() + 3 * 60_000;
    while (Date.now() < deadline) {
      await sleep(1000);
      const o = await call('/api/command-center/overview');
      if (!o.body.work.reminders.some((x) => x.id === rid)) { sentAt = Date.now(); break; }
    }
    if (sentAt) {
      const late = Math.max(0, sentAt - dueAt);
      record('Pengingat -> Telegram: keterlambatan dari jam yang dijadwalkan', `${(late / 1000).toFixed(1)} dtk`, '', late <= 35_000 ? 'OK' : 'LAMBAT', 'ticker 30 dtk; tersisa batas teoritis ≤30 dtk');
    } else {
      record('Pengingat -> Telegram', 'tidak terkirim dalam 3 menit', '', 'GAGAL');
    }
  }

  // 4. inbound email via IMAP IDLE (optional) ---------------------------------
  if (flag('email')) {
    const st0 = await call('/api/email-desk/status');
    const imap0 = st0.body.imap;
    const from = st0.body.smtp?.from;
    if (!imap0?.configured || imap0.state !== 'watching' || !from) {
      record('Email masuk (IMAP IDLE)', `pemantau tidak siap (state=${imap0?.state}, from=${from})`, '', 'GAGAL');
    } else {
      const base = imap0.processed;
      const tag = `verifikasi-realtime-${Date.now().toString(36)}`;
      const d = await call('/api/email-desk/drafts', { method: 'POST', body: JSON.stringify({ to: from, subject: `Tes latensi ${tag}`, body: 'Email uji otomatis dari scripts/verify-realtime.mjs. Abaikan.' }) });
      const sendT = performance.now();
      const s = await call(`/api/email-desk/drafts/${d.body.draft.id}/send`, { method: 'POST' });
      if (s.status !== 200 || s.body.dryRun) {
        record('Email masuk (IMAP IDLE)', `kirim gagal / simulasi: ${JSON.stringify(s.body).slice(0, 100)}`, '', 'GAGAL');
      } else {
        const sendMs = ms(sendT);
        let got = null;
        const end = Date.now() + 90_000;
        while (Date.now() < end) {
          await sleep(250);
          const st = await call('/api/email-desk/status');
          if (st.body.imap.processed > base) { got = st.body.imap; break; }
        }
        const total = got ? ms(sendT) : null;
        record('Kirim email via Brevo (API)', `${sendMs} ms`, '', sendMs < 5000 ? 'OK' : 'LAMBAT');
        record('Email masuk Gmail -> terdeteksi server', got ? `${(total / 1000).toFixed(1)} dtk sejak dikirim` : 'tidak terdeteksi dalam 90 dtk', '',
          got && total < 45_000 ? 'OK' : 'GAGAL', got ? `via ${got.lastVia || '?'} (push = IMAP IDLE, poll = pemeriksaan 60 dtk)` : '');
      }
    }
  }

  ev.close();

  // report --------------------------------------------------------------------
  console.log('\nHASIL PENGUKURAN');
  console.log('='.repeat(78));
  for (const r of results) {
    console.log(`[${r.verdict.padEnd(6)}] ${r.name}\n         -> ${r.value}${r.note ? `  (${r.note})` : ''}`);
  }
  console.log('='.repeat(78));
  const bad = results.filter((r) => r.verdict !== 'OK');
  console.log(bad.length ? `${bad.length} pengukuran bermasalah.` : 'Semua pengukuran lolos.');
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => { console.error('Verifikasi gagal:', e.message); process.exit(2); });
