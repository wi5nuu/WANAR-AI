/**
 * Human-readable explanations for the live system map: every trace step in
 * plain Indonesian ("Mode Dasar") plus the raw facts ("Mode Teknis"), and the
 * one-sentence answer to "kenapa model ini yang dipakai?".
 *
 * by Wisnu Alfian Nur Ashar
 */

export const CHANNEL_META = {
  web: { label: 'Chat Web', icon: '💬', color: '#38bdf8' },
  telegram: { label: 'Telegram', icon: '✈️', color: '#2aabee' },
  email: { label: 'Email Desk', icon: '📧', color: '#f472b6' },
  companion: { label: 'Sapaan Peka', icon: '💛', color: '#facc15' },
  briefing: { label: 'Briefing Pagi', icon: '🌅', color: '#fb923c' },
  automation: { label: 'Otomasi', icon: '⚙️', color: '#a3e635' },
  system: { label: 'Sistem', icon: '🧩', color: '#94a3b8' },
};

export const FAIL_REASON = {
  quota: 'kuota/kredit habis',
  rate: 'terlalu banyak permintaan (rate limit)',
  token: 'teks terlalu panjang untuk model ini',
  auth: 'API key ditolak / belum benar',
  server: 'server provider sedang bermasalah',
  network: 'koneksi ke provider putus / timeout',
  empty: 'model menjawab kosong',
  unknown: 'error lain',
  circuit: 'provider sedang dikarantina karena gagal beruntun',
  cooldown: 'masih masa jeda setelah gagal',
  not_configured: 'API key belum diisi',
};

const CHAIN_REASON = {
  primary: 'pilihan utama',
  'same-provider': 'cadangan: model lain di provider yang sama',
  'cross-provider': 'cadangan: provider lain (urut tier & kesehatan)',
  failover: 'cadangan',
};

const ROUTE_SOURCE = {
  default: (p) => `Tidak ada pilihan khusus, jadi memakai provider default sistem (${p}).`,
  'web-form': () => 'Dipilih langsung di form Provider/Model aplikasi web.',
  request: () => 'Ditentukan oleh fitur yang memanggil AI.',
};

