/**
 * src/email-desk/assistant-actions.js
 *
 * Email abilities for the Telegram assistant (src/worklog/assistant.js):
 * prompt lines, the action executor, and deterministic shortcuts so that
 * "kirim" / "batal" after a draft never depends on the model.
 *
 * @author Wisnu Alfian Nur Ashar
 */

export const EMAIL_ACTION_TYPES = ['email', 'email_send', 'email_cancel', 'email_revise', 'email_reply', 'email_mode'];

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const SEND_NOW = /(langsung kirim|kirim langsung|langsung saja kirim|tanpa konfirmasi|kirim sekarang juga)/i;
const MODE_ALIASES = { notify: 'notify', kabari: 'notify', approve: 'approve', konfirmasi: 'approve', auto: 'auto', otomatis: 'auto' };

export function emailPromptLines(desk) {
  return [
    '',
    'EMAIL — kamu BISA menulis & mengirim email untuknya dan memantau balasannya:',
    '- {"type":"email","to":"alamat@domain","subject":"...","body":"isi email lengkap, sopan, dengan tanda tangan","auto_reply":"notify|approve|auto","auto_instructions":"pedoman membalas"}',
    '    membuat DRAF; sistem menampilkan pratinjau dan dia cukup membalas "kirim". auto_reply: notify = kabari saat ada balasan (default),',
    '    approve = AI siapkan balasan lalu dia konfirmasi, auto = balas otomatis (hanya bila dia memintanya, isi auto_instructions dari kata-katanya).',
    '- {"type":"email_send","draft":3}  kirim draf #3 (hanya bila dia menyuruh kirim)',
    '- {"type":"email_cancel","draft":3}',
    '- {"type":"email_revise","draft":3,"subject":"...","body":"..."}  ubah draf sesuai permintaannya',
    '- {"type":"email_reply","to":"alamat lawan bicara","body":"..."}  draf balasan di percakapan yang ada',
    '- {"type":"email_mode","to":"alamat/kata kunci","mode":"notify|approve|auto","instructions":"..."}',
    'Aturan email: jangan mengarang alamat; bila alamat tidak disebut, tanyakan. Jangan janji harga/tanggal yang tidak dia sebut.',
    desk.contextForChat(),
  ];
}

const pickDraft = (desk, ref) => {
  if (ref != null && ref !== '') return ref;
  const p = desk.pendingDrafts();
  if (p.length === 1) return p[0].seq;
  throw new Error(p.length ? 'Ada beberapa draf — sebutkan nomornya (lihat /email)' : 'Tidak ada draf yang menunggu');
};

/**
 * Deterministic answers to "kirim" / "batal" while drafts are waiting.
 * @returns {Promise<string|null>} reply, or null when not applicable
 */
