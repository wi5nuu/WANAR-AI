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