export function fmtMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return '-';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} dtk`;
  return `${Math.floor(ms / 60_000)} mnt ${Math.round((ms % 60_000) / 1000)} dtk`;
}

export function fmtNum(n) {
  return Number(n || 0).toLocaleString('id-ID');
}

export function fmtClock(at) {
  if (!at) return '-';
  return new Date(at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Jakarta' });
}

export function untilText(until) {
  if (!until) return '';
  const left = until - Date.now();
  if (left <= 0) return 'sudah pulih';
  return `pulih ${fmtClock(until)} (±${fmtMs(left)})`;
}

export function skipText(skip) {
  if (!skip) return 'siap';
  const why = FAIL_REASON[skip.why] || skip.why;
  return skip.until ? `dilewati: ${why} — ${untilText(skip.until)}` : `dilewati: ${why}`;
}

export const STATUS_LABEL = { running: 'berjalan', ok: 'selesai', error: 'gagal', stopped: 'dihentikan' };

/** One step → { icon, title, text, tone, data } */
export function explainStep(ev, { tech = false } = {}) {
  const pm = [ev.provider, ev.model].filter(Boolean).join(' / ');
  switch (ev.type) {
    case 'receive': {
      const ch = CHANNEL_META[ev.channel]?.label || ev.channel;
      const kind = ev.kind === 'command' ? `perintah /${ev.command}` : 'pesan';
      return {
        icon: '📥', tone: 'in', title: `Diterima dari ${ch}`,
        text: `${kind[0].toUpperCase() + kind.slice(1)} ${fmtNum(ev.chars)} karakter${ev.history != null ? `, ${ev.history} pesan sebelumnya ikut dibaca sebagai ingatan` : ''}${ev.from ? ` · dari ${ev.from}` : ''}.`,
      };
    }
    case 'intent':
      return {
        icon: ev.model ? '🧠' : '⚡', tone: ev.model ? 'think' : 'code',
        title: ev.model ? 'Keputusan: perlu AI' : 'Keputusan: ditangani kode (tanpa AI)',
        text: `${ev.detail || ev.name}${ev.model ? '' : ' — 0 token, instan.'}`,
        data: tech ? { intent: ev.name, ...(ev.context ? { konteks: ev.context } : {}), ...(ev.signals ? { sinyal: ev.signals } : {}) } : (ev.signals ? { sinyal: ev.signals } : null),
      };
    case 'context':
      return {
        icon: '📚', tone: 'think', title: 'Menyiapkan konteks untuk AI',
        text: `${ev.messages} pesan + instruksi sistem ${fmtNum(ev.systemChars)} karakter ≈ ${fmtNum(ev.promptTokens)} token masuk${ev.temperature != null ? ` · suhu ${ev.temperature}` : ''}${ev.maxTokens ? ` · maks jawaban ${fmtNum(ev.maxTokens)} token` : ''}.`,
      };
    case 'route': {
      const src = (ROUTE_SOURCE[ev.source] || ROUTE_SOURCE.request)(ev.defaultProvider);
      const ready = (ev.chain || []).filter((c) => !c.skip && c.available !== false).length;
      return {
        icon: '🧭', tone: 'route', title: `Rute: minta ${[ev.requested?.provider, ev.requested?.model].filter(Boolean).join(' / ')}`,
        text: `${src} Antrian cadangan disiapkan: ${fmtNum(ev.total)} kandidat (${ready} dari ${ev.chain?.length || 0} teratas siap dipakai).`,
        chain: ev.chain || [],
      };
    }
    case 'skip':
      return { icon: '⏭️', tone: 'warn', title: `Lewati ${pm}`, text: `Tidak dicoba karena ${FAIL_REASON[ev.why] || ev.why}${ev.until ? ` — ${untilText(ev.until)}` : ''}.` };
    case 'attempt':
      return {
        icon: '🚀', tone: 'route', title: `Kirim ke ${pm}`,
        text: `${CHAIN_REASON[ev.reason] || ev.reason || 'kandidat'} (urutan #${(ev.index ?? 0) + 1}${ev.round > 1 ? `, ronde ${ev.round} setelah tool` : ''}).`,
      };
    case 'first_token':
      return { icon: '⚡', tone: 'ok', title: 'Token pertama tiba', text: `${ev.provider} mulai menjawab setelah ${fmtMs(ev.ms)}.` };
    case 'fail':
      return { icon: '💥', tone: 'err', title: `Gagal di ${pm}`, text: `Penyebab: ${FAIL_REASON[ev.reason] || ev.reason} (${fmtMs(ev.ms)}). Sistem otomatis pindah ke kandidat berikutnya.`, data: tech ? { error: ev.error } : null, raw: ev.error };
    case 'success':
      return { icon: '✅', tone: 'ok', title: `Jawaban dari ${pm}`, text: `Selesai dalam ${fmtMs(ev.ms)} · ${fmtNum(ev.chars)} karakter.`, raw: ev.preview };
    case 'usage':
      return {
        icon: '🪙', tone: 'info', title: 'Pemakaian token',
        text: `Masuk ${fmtNum(ev.prompt)} + keluar ${fmtNum(ev.completion)} = ${fmtNum((ev.prompt || 0) + (ev.completion || 0))} token · ${ev.estimated ? 'perkiraan (provider tidak melaporkan angka pasti)' : 'angka asli dari provider'}.`,
      };
    case 'tool_plan':
      return { icon: '🛠️', tone: 'tool', title: 'AI memutuskan memakai alat', text: (ev.tools || []).join(', ') || '-' };
    case 'tool_start':
      return { icon: '🔧', tone: 'tool', title: `Menjalankan alat: ${ev.name}`, text: 'Argumen dikirim ke alat.', raw: ev.args };
    case 'tool_end':
      return { icon: ev.ok ? '🔩' : '⚠️', tone: ev.ok ? 'tool' : 'err', title: `Alat ${ev.name} ${ev.ok ? 'selesai' : 'gagal'}`, text: `Durasi ${fmtMs(ev.ms)}. Hasilnya dikirim balik ke AI.`, raw: ev.result };
    case 'plan':
      return {
        icon: '📝', tone: 'think', title: ev.parsed ? 'Rencana AI terbaca' : 'Rencana AI tidak terbaca',
        text: `${ev.actions?.length ? `Aksi: ${ev.actions.join(', ')}.` : 'Tanpa aksi (hanya jawaban).'}${ev.attempts > 1 ? ' Butuh 1x koreksi format.' : ''}`,
        raw: ev.reply,
      };
    case 'actions':
      return { icon: '⚙️', tone: ev.failed ? 'warn' : 'ok', title: `Aksi dijalankan (${ev.ok} berhasil${ev.failed ? `, ${ev.failed} gagal` : ''})`, text: (ev.results || []).join('\n') };
    case 'fallback':
      return { icon: '🛟', tone: 'warn', title: 'Jalur cadangan', text: ev.detail || ev.name };
    case 'deliver': {
      const where = ev.channel === 'telegram' ? 'Telegram' : ev.channel === 'web' ? 'layar chat web' : ev.channel;
      if (ev.ok === false) return { icon: '📭', tone: 'err', title: `Gagal dikirim ke ${where}`, text: ev.note || ev.error || 'Pengiriman gagal.' };
      const what = ev.kind === 'check-in' ? 'Sapaan' : ev.kind === 'briefing' ? 'Briefing' : ev.kind === 'outgoing' ? 'Pesan inisiatif' : 'Jawaban';
      return { icon: '📤', tone: 'out', title: `${what} terkirim ke ${where}`, text: `${fmtNum(ev.chars)} karakter${ev.parts > 1 ? ` dalam ${ev.parts} bagian` : ''}${ev.fallback ? ' (pesan maaf otomatis)' : ''}.` };
    }
    case 'all_failed':
      return { icon: '🛑', tone: 'err', title: 'Semua kandidat gagal', text: ev.error || '' };
    case 'error':
      return { icon: '⚠️', tone: 'err', title: 'Error', text: ev.error || '' };
    case 'truncated':
      return { icon: '…', tone: 'info', title: 'Langkah lain dipotong', text: 'Jejak terlalu panjang; langkah berikutnya tidak disimpan.' };
    default:
      return { icon: '•', tone: 'info', title: ev.type, text: '' };
  }
}

