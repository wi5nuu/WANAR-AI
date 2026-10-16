/**
 * src/automation/chat-actions.js
 *
 * "YA" flow — risky actions proposed from chat, executed only after the owner
 * confirms in the SAME chat. v1: starting a prepared campaign
 * ("kirim kampanye Promo Juli").
 *
 * Why this exists: the assistant on WhatsApp/Telegram can already act on the
 * owner's own data (reminders, journal, email drafts). Public-facing side
 * effects (mass sends) must never happen off a single message — one mistyped
 * or prompt-injected request would go straight out to customers. So:
 *
 *   1. propose()  — deterministic pattern match, no model. Replies with the
 *      exact campaign, recipient count and mode, and asks for YA.
 *   2. confirm()  — exact YA / TIDAK match. On YA it mints a single-use
 *      approval bound to `campaign:<id>` and calls the tools registry
 *      (executeTool('automation_send_campaign')), so the security action-gate
 *      still authorizes — and consumes — the approval. This module never
 *      touches the engine directly.
 *
 * The proposal expires (default 10 minutes) and a newer proposal supersedes
 * an older one, so a stray YA can never launch something stale.
 *
 * @author Wisnu Alfian Nur Ashar
 */

const CHAT_ACTION_TTL_MS = 10 * 60_000;

/** "kirim kampanye promo" / "jalankan broadcast ..." — a verb AND an object. */
const SEND_VERB_RE = /\b(?:kirim|kirimin|jalankan|gas|eksekusi)\b/i;
const CAMPAIGN_WORD_RE = /\b(?:kampanye|campaign|broadcast|pesan massal)\b/i;
/** Deliberately explicit: "kirim" alone could belong to an email draft. */
const YES_RE = /^\s*(?:iya+|ya+|oke|ok|sip|lanjut|setuju|gas|boleh|betul|benar)\s*[!.]?\s*$/i;
const NO_RE = /^\s*(?:tidak|tdk|gak|ga|nggak|ngga|batal|jangan|cancel)\s*[!.]?\s*$/i;

const STARTABLE = new Set(['draft', 'paused']);
const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Words the owner added around the campaign name ("yang itu", "ke pelanggan"...). */
const NOISE_RE = /\b(?:yang|itu|aja|saja|sekarang|dong|ya|nih|deh|ke|untuk|semua|pelanggan|subscriber|penerima|kontak)\b/g;

