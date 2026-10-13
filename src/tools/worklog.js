/**
 * src/tools/worklog.js
 *
 * Agent tools for the work journal, so the chat can answer "berapa jam saya
 * kerja minggu ini?" or "catat: selesai fitur login, makan siang 25rb".
 *
 * These only read from / append to the operator's own journal (no network, no
 * filesystem, no messages to third parties), so they are not action-gated.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { getWorklog } from '../worklog/index.js';
import { formatMinutes, formatRupiah } from '../worklog/time.js';

const OFFLINE = { error: 'Jurnal kerja belum aktif. Jalankan server web (npm run web).' };

export const worklogTools = [
  {
    type: 'function',
    function: {
      name: 'worklog_today',
      description:
        'Lihat jurnal kerja pengguna untuk satu hari (default hari ini): status jam kerja (sedang bekerja/istirahat/selesai), ' +
        'jam kerja vs target, istirahat, perbandingan dengan hari sebelumnya, tugas, pemasukan/pengeluaran, aktivitas commit/file, ' +
        'skor produktivitas, keseimbangan kerja-hidup, dan laporan harian.',
      parameters: {
        type: 'object',
        properties: { date: { type: 'string', description: 'YYYY-MM-DD (opsional, default hari ini)' } },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'worklog_summary',
      description: 'Ringkasan jurnal kerja untuk 7 hari terakhir ("week") atau satu bulan ("month"): total jam, rata-rata, tugas, keuangan, keseimbangan.',
      parameters: {
        type: 'object',
        properties: {
          period: { type: 'string', enum: ['week', 'month'] },
          month: { type: 'string', description: 'YYYY-MM untuk period=month (opsional)' },
        },
        required: ['period'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'worklog_log',
      description:
        'Catat ke jurnal kerja pengguna dari teks bebas: jam kerja/istirahat, tugas yang dikerjakan, pemasukan/pengeluaran, dan laporan. ' +
        'Contoh: "kerja 9-17, istirahat 12-13, selesai fitur login, makan siang 25rb". Gunakan hanya bila pengguna memintanya.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Catatan dari pengguna' },
          date: { type: 'string', description: 'YYYY-MM-DD (opsional, default hari ini)' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'worklog_clock',
      description: 'Ubah status jam kerja pengguna: mulai, istirahat, lanjut, atau selesai bekerja. Gunakan hanya bila pengguna memintanya.',
      parameters: {
        type: 'object',
        properties: { action: { type: 'string', enum: ['start', 'pause', 'resume', 'stop'] } },
        required: ['action'],
      },
    },
  },
];

export async function executeWorklogTool(name, args = {}) {
  const wl = getWorklog();
  if (!wl) return OFFLINE;
  const svc = wl.service;
  try {
    switch (name) {
      case 'worklog_today': {
        const d = svc.day(args.date || svc.today());
        return {
          date: d.date, label: d.label, status: d.status,
          worked: formatMinutes(d.workedMin), target: formatMinutes(d.targetMin),
          achievementPct: d.achievement != null ? Math.round(d.achievement * 100) : null,
          break: formatMinutes(d.breakMin),
          vsPreviousDayPct: d.comparison.workedPct, previousDate: d.comparison.previousDate,
          tasks: d.taskList.map((t) => ({ title: t.title, done: Boolean(t.done) })),
          money: { income: formatRupiah(d.money.income), expense: formatRupiah(d.money.expense), net: formatRupiah(d.money.net) },
          activity: { commits: d.activity.commits, filesChanged: d.activity.filesChanged },
          productivity: d.productivity,
          balance: { score: d.balance.score, label: d.balance.label, notes: d.balance.checks.map((c) => c.message) },
          verdict: d.verdict.text,
          report: d.reportText || null,
          evaluation: d.evaluation,
        };
      }
      case 'worklog_summary': {
        const r = args.period === 'month' ? svc.month(args.month) : svc.week(svc.today());
        const s = r.summary;
        return {
          from: r.from, to: r.to,
          worked: formatMinutes(s.workedMin), target: formatMinutes(s.targetMin),
          achievementPct: s.achievement != null ? Math.round(s.achievement * 100) : null,
          activeDays: s.activeDays, avgPerActiveDay: formatMinutes(s.avgWorkedMin),
          tasksDone: s.tasksDone, commits: s.commits,
          income: formatRupiah(s.income), expense: formatRupiah(s.expense), net: formatRupiah(s.net),
          avgProductivity: s.avgProductivity, avgBalance: s.avgBalance,
          expenseByCategory: r.expenseByCategory?.slice(0, 6).map((c) => ({ ...c, amount: formatRupiah(c.amount) })),
          days: r.days.filter((d) => d.workedMin || d.tasks.total).map((d) => ({ date: d.date, worked: formatMinutes(d.workedMin), tasksDone: d.tasks.done })),
        };
      }
      case 'worklog_log': {
        const date = args.date || svc.today();
        const { proposal, engine } = await svc.parseText(args.text);
        const saved = svc.applyProposal(date, proposal, 'agent');
        return { success: true, date, engine, saved, proposal };
      }
      case 'worklog_clock': {
        const fn = { start: 'clockStart', pause: 'clockPause', resume: 'clockResume', stop: 'clockStop' }[args.action];
        if (!fn) return { error: 'action harus start|pause|resume|stop' };
        const st = fn === 'clockStop' ? svc.clockStop() : svc[fn]('agent');
        return { success: true, state: st.state, worked: formatMinutes(st.workedMin) };
      }
      default:
        return { error: `Unknown worklog tool: ${name}` };
    }
  } catch (err) {
    return { error: err.message };
  }
}
