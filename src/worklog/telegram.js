/**
 * src/worklog/telegram.js
 *
 * Owner-only Telegram commands for the work journal. Registered on the shared
 * TelegramInbox, which already restricts them to TELEGRAM_AI_CHAT_IDS.
 *
 *   /mulai              start working          /istirahat   start a break
 *   /lanjut             back from the break    /selesai     stop + day summary
 *   /catat <teks>       free text -> tasks/money/times/report (AI)
 *   /laporan <teks>     today's ~300-char report
 *   /tugas <judul>      add a finished task
 *   /uang +1,5jt gaji   income        /uang -25rb makan   expense
 *   /hariini  /minggu   summaries
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { formatMinutes, formatRupiah } from './time.js';
import { parseAmount } from './parse.js';

const formatWhen = (ms) => new Date(ms).toLocaleString('id-ID', {
  timeZone: process.env.WORKLOG_TZ || 'Asia/Jakarta', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
});

const expose = (message) => Object.assign(new Error(message), { expose: true });

function savedLine(saved) {
  const bits = [];
  if (saved.segments) bits.push(`${saved.segments} jam kerja/istirahat`);
  if (saved.tasks) bits.push(`${saved.tasks} tugas`);
  if (saved.finance) bits.push(`${saved.finance} catatan uang`);
  if (saved.report) bits.push('laporan');
  return bits.length ? `Tersimpan: ${bits.join(', ')}.` : 'Tidak ada yang bisa dicatat dari pesan itu.';
}

export function worklogTelegramCommands(worklog) {
  const guard = (fn) => async (ctx) => {
    try {
      return await fn(ctx);
    } catch (e) {
      throw expose(e.message || 'Gagal');
    }
  };

  return {
    mulai: {
      description: 'mulai bekerja',
      run: guard(async () => {
        const s = worklog.clockStart('telegram');
        return `Mulai bekerja. Semangat! (sudah ${formatMinutes(s.workedMin)} hari ini)`;
      }),
    },
    istirahat: {
      description: 'mulai istirahat',
      run: guard(async () => {
        const s = worklog.clockPause('telegram');
        return `Istirahat dimulai. Total kerja sejauh ini ${formatMinutes(s.workedMin)}. Kirim /lanjut saat kembali.`;
      }),
    },
    lanjut: {
      description: 'kembali bekerja setelah istirahat',
      run: guard(async () => {
        worklog.clockResume('telegram');
        return 'Kembali bekerja.';
      }),
    },
    selesai: {
      description: 'selesai bekerja + ringkasan hari ini',
      run: guard(async () => {
        worklog.clockStop();
        return `Selesai bekerja.\n\n${worklog.summaryText(worklog.today())}`;
      }),
    },
    catat: {
      description: 'catat bebas (tugas, uang, jam, laporan) — mis. /catat selesai fitur login, makan 25rb',
      run: guard(async ({ arg }) => {
        if (!arg) return 'Tulis catatannya setelah /catat. Contoh:\n/catat kerja 9-17, istirahat 12-13, selesai fitur login, makan siang 25rb';
        const { proposal, engine } = await worklog.parseText(arg);
        const saved = worklog.applyProposal(worklog.today(), proposal, 'telegram');
        return `${savedLine(saved)}${engine === 'quick' ? ' (diproses tanpa AI)' : ''}`;
      }),
    },
    laporan: {
      description: 'tulis laporan harian (~300 karakter)',
      run: guard(async ({ arg }) => {
        if (!arg) {
          const cur = worklog.day(worklog.today()).reportText;
          return cur ? `Laporan hari ini:\n${cur}` : 'Belum ada laporan. Kirim: /laporan <apa yang Anda kerjakan hari ini>';
        }
        const r = worklog.setReport(worklog.today(), { text: arg });
        return `Laporan disimpan (${r.text.length} karakter).`;
      }),
    },
    tugas: {
      description: 'tambah tugas yang sudah dikerjakan',
      run: guard(async ({ arg }) => {
        if (!arg) return 'Contoh: /tugas perbaiki bug pembayaran';
        worklog.addTask({ date: worklog.today(), title: arg, done: true });
        const x = worklog.day(worklog.today(), { light: true });
        return `Tugas dicatat. Selesai hari ini: ${x.tasks.done}.`;
      }),
    },
    uang: {
      description: 'catat uang: /uang +1,5jt gaji atau /uang -25rb makan',
      run: guard(async ({ arg }) => {
        const m = /^([+-])?\s*((?:rp\.?\s*)?[\d.,]+\s*(?:rb|ribu|k|jt|juta)?)\s*(.*)$/i.exec(arg || '');
        const amount = m ? parseAmount(m[2]) : null;
        if (!m || !amount) return 'Contoh: /uang -25rb makan siang  atau  /uang +1,5jt bayaran proyek';
        const type = m[1] === '+' ? 'income' : 'expense';
        worklog.addFinance({ date: worklog.today(), type, amount, note: m[3] || null, category: null });
        const x = worklog.day(worklog.today(), { light: true });
        return `${type === 'income' ? 'Pemasukan' : 'Pengeluaran'} ${formatRupiah(amount)} dicatat. Hari ini: +${formatRupiah(x.money.income)} / -${formatRupiah(x.money.expense)}.`;
      }),
    },
    jadwal: {
      description: 'lihat/ubah jadwal: /jadwal 08:00-17:00 istirahat 12:00-13:00 senin-jumat · /jadwal otomatis on|off',
      run: guard(async ({ arg }) => {
        const DAY = { minggu: 0, senin: 1, selasa: 2, rabu: 3, kamis: 4, jumat: 5, "jum'at": 5, sabtu: 6 };
        const NAME = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
        const show = (s) => [
          `Jadwal kerja: ${s.workStart}–${s.workEnd} (${s.workdays.map((d) => NAME[d]).join(', ')})`,
          `Istirahat: ${s.breakStart && s.breakEnd ? `${s.breakStart}–${s.breakEnd}` : 'tidak diatur'}`,
          `Target: ${s.targetHours} jam${s.targetHoursAuto ? ' (dari jadwal)' : ''}`,
          `Mulai otomatis: ${s.autoStart ? 'ON' : 'OFF'} · Ikuti jadwal: ${s.followSchedule ? 'ON' : 'OFF'} · Berhenti otomatis: ${s.autoStop ? 'ON' : 'OFF'}`,
        ].join('\n');

        const text = String(arg || '').trim().toLowerCase();
        if (!text) return `${show(worklog.getSettings())}\n\nUbah: /jadwal 08:00-17:00 istirahat 12:00-13:00 senin-jumat`;

        const patch = {};
        const toggle = /^(otomatis|auto)\s+(on|off|nyala|mati)$/.exec(text);
        if (toggle) {
          const on = ['on', 'nyala'].includes(toggle[2]);
          patch.autoStart = on;
          if (on) patch.followSchedule = true;
        } else {
          const hm = (h, m) => `${String(Number(h)).padStart(2, '0')}:${m || '00'}`;
          const ranges = [...text.matchAll(/(\d{1,2})(?:[:.](\d{2}))?\s*(?:-|–|sampai|s\.?d\.?)\s*(\d{1,2})(?:[:.](\d{2}))?/g)];
          if (!ranges.length) return 'Format: /jadwal 08:00-17:00 istirahat 12:00-13:00 senin-jumat';
          patch.workStart = hm(ranges[0][1], ranges[0][2]);
          patch.workEnd = hm(ranges[0][3], ranges[0][4]);
          if (ranges[1]) {
            patch.breakStart = hm(ranges[1][1], ranges[1][2]);
            patch.breakEnd = hm(ranges[1][3], ranges[1][4]);
          }
          const days = /(minggu|senin|selasa|rabu|kamis|jum'?at|sabtu)\s*(?:-|–|sampai|s\.?d\.?)\s*(minggu|senin|selasa|rabu|kamis|jum'?at|sabtu)/.exec(text);
          if (days) {
            const a = DAY[days[1]];
            const b = DAY[days[2]];
            const list = [];
            for (let d = a; ; d = (d + 1) % 7) { list.push(d); if (d === b || list.length > 7) break; }
            patch.workdays = list;
          }
          patch.targetHours = null; // keep the target in sync with the new schedule
        }
        const s = worklog.updateSettings(patch);
        return `Jadwal disimpan di server — berlaku walau laptop mati.\n\n${show(s)}`;
      }),
    },
    pengingat: {
      description: 'daftar pengingat aktif (batalkan: /batal <nomor>)',
      run: guard(async () => {
        const list = worklog.listReminders(20);
        if (!list.length) return 'Tidak ada pengingat aktif. Cukup tulis biasa, mis. "ingatkan saya meeting jam 12".';
        return ['Pengingat aktif:', ...list.map((r, i) => `${i + 1}. ${formatWhen(r.at)} — ${r.text}`), '', 'Batalkan: /batal <nomor>'].join('\n');
      }),
    },
    batal: {
      description: 'batalkan pengingat: /batal 1',
      run: guard(async ({ arg }) => {
        const n = parseInt(arg, 10);
        const list = worklog.listReminders(20);
        if (!n || n < 1 || n > list.length) return 'Nomor tidak valid. Lihat daftar dengan /pengingat';
        worklog.cancelReminder(list[n - 1].id);
        return `Pengingat dibatalkan: ${list[n - 1].text}`;
      }),
    },
    hariini: {
      description: 'ringkasan hari ini',
      run: guard(async () => {
        try { await worklog.refreshActivity(worklog.today()); } catch { /* optional */ }
        return worklog.summaryText(worklog.today());
      }),
    },
    minggu: {
      description: 'ringkasan 7 hari terakhir',
      run: guard(async () => {
        const w = worklog.week(worklog.today());
        const s = w.summary;
        const lines = w.days.map((d) => `${d.date.slice(5)}  ${formatMinutes(d.workedMin).padEnd(7)} ${d.tasks.done} tugas`);
        return [
          '7 hari terakhir',
          `Total kerja: ${formatMinutes(s.workedMin)}${s.targetMin ? ` (${Math.round((s.achievement || 0) * 100)}% dari target)` : ''}`,
          `Rata-rata per hari aktif: ${formatMinutes(s.avgWorkedMin)}`,
          `Tugas selesai: ${s.tasksDone} · Commit: ${s.commits}`,
          `Uang bersih: ${formatRupiah(s.net)}`,
          `Keseimbangan rata-rata: ${s.avgBalance}/100`,
          '',
          ...lines,
        ].join('\n');
      }),
    },
  };
}