export async function quickEmailReply(desk, text) {
  const t = String(text || '').trim().toLowerCase().replace(/[.!]+$/, '');
  const pending = desk.pendingDrafts();
  if (!pending.length) return null;
  const send = /^(ya|iya|y|ok|oke|okay|kirim|kirimkan|kirim aja|kirim saja|kirim sekarang|gas|lanjut|setuju|send|sip kirim)(?:\s+#?(\d+))?$/.exec(t);
  const cancel = /^(batal|batalkan|jangan|gak jadi|nggak jadi|ga jadi|tidak jadi|cancel|buang)(?:\s+(?:email|draf|draft))?(?:\s+#?(\d+))?$/.exec(t);
  if (!send && !cancel) return null;
  const n = (send || cancel)[2];
  if (!n && pending.length > 1) return `Ada ${pending.length} draf menunggu — sebutkan nomornya, mis. "kirim ${pending.at(-1).seq}".\n${pending.map((d) => `#${d.seq} → ${d.to_addr} — ${d.subject}`).join('\n')}`;
  const ref = n || pending[0].seq;
  try {
    if (send) {
      const r = await desk.sendDraft(ref);
      return `✓ Email #${r.draft.seq} ${r.dryRun ? 'DISIMULASIKAN (SMTP belum diatur di server)' : 'terkirim'} ke ${r.draft.to_addr}.${r.thread.auto_mode === 'auto' ? ' Balasan akan saya jawab otomatis sesuai pedomanmu.' : ' Saya kabari begitu ada balasan.'}`;
    }
    const d = desk.cancelDraft(ref);
    return `Draf #${d.seq} ke ${d.to_addr} dibatalkan.`;
  } catch (e) {
    return `✗ ${e.message}`;
  }
}

/**
 * Executes email actions proposed by the model. `ownerText` is the owner's own
 * message: only it (not the model) can authorise sending without a preview.
 * @returns {Promise<string[]>}
 */
export async function runEmailActions(desk, actions, { chatId = null, ownerText = '' } = {}) {
  const out = [];
  for (const a of actions) {
    try {
      switch (a.type) {
        case 'email': {
          const mode = MODE_ALIASES[String(a.auto_reply || '').toLowerCase()] || 'notify';
          const d = await desk.draft({
            to: a.to, subject: a.subject, body: a.body, brief: a.brief || (a.body ? '' : ownerText),
            chatId, autoMode: mode, autoInstructions: a.auto_instructions || (mode === 'auto' ? ownerText : null),
          });
          if (SEND_NOW.test(ownerText)) {
            const r = await desk.sendDraft(d);
            out.push(`✓ Email ${r.dryRun ? 'DISIMULASIKAN (SMTP belum diatur)' : 'terkirim'} ke ${d.to_addr} — ${d.subject}`);
          } else {
            out.push(desk.previewText(d));
          }
          break;
        }
        case 'email_send': {
          const r = await desk.sendDraft(pickDraft(desk, a.draft ?? a.id));
          out.push(`✓ Email #${r.draft.seq} ${r.dryRun ? 'DISIMULASIKAN (SMTP belum diatur)' : 'terkirim'} ke ${r.draft.to_addr}`);
          break;
        }
        case 'email_cancel': {
          const d = desk.cancelDraft(pickDraft(desk, a.draft ?? a.id));
          out.push(`✓ Draf #${d.seq} dibatalkan`);
          break;
        }
        case 'email_revise': {
          const d = desk.reviseDraft(pickDraft(desk, a.draft ?? a.id), { subject: a.subject, body: a.body });
          out.push(desk.previewText(d));
          break;
        }
        case 'email_reply': {
          const t = desk.findThread(a.to || a.thread);
          const d = await desk.draft({ to: t.counterpart, body: a.body, brief: a.body ? '' : ownerText, threadId: t.id, chatId, autoMode: t.auto_mode });
          out.push(desk.previewText(d));
          break;
        }
        case 'email_mode': {
          const mode = MODE_ALIASES[String(a.mode || '').toLowerCase()];
          if (!mode) throw new Error('Mode balasan tidak dikenal (notify/approve/auto)');
          const t = desk.setAutoMode(a.to || a.thread, mode, a.instructions || null);
          out.push(`✓ Percakapan dengan ${t.counterpart}: ${mode === 'auto' ? 'balas otomatis' : mode === 'approve' ? 'AI siapkan balasan, kamu konfirmasi' : 'kabari saja'}`);
          break;
        }
        default:
          break;
      }
    } catch (e) {
      out.push(`✗ ${e.message}`);
    }
  }
  return out;
}

/** When the model produced no email action but the owner clearly asked for one. */
export function emailFallback(text) {
  const src = String(text || '');
  const addr = EMAIL_RE.exec(src)?.[0];
  if (!addr || !/(email|e-mail|surel|kirim|kirimkan|tulis|buatkan)/i.test(src)) return [];
  const mode = /(balas(kan)? (saja )?otomatis|auto ?reply|balas sendiri)/i.test(src) ? 'auto'
    : /(siapkan balasan|draf(t)? balasan)/i.test(src) ? 'approve' : 'notify';
  return [{ type: 'email', to: addr, brief: src, auto_reply: mode }];
}

const DELEGATE = /(?:\b(?:kamu|bot|ai|wanar|asisten)\b.{0,20}\b(?:saja|aja|dulu)?\s*(?:yang\s+)?balas|balas(?:kan)?\s+(?:saja\s+|aja\s+)?(?:otomatis|sendiri)|tolong\s+balas(?:kan)?\s+(?:email|surel|emailnya)|handle\s+(?:email|emailnya))/i;

/**
 * "kamu saja yang balas, saya lagi meeting": delegate the newest conversation
 * to the assistant. Deterministic so it never depends on the model.
 * @returns {Promise<string|null>}
 */
export async function quickDelegate(desk, text) {
  const t = String(text || '').trim();
  if (!DELEGATE.test(t) || t.length > 400) return null;
  if (!desk.threads(20).length) return null;
  const addr = EMAIL_RE.exec(t)?.[0] || null;
  try {
    const r = await desk.delegateReply(addr, t);
    return r.text;
  } catch (e) {
    return `✗ ${e.message}`;
  }
}