/** "Kenapa model ini?" — one sentence from the real events. */
export function whyThisModel(trace) {
  const ev = trace?.events || [];
  const route = ev.find((e) => e.type === 'route');
  const success = [...ev].reverse().find((e) => e.type === 'success');
  const intents = ev.filter((e) => e.type === 'intent');
  if (!route) {
    if (intents.length && intents.every((i) => !i.model)) return 'Permintaan ini ditangani langsung oleh kode Wanar (tanpa model AI), jadi tidak memakai token sama sekali.';
    return null;
  }
  const fails = ev.filter((e) => e.type === 'fail');
  const skips = ev.filter((e) => e.type === 'skip');
  const req = [route.requested?.provider, route.requested?.model].filter(Boolean).join(' / ');
  const src = route.source === 'web-form' ? 'yang dipilih di form' : route.source === 'default' ? 'provider default sistem' : 'yang diminta fitur';
  if (!success) return `Semua kandidat gagal. Yang diminta: ${req} (${src}).`;
  const used = [success.provider, success.model].filter(Boolean).join(' / ');
  const firstAttempt = ev.find((e) => e.type === 'attempt');
  if (!fails.length && !skips.length && firstAttempt && firstAttempt.provider === route.requested?.provider) {
    return `Memakai ${used} karena itu ${src} dan dalam keadaan sehat — langsung berhasil di percobaan pertama.`;
  }
  const parts = [];
  // group by provider so a long failover chain stays readable
  const failBy = new Map();
  for (const f of fails) {
    const k = `${f.provider}|${FAIL_REASON[f.reason] || f.reason}`;
    failBy.set(k, (failBy.get(k) || 0) + 1);
  }
  for (const [k, n] of failBy) {
    const [prov, why] = k.split('|');
    parts.push(n > 1 ? `${prov} gagal ${n}× (${why})` : `${prov} gagal (${why})`);
  }
  const skipBy = new Map();
  for (const sk of skips) {
    const k = `${sk.provider}|${FAIL_REASON[sk.why] || sk.why}`;
    skipBy.set(k, (skipBy.get(k) || 0) + 1);
  }
  for (const [k, n] of skipBy) {
    const [prov, why] = k.split('|');
    parts.push(`${prov} dilewati${n > 1 ? ` (${n} model)` : ''} — ${why}`);
  }
  const shown = parts.slice(0, 5).join('; ');
  const more = parts.length > 5 ? `; dan ${parts.length - 5} kejadian lain` : '';
  return `Diminta ${req} (${src}), tetapi ${shown}${more}. Router lalu memakai ${used} — kandidat sehat berikutnya menurut urutan tier.`;
}

/** Provider health → { tone, text } */
export function providerStatus(p) {
  if (!p.configured) return { tone: 'off', text: 'API key belum diisi' };
  if (p.health?.down) return { tone: 'err', text: `API key ditolak — ${untilText(p.health.downUntil)}` };
  if (p.health?.circuitOpen) return { tone: 'err', text: 'Dikarantina sementara (gagal beruntun)' };
  const cooling = (p.models || []).filter((m) => m.skip);
  if (cooling.length && cooling.length >= (p.models || []).length) return { tone: 'warn', text: `Semua model jeda: ${FAIL_REASON[cooling[0].skip.why] || cooling[0].skip.why}` };
  if (cooling.length) return { tone: 'warn', text: `${cooling.length} model sedang jeda` };
  if (p.health?.consecutiveFails) return { tone: 'warn', text: `${p.health.consecutiveFails}x gagal beruntun` };
  return { tone: 'ok', text: 'Sehat' };
}
