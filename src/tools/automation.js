/**
 * src/tools/automation.js
 *
 * Agent-facing tools for the automation module (scheduling + email).
 *
 * Trust boundary — important:
 *   Tool arguments are model-generated and therefore untrusted. These tools can
 *   only PROPOSE work:
 *     - automation_create_job   -> creates a job in `pending_approval` (inert)
 *     - automation_draft_email  -> creates a DRAFT campaign (nothing is sent)
 *   Anything that actually moves mail is either gated by the action gate
 *   (`automation_send_campaign`) or requires the human to press the button in
 *   the Automation page. There is deliberately no tool that approves a job.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { getAutomation } from '../automation/runtime.js';
import { previewSchedule } from '../automation/cron.js';
import { startOfLocalDay } from '../automation/campaigns.js';

const OFFLINE = {
  error: 'Modul otomasi belum aktif. Jalankan server web (npm run web) — penjadwal berjalan di dalam server.',
};

export const automationTools = [
  {
    type: 'function',
    function: {
      name: 'automation_status',
      description:
        'Lihat status modul otomasi: mode email (live/simulasi), batas kirim harian & pemakaian hari ini, ' +
        'jumlah job terjadwal, kampanye yang berjalan, dan draf yang menunggu review.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'automation_list_jobs',
      description: 'Daftar job otomasi terjadwal beserta status, jadwal, dan eksekusi berikutnya.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'automation_create_job',
      description:
        'Usulkan job otomasi terjadwal (mis. kirim email setiap hari jam 08:00). Job dibuat dalam status ' +
        '"pending_approval" dan TIDAK berjalan sampai user menyetujuinya di halaman Otomasi (/automation). ' +
        'Selalu beri tahu user untuk menyetujui. Tipe: "email" (template tetap ke daftar penerima), ' +
        '"ai_email" (AI menulis email dari brief tiap kali jalan), "ai_task" (AI menjalankan prompt/kode, ' +
        'opsional dikirim via email). Format jadwal: "daily@08:00", "weekdays@09:00", "weekly:senin,kamis@07:30", ' +
        '"monthly:1@08:00", "every 30m", atau cron 5 kolom.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nama job, mis. "Laporan harian ke tim"' },
          type: { type: 'string', enum: ['email', 'ai_email', 'ai_task'] },
          schedule: { type: 'string', description: 'Ekspresi jadwal, mis. "daily@08:00"' },
          timezone: { type: 'string', description: 'Zona waktu IANA (default Asia/Jakarta)' },
          recipients: {
            type: 'string',
            description: 'Penerima: satu email per baris, atau CSV dengan header "nama,email,...". Untuk ai_task boleh dikosongkan.',
          },
          subject: { type: 'string', description: 'Subjek (tipe email / ai_task). Mendukung {{nama}}, {{tanggal}}.' },
          body: { type: 'string', description: 'Isi email (tipe email). Mendukung {{nama|fallback}}, {{tanggal}}, {{hari}}.' },
          brief: { type: 'string', description: 'Brief untuk AI (tipe ai_email), mis. "Ringkasan progres proyek hari ini"' },
          prompt: { type: 'string', description: 'Prompt untuk AI (tipe ai_task)' },
          tone: { type: 'string', description: 'Nada email (ai_email), mis. "formal dan hangat"' },
          auto_send: {
            type: 'boolean',
            description: 'Kirim otomatis tanpa review manusia. Default false: hasil AI masuk draf untuk di-review.',
          },
          max_runs: { type: 'integer', description: 'Batas jumlah eksekusi (mis. 1 = sekali saja)' },
        },
        required: ['name', 'type', 'schedule'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'automation_draft_email',
      description:
        'Buat DRAF kampanye email (mis. untuk 100 penerima) beserta pratinjau hasil personalisasi. ' +
        'Tidak ada yang terkirim. Setelah draf dibuat, user menekan "Setujui & Kirim" di halaman Otomasi, ' +
        'atau gunakan automation_send_campaign setelah user menyetujui.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nama kampanye' },
          subject: { type: 'string', description: 'Subjek; mendukung {{nama}} dst.' },
          body: { type: 'string', description: 'Isi email teks biasa; mendukung {{nama|Bapak/Ibu}}' },
          recipients: { type: 'string', description: 'Satu email per baris atau CSV dengan header' },
          reply_to: { type: 'string', description: 'Alamat Reply-To (opsional)' },
        },
        required: ['subject', 'body', 'recipients'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'automation_send_campaign',
      description:
        'Mulai mengirim kampanye email yang sudah dibuat. TOOL INI MEMERLUKAN PERSETUJUAN USER. ' +
        'Jika diblokir, sampaikan ke user jumlah penerima & subjek, lalu minta mereka menyetujui ' +
        '(halaman Otomasi → tombol "Setujui & Kirim"). Jangan mencoba menghindari blokir ini.',
      parameters: {
        type: 'object',
        properties: {
          campaign_id: { type: 'string', description: 'ID kampanye dari automation_draft_email' },
        },
        required: ['campaign_id'],
      },
    },
  },
];

const compactJob = (scheduler, j) => {
  const p = scheduler.present(j);
  return {
    id: p.id, name: p.name, type: p.type, status: p.status, statusReason: p.status_reason,
    schedule: p.schedule, scheduleDescription: p.scheduleDescription, timezone: p.timezone,
    nextRunAt: p.next_run_at ? new Date(p.next_run_at).toISOString() : null,
    lastStatus: p.last_status, runCount: p.run_count,
    needsApproval: p.status === 'pending_approval',
  };
};

export async function executeAutomationTool(name, args = {}) {
  const auto = getAutomation();
  if (!auto) return OFFLINE;
  const { scheduler, engine, store, mailer } = auto;

  try {
    switch (name) {
      case 'automation_status': {
        const sentToday = store.outbox.sentSince(startOfLocalDay());
        const jobs = store.jobs.list();
        const drafts = store.campaigns.list(200).filter((c) => c.status === 'draft');
        return {
          mailer: mailer.describe(),
          dailyUsage: { sentToday, cap: mailer.cfg.dailyCap },
          jobs: {
            total: jobs.length,
            active: jobs.filter((j) => j.status === 'active').length,
            pendingApproval: jobs.filter((j) => j.status === 'pending_approval').length,
          },
          runningCampaigns: store.campaigns.byStatus('running').length,
          draftCampaigns: drafts.map((c) => ({ id: c.id, name: c.name, recipients: c.stats.total })),
        };
      }

      case 'automation_list_jobs':
        return { jobs: store.jobs.list().map((j) => compactJob(scheduler, j)) };

      case 'automation_create_job': {
        const payload = {};
        if (args.type === 'email') {
          payload.subject = args.subject;
          payload.bodyText = args.body;
          payload.recipients = args.recipients;
        } else if (args.type === 'ai_email') {
          payload.brief = args.brief;
          payload.recipients = args.recipients;
          payload.tone = args.tone;
          payload.autoSend = args.auto_send === true;
        } else if (args.type === 'ai_task') {
          payload.prompt = args.prompt;
          payload.recipients = args.recipients || undefined;
          payload.subject = args.subject;
          payload.autoSend = args.auto_send === true;
        }
        const job = scheduler.createJob(
          {
            name: args.name, type: args.type, schedule: args.schedule,
            timezone: args.timezone, payload, maxRuns: args.max_runs,
          },
          { activate: false, actor: 'agent' } // never self-activating
        );
        const prev = previewSchedule(job.schedule, job.timezone, 3);
        return {
          success: true,
          job: compactJob(scheduler, job),
          nextRuns: prev.next.map((t) => new Date(t).toISOString()),
          message:
            `Job "${job.name}" dibuat dengan status MENUNGGU PERSETUJUAN (belum berjalan). ` +
            `Minta user membuka halaman Otomasi (/automation) lalu menekan "Setujui" untuk mengaktifkannya. ` +
            `Jadwal: ${prev.description}.`,
        };
      }

      case 'automation_draft_email': {
        const { campaign, report } = engine.create({
          name: args.name, subject: args.subject, bodyText: args.body,
          recipients: args.recipients, replyTo: args.reply_to, createdBy: 'agent',
        });
        const preview = engine.preview(campaign.id, 2);
        return {
          success: true,
          campaignId: campaign.id,
          status: 'draft',
          recipients: report.valid,
          invalid: report.invalid.length,
          duplicates: report.duplicates.length,
          suppressed: report.suppressed.length,
          recipientsWithMissingVariables: report.recipientsWithMissingCount,
          mode: mailer.mode,
          preview,
          message:
            `Draf dibuat untuk ${report.valid} penerima (mode ${mailer.mode === 'live' ? 'KIRIM NYATA' : 'SIMULASI — SMTP belum dikonfigurasi'}). ` +
            `BELUM terkirim. Minta user me-review lalu menyetujui di halaman Otomasi.`,
        };
      }

      case 'automation_send_campaign': {
        // Reaching here means the action gate already verified a human approval
        // bound to `campaign:<id>`.
        const c = engine.start(args.campaign_id, { approvedBy: 'user-approved-tool-call' });
        return {
          success: true,
          campaignId: c.id,
          status: c.status,
          mode: c.mode,
          recipients: c.stats.total,
          message: `Pengiriman dimulai (${c.mode}). Pantau progres di halaman Otomasi.`,
        };
      }

      default:
        return { error: `Unknown automation tool: ${name}` };
    }
  } catch (err) {
    return { error: err.message, code: err.code };
  }
}