function queryOf(text) {
  return String(text || '').toLowerCase()
    .replace(SEND_VERB_RE, ' ')
    .replace(CAMPAIGN_WORD_RE, ' ')
    .replace(NOISE_RE, ' ')
    .replace(/["'.,!?:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {object} deps
 * @param {object} deps.automation  automation module (store + channels)
 * @param {Function} deps.executeTool  src/tools/registry.js executeTool (the gate chokepoint)
 * @param {Function} deps.mintApproval src/security/action-gate.js mintApproval
 * @param {number} [deps.ttlMs]     how long a proposal stays valid (default 10 min)
 * @param {Function} [deps.now]     injectable clock (tests)
 */
export function createChatActions({ automation, executeTool, mintApproval, ttlMs = CHAT_ACTION_TTL_MS, now = Date.now } = {}) {
  const store = automation?.store;
  const channels = automation?.channels;
  if (!store?.proposals || typeof executeTool !== 'function' || typeof mintApproval !== 'function') {
    throw new Error('createChatActions: automation store, executeTool, dan mintApproval wajib');
  }

  const channelLabel = (id) => {
    try { return channels?.get?.(id)?.label || id; } catch { return id; }
  };
  const channelMode = (id) => {
    try { return channels?.get?.(id)?.mode || 'dry-run'; } catch { return 'dry-run'; }
  };
  /** Campaigns that engine.start() would accept right now. */
  const startable = () => store.campaigns.list(200).filter(
    (c) => STARTABLE.has(c.status) && (c.stats?.queued || 0) > 0
  );

  /**
   * The owner asked to send something risky? Propose it — never act.
   * @returns {Promise<string|null>} reply text, or null to continue normally.
   */
  async function propose(text, chatId) {
    const t = String(text || '');
    if (!chatId || !SEND_VERB_RE.test(t) || !CAMPAIGN_WORD_RE.test(t)) return null;
    const all = startable();
    if (!all.length) return null; // let the normal assistant explain (it sees the automation data)

    const query = queryOf(t);
    const matches = query
      ? all.filter((c) => {
        const name = String(c.name || '').toLowerCase();
        const cid = String(c.id || '').toLowerCase();
        return (name && (name.includes(query) || query.includes(name))) || cid === query || query.endsWith(cid);
      })
      : all;

    // Ambiguous (or unknown name): answer with the list — deterministic and safe.
    if (matches.length !== 1) {
      return [
        matches.length ? 'Ada beberapa kampanye yang cocok:' : 'Kampanye itu tidak ketemu. Yang siap kirim:',
        ...all.slice(0, 6).map((c, i) => `${i + 1}. "${clip(c.name, 60)}" (${channelLabel(c.channel)}, ${c.stats.queued} penerima)`),
        'Balas misalnya: kirim kampanye <nama>.',
      ].join('\n');
    }

    const c = matches[0];
    store.proposals.create({
      chatId, kind: 'send_campaign',
      payload: { campaignId: c.id, name: c.name },
      ttlMs, at: now(),
    });
    const mode = channelMode(c.channel);
    return `Siap. Kirim kampanye ${channelLabel(c.channel)} "${clip(c.name, 60)}" ke ${c.stats.queued} penerima `
      + `(mode ${mode === 'live' ? 'KIRIM NYATA' : 'SIMULASI — kanal belum dikonfigurasi'})? `
      + `Balas YA dalam ${Math.round(ttlMs / 60_000)} menit, atau TIDAK untuk batal.`;
  }

  /**
   * Exact YA / TIDAK while a proposal waits for THIS chat. On YA the action runs
   * through the tools registry, so the action gate still checks and consumes a
   * fresh single-use approval (minted here, at the moment of consent).
   * @returns {Promise<string|null>} reply text, or null to continue normally.
   */
  async function confirm(text, chatId) {
    const t = String(text || '');
    if (!chatId) return null;
    const isYes = YES_RE.test(t);
    const isNo = NO_RE.test(t);
    if (!isYes && !isNo) return null;

    const p = store.proposals.latest(chatId);
    if (!p) return null;

    if (p.expires_at < now()) {
      store.proposals.decide(p.id, 'expired', { at: now() });
      return 'Usulan tadi sudah kedaluwarsa, jadi tidak ada yang dijalankan. Kalau masih mau, minta lagi saja ya.';
    }
    if (isNo) {
      store.proposals.decide(p.id, 'cancelled', { at: now() });
      return 'Baik, dibatalkan. Tidak ada yang dijalankan.';
    }

    // Claim first: a double YA (or an unrelated race) can never execute twice.
    if (!store.proposals.decide(p.id, 'approved', { at: now() })) return null;
    if (p.kind !== 'send_campaign') {
      store.proposals.finish(p.id, 'failed', { note: `jenis usulan tidak dikenal: ${p.kind}`, at: now() });
      return 'Maaf, usulan itu tidak bisa saya jalankan.';
    }

    const campaignId = String(p.payload?.campaignId || '');
    const c = store.campaigns.get(campaignId);
    if (!c || !STARTABLE.has(c.status) || (c.stats?.queued || 0) === 0) {
      store.proposals.finish(p.id, 'failed', { note: 'kampanye sudah tidak bisa dimulai', at: now() });
      return 'Kampanye itu sudah berubah status (mungkin sudah dikirim atau kosong), jadi tidak saya jalankan.';
    }

    // Fresh single-use approval at consent time, bound to this exact campaign.
    mintApproval({
      tool: 'automation_send_campaign',
      target: `campaign:${campaignId}`,
      approvedBy: `chat:${chatId}`,
      reason: `pemilik menyetujui lewat balasan YA di chat: ${clip(c.name, 80)}`,
    });

    let res;
    try {
      res = await executeTool('automation_send_campaign', { campaign_id: campaignId }, { actor: 'chat' });
    } catch (e) {
      res = { error: e?.message || 'kesalahan tidak diketahui' };
    }
    if (!res || res.error || res.success === false) {
      const why = clip(res?.message || res?.error || 'kesalahan tidak diketahui', 300);
      store.proposals.finish(p.id, 'failed', { note: why, at: now() });
      return `Maaf, gagal dijalankan: ${why}`;
    }

    store.proposals.finish(p.id, 'done', { at: now() });
    const total = res.recipients ?? c.stats.queued;
    return `Siap, "${clip(c.name, 60)}" mulai dikirim ke ${total} penerima `
      + `(${res.mode === 'live' ? 'kirim nyata' : 'mode simulasi'}). Pantau progres di halaman Otomasi.`;
  }

  return { propose, confirm };
}

export default { createChatActions };
