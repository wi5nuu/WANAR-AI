/**
 * src/career/health.js
 *
 * A setting that disappears silently (an e-mail key lost from .env, a bot token gone) must not stay
 * silent: it shows up as a line in the owner's daily report. Only broken channels are mentioned, so a
 * healthy day adds nothing.
 *
 * @author Wisnu Alfian Nur Ashar
 */

export const WATCHED = [
  ['email', 'Email', 'balasan email dan kampanye tidak terkirim'],
  ['telegram', 'Telegram', 'laporan dan peringatan agent tidak sampai ke Mas'],
];

/**
 * The Telegram inbox can be "live" for sending yet deaf: with TELEGRAM_POLLING not "true" the bot never
 * reads what the owner writes. That exact setting was lost once when .env was overwritten.
 * @param {{status?: ()=>{wanted?:boolean, running?:boolean}}|null} inbox
 */
export function inboxWarnings(inbox) {
  let st = null;
  try { st = inbox?.status?.() || null; } catch { st = null; }
  if (!st) return [];
  if (!st.wanted) return ['PERHATIAN: Telegram tidak membaca pesan masuk (TELEGRAM_POLLING bukan "true"): bot tidak akan menjawab Mas.'];
  if (!st.running) return ['PERHATIAN: pembaca pesan Telegram sedang tidak berjalan: bot belum menjawab Mas.'];
  return [];
}

const WHY = { auth: 'kunci API ditolak (tidak valid atau sudah diganti)', quota: 'kuota habis', daily: 'batas harian tercapai', rate: 'kena batas laju', gone: 'model sudah tidak tersedia', circuit: 'gagal berulang' };

/**
 * When the owner's chosen main model provider is being refused, answers still come, but from slower
 * backups: say so, with the reason, instead of letting it degrade silently.
 * @param {{failover?: {skipReason: (p:string, m:string)=>({why:string}|null)}}|null} aiManager
 */
export function providerWarnings(aiManager, env = process.env) {
  const name = String(env.DEFAULT_PROVIDER || '').trim().toLowerCase();
  if (!name) return [];
  let sk = null;
  try { sk = aiManager?.failover?.skipReason?.(name, '*') || null; } catch { sk = null; }
  if (!sk) return [];
  return [`PERHATIAN: penyedia AI utama (${name}) sedang ditolak: ${WHY[sk.why] || sk.why}. Jawaban memakai cadangan yang lebih lambat.`];
}

/**
 * @param {{has: (id:string)=>boolean, get: (id:string)=>{mode?:string}}} channels
 * @returns {string[]} report lines (empty when everything watched is live)
 */
export function channelWarnings(channels, watched = WATCHED) {
  const out = [];
  for (const [id, label, effect] of watched) {
    let ch = null;
    try { ch = channels.has(id) ? channels.get(id) : null; } catch { ch = null; }
    if (!ch) continue;
    if (ch.mode !== 'live') out.push(`PERHATIAN: ${label} belum tersambung (mode ${ch.mode || 'tidak diketahui'}): ${effect}.`);
  }
  return out;
}
