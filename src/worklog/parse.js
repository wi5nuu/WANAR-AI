/**
 * src/worklog/parse.js
 *
 * Turns a free-text note ("kerja 9-17, istirahat 12-13, gaji proyek 1,5jt,
 * makan siang 25rb, selesai fitur login") into structured journal entries.
 *
 * Two layers:
 *   - parseQuick(): deterministic, offline, handles times / money / obvious tasks
 *   - normaliseAiProposal(): validates whatever the AI returns, so a model can
 *     never write malformed or absurd values into the journal
 *
 * Nothing here writes: callers show the proposal (web) or echo it back
 * (Telegram) and then save.
 *
 * @author Wisnu Alfian Nur Ashar
 */

export const MAX_AMOUNT = 10_000_000_000; // Rp10 M: anything above is a typo

/** "25rb" "25 ribu" "1,5jt" "1.500.000" "Rp 50.000" "50k" "2 juta" -> integer Rupiah */
export function parseAmount(raw) {
  const s = String(raw || '').toLowerCase().replace(/rp\.?\s*/g, '').trim();
  const m = /^(\d+(?:[.,]\d+)*)\s*(rb|ribu|k|jt|juta|m|miliar|milyar)?$/.exec(s);
  if (!m) return null;
  let num = m[1];
  const unit = m[2] || '';
  if (unit) {
    // with a unit, "," or "." is a decimal separator: "1,5jt", "2.5jt"
    num = Number(num.replace(',', '.'));
  } else if (/^\d{1,3}([.,]\d{3})+$/.test(num)) {
    // thousand separators: "1.500.000" / "1,500,000"
    num = Number(num.replace(/[.,]/g, ''));
  } else {
    num = Number(num.replace(',', '.'));
  }
  if (!Number.isFinite(num)) return null;
  const mult = { rb: 1e3, ribu: 1e3, k: 1e3, jt: 1e6, juta: 1e6, m: 1e9, miliar: 1e9, milyar: 1e9 }[unit] || 1;
  const v = Math.round(num * mult);
  return v > 0 && v <= MAX_AMOUNT ? v : null;
}

const HHMM = /(\d{1,2})(?:[:.](\d{2}))?/;
const RANGE = new RegExp(`(?:jam\\s*)?${HHMM.source}\\s*(?:-|–|s\\.?d\\.?|sampai|hingga|to)\\s*(?:jam\\s*)?${HHMM.source}`, 'i');

const toHHMM = (h, m) => {
  const hh = Number(h);
  const mm = Number(m || 0);
  if (hh > 24 || mm > 59) return null;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
};

const INCOME_WORDS = /\b(gaji|pemasukan|pendapatan|masuk|terima|diterima|dapat|dibayar|bayaran|income|honor|fee|komisi|bonus|transfer masuk|untung|jual)\b/i;
const EXPENSE_WORDS = /\b(beli|bayar|biaya|pengeluaran|keluar|belanja|makan|minum|bensin|ongkir|parkir|tagihan|langganan|top ?up|isi pulsa|kuota|sewa|cicilan|expense)\b/i;
const TASK_WORDS = /^(?:(?:sudah\s+|telah\s+)?(?:selesai(?:kan)?|beres(?:in)?|kerjakan|mengerjakan|ngerjain|garap|bikin|buat|membuat|fix(?:ing)?|perbaiki|memperbaiki|deploy|review|meeting|rapat|desain|implementasi|implement|tulis|menulis|riset|testing|tes|belajar)\b)/i;
const DONE_WORDS = /\b(selesai|beres|done|sudah|telah|kelar|rampung|deploy(?:ed)?)\b/i;

const CATEGORY_HINTS = [
  [/makan|minum|kopi|coffee|snack|warung|resto|kafe|cafe|teh|jajan/i, 'Makan & minum'],
  [/bensin|parkir|ojek|grab|gojek|tol|transport|ongkir/i, 'Transportasi'],
  [/pulsa|kuota|internet|wifi|langganan|hosting|domain|server|cloud/i, 'Internet & langganan'],
  [/listrik|air|tagihan|sewa|kos|cicilan/i, 'Tagihan'],
  [/gaji|honor|fee|proyek|project|klien|client|freelance|komisi|bonus|desain|design|logo|jasa|bayaran|invoice|kontrak/i, 'Pekerjaan'],
  [/belanja|beli/i, 'Belanja'],
];

export const STANDARD_CATEGORIES = Object.freeze([...new Set(CATEGORY_HINTS.map(([, c]) => c)), 'Pemasukan lain', 'Lainnya']);

function categorize(text, type) {
  for (const [re, cat] of CATEGORY_HINTS) if (re.test(text)) return cat;
  return type === 'income' ? 'Pemasukan lain' : 'Lainnya';
}

const AMOUNT_IN_TEXT = /(?:rp\.?\s*)?(\d+(?:[.,]\d+)*)\s*(rb|ribu|k|jt|juta)?\b/i;

