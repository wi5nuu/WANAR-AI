/**
 * src/market/scenario.js
 *
 * Pure arithmetic for "kalau saya investasi X dengan asumsi imbal hasil Y% per tahun,
 * berapa nilainya nanti?". It is a CALCULATOR over the owner's own assumptions — not a
 * forecast and not advice. When no rate is given it shows three clearly-labelled
 * illustrative rates, never a prediction.
 *
 * @author Wisnu Alfian Nur Ashar
 */

const ILLUSTRATIVE = [
  { id: 'rendah', label: 'Ilustrasi rendah', annualPct: 4 },
  { id: 'sedang', label: 'Ilustrasi sedang', annualPct: 8 },
  { id: 'tinggi', label: 'Ilustrasi tinggi', annualPct: 15 },
];

const round = (n) => Math.round(n);

/**
 * @param {{principal:number, monthly?:number, annualPct:number, months:number, inflationPct?:number}} p
 */
export function project({ principal = 0, monthly = 0, annualPct, months, inflationPct = 0 }) {
  const P = Math.max(0, Number(principal) || 0);
  const M = Math.max(0, Number(monthly) || 0);
  const n = Math.min(600, Math.max(1, Math.round(Number(months) || 0)));
  const a = Number(annualPct);
  if (!Number.isFinite(a) || a < -100 || a > 1000) throw new Error('Asumsi imbal hasil tidak masuk akal');
  const rm = Math.pow(1 + a / 100, 1 / 12) - 1; // equivalent monthly rate
  let bal = P;
  const path = [{ month: 0, value: round(bal), contributed: round(P) }];
  for (let i = 1; i <= n; i++) {
    bal = bal * (1 + rm) + M;
    if (i === n || i % Math.max(1, Math.floor(n / 24)) === 0) path.push({ month: i, value: round(bal), contributed: round(P + M * i) });
  }
  const contributed = P + M * n;
  const infl = Math.pow(1 + (Number(inflationPct) || 0) / 100, n / 12);
  return {
    annualPct: a, months: n, principal: round(P), monthly: round(M),
    finalValue: round(bal), contributed: round(contributed), gain: round(bal - contributed),
    gainPct: contributed > 0 ? Math.round(((bal - contributed) / contributed) * 1000) / 10 : 0,
    realValue: inflationPct ? round(bal / infl) : null,
    path,
  };
}

/** Months until `target` is reached under the assumption (null if > 50 years). */
export function monthsToTarget({ principal = 0, monthly = 0, annualPct, target }) {
  const T = Number(target);
  if (!(T > 0)) return null;
  const rm = Math.pow(1 + Number(annualPct) / 100, 1 / 12) - 1;
  let bal = Math.max(0, Number(principal) || 0);
  for (let i = 1; i <= 600; i++) {
    bal = bal * (1 + rm) + (Number(monthly) || 0);
    if (bal >= T) return i;
  }
  return null;
}

/** Scenarios for the owner's rate, or three illustrative ones when none was given. */
export function scenarios({ principal, monthly = 0, months, annualPct = null, target = null, inflationPct = 0 }) {
  const rates = annualPct == null
    ? ILLUSTRATIVE
    : [{ id: 'asumsi', label: `Asumsi Anda (${annualPct}%/tahun)`, annualPct: Number(annualPct) }];
  return {
    illustrative: annualPct == null,
    results: rates.map((r) => ({
      id: r.id, label: r.label,
      ...project({ principal, monthly, annualPct: r.annualPct, months, inflationPct }),
      monthsToTarget: target ? monthsToTarget({ principal, monthly, annualPct: r.annualPct, target }) : null,
    })),
    disclaimer: 'Ini hitungan matematis dari asumsi, bukan prediksi atau jaminan. Imbal hasil nyata bisa lebih rendah, nol, atau rugi; nilai uang juga tergerus inflasi.',
  };
}