/**
 * Offline best-effort parser.
 * @returns {{work:Array, breaks:Array, tasks:Array, finance:Array, report:string, confidence:number}}
 */
export function parseQuick(text) {
  const out = { work: [], breaks: [], tasks: [], finance: [], report: '', confidence: 0 };
  const src = String(text || '').trim();
  if (!src) return out;

  const clauses = src.split(/[\n;]|,(?!\d)|\s+(?:lalu|terus|kemudian)\s+/i).map((c) => c.trim()).filter(Boolean);
  const leftover = [];
  let hits = 0;

  for (const clause of clauses) {
    const range = RANGE.exec(clause);
    if (range && /istirahat|break|rehat|makan siang|ishoma/i.test(clause)) {
      const start = toHHMM(range[1], range[2]);
      const end = toHHMM(range[3], range[4]);
      if (start && end) { out.breaks.push({ start, end }); hits++; continue; }
    }
    if (range && /kerja|work|kantor|ngantor|masuk|wfh|wfo|shift/i.test(clause)) {
      const start = toHHMM(range[1], range[2]);
      const end = toHHMM(range[3], range[4]);
      if (start && end) { out.work.push({ start, end }); hits++; continue; }
    }

    const isIncome = INCOME_WORDS.test(clause);
    const isExpense = EXPENSE_WORDS.test(clause);
    if (isIncome !== isExpense) {
      const am = AMOUNT_IN_TEXT.exec(clause);
      const amount = am ? parseAmount(`${am[1]}${am[2] || ''}`) : null;
      // Require either a unit or a plausibly large number, so "jam 9" is never money.
      if (amount && (am[2] || amount >= 1000)) {
        const type = isIncome ? 'income' : 'expense';
        out.finance.push({ type, amount, category: categorize(clause, type), note: clause.slice(0, 120) });
        hits++;
        continue;
      }
    }

    if (TASK_WORDS.test(clause)) {
      out.tasks.push({ title: clause.slice(0, 160), done: DONE_WORDS.test(clause) });
      hits++;
      continue;
    }
    leftover.push(clause);
  }

  out.report = leftover.join('. ').slice(0, 600);
  out.confidence = clauses.length ? hits / clauses.length : 0;
  return out;
}

// ---------------------------------------------------------------- AI layer

const isHHMM = (s) => typeof s === 'string' && /^\d{1,2}[:.]\d{2}$|^\d{1,2}$/.test(s.trim());

function normTime(s) {
  if (!isHHMM(s)) return null;
  const [h, m] = s.trim().split(/[:.]/);
  return toHHMM(h, m);
}

/** Validates an AI proposal; drops anything malformed instead of trusting it. */
export function normaliseAiProposal(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const ranges = (xs) => (Array.isArray(xs) ? xs : [])
    .map((r) => ({ start: normTime(r?.start), end: normTime(r?.end) }))
    .filter((r) => r.start && r.end && r.start !== r.end)
    .slice(0, 10);

  const finance = (Array.isArray(p.finance) ? p.finance : [])
    .map((f) => {
      const type = f?.type === 'income' || f?.type === 'pemasukan' ? 'income'
        : (f?.type === 'expense' || f?.type === 'pengeluaran' ? 'expense' : null);
      const amount = typeof f?.amount === 'number' ? Math.round(f.amount) : parseAmount(f?.amount);
      if (!type || !amount || amount <= 0 || amount > MAX_AMOUNT) return null;
      // Map free-form AI categories ('kopi', 'desain logo') onto the standard
      // set so monthly per-category totals stay meaningful; keep the detail.
      const rawCat = String(f.category || '').trim();
      const category = STANDARD_CATEGORIES.includes(rawCat) ? rawCat : categorize(`${rawCat} ${f.note || ''}`, type);
      const note = String(f.note || '').trim() || (rawCat && rawCat !== category ? rawCat : '');
      return { type, amount, category, note: note.slice(0, 160) || null };
    })
    .filter(Boolean)
    .slice(0, 30);

  const tasks = (Array.isArray(p.tasks) ? p.tasks : [])
    .map((t) => (typeof t === 'string' ? { title: t } : t))
    .map((t) => ({
      title: String(t?.title || '').replace(/\s+/g, ' ').trim().slice(0, 160),
      done: t?.done !== false,
      minutes: Number.isFinite(t?.minutes) && t.minutes > 0 && t.minutes < 24 * 60 ? Math.round(t.minutes) : null,
      project: t?.project ? String(t.project).slice(0, 60) : null,
    }))
    .filter((t) => t.title)
    .slice(0, 30);

  return {
    work: ranges(p.work),
    breaks: ranges(p.breaks),
    tasks,
    finance,
    report: String(p.report || '').trim().slice(0, 600),
  };
}

export function isEmptyProposal(p) {
  return !p.work.length && !p.breaks.length && !p.tasks.length && !p.finance.length && !p.report;
}
