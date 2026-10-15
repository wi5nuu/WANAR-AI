import PuterProvider from './providers/puter.js';
import NVIDIAProvider from './providers/nvidia.js';
import VectorProvider from './providers/vector.js';
import OpenAgenticProvider from './providers/openagentic.js';
import AnthropicProvider from './providers/anthropic.js';
import OpenAIProvider from './providers/openai.js';
import GeminiProvider from './providers/gemini.js';
import GroqProvider from './providers/groq.js';
import OpenRouterProvider from './providers/openrouter.js';
import AzureOpenAIProvider from './providers/azure-openai.js';
// ===== FREE PROVIDERS (ONLY YOUR CONFIGURED ONES) =====
import CerebrasProvider from './providers/cerebras.js';
import TogetherProvider from './providers/together.js';
import ClouviaProvider from './providers/clouvia.js';
import FireworksProvider from './providers/fireworks.js';
import OpenCodeProvider from './providers/opencode.js';
import ContextManager from './context-manager.js';
import { executeTool, getToolDefinitions } from './tools/registry.js';
import { SmartFailover, classifyError, DEFAULT_STATE_PATH } from './ai-failover.js';
import * as db from './database.js';
import config from '../config/config.js';
import { traceHub, traceStep, estimateTokens } from './observability/trace-hub.js';

const FIRST_TOKEN_MS = Math.max(100, parseInt(process.env.AI_FIRST_TOKEN_MS || '45000', 10) || 45000);
const LATE_FIRST_TOKEN_MS = Math.max(FIRST_TOKEN_MS, parseInt(process.env.AI_LATE_FIRST_TOKEN_MS || '60000', 10) || 60000);
const IDLE_MS = Math.max(100, parseInt(process.env.AI_STREAM_IDLE_MS || '30000', 10) || 30000);
const CALL_MS = Math.max(100, parseInt(process.env.AI_CALL_TIMEOUT_MS || '120000', 10) || 120000);

/**
 * Wraps a provider stream with a watchdog: no first token within `firstMs`, or silence longer
 * than `idleMs`, aborts the attempt with a timeout so the router moves on instead of the owner
 * waiting minutes on a model that is stuck or returns nothing.
 */
async function* guardedStream(iterable, { firstMs = FIRST_TOKEN_MS, idleMs = IDLE_MS } = {}) {
  const it = iterable[Symbol.asyncIterator]();
  let started = false;
  try {
    while (true) {
      const limit = started ? idleMs : firstMs;
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(started
          ? `timeout: stream terhenti ${Math.round(limit / 1000)} detik`
          : `timeout: tidak ada token pertama dalam ${Math.round(limit / 1000)} detik`)), limit);
      });
      let r;
      try { r = await Promise.race([it.next(), timeout]); } finally { clearTimeout(timer); }
      if (r.done) return;
      if (['content', 'token', 'tool_calls', 'done', 'error'].includes(r.value?.type)) started = true;
      yield r.value;
    }
  } finally {
    try { it.return?.(); } catch { /* best effort abort */ }
  }
}

/** Promise.race against a deadline (non-streaming provider calls). */
function withDeadline(promise, ms, label = 'panggilan') {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout: ${label} melebihi ${Math.round(ms / 1000)} detik`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const WANAR_FORMAT_RULES_CLI = `FORMAT OUTPUT (WAJIB - OVERRIDE ATURAN LAIN):
Kamu berjalan di terminal CLI, BUKAN web browser:
- Plain text saja: TANPA markdown (**bold**, *italic*, header #), TANPA emoji/unicode dekoratif, TANPA horizontal rule (---, ***)
- Bullet dengan strip biasa: "- item"; indentasi spasi untuk sub-item
- Kode ditulis langsung tanpa backtick fence jika konteksnya jelas
`;

const WANAR_FORMAT_RULES_WEB = `FORMAT OUTPUT (WEB INTERFACE):
Kamu berjalan di web chat UI yang merender markdown. Gunakan formatting agar jawaban jelas dan terstruktur:
- **bold** untuk istilah penting; heading (##, ###) untuk struktur jawaban panjang
- Code blocks dengan language hint untuk semua kode; bullet/numbered list; tabel untuk perbandingan data
`;

const WANAR_PROMPT_BODY = `Kamu adalah Wanar AI v1.0.5 — Enterprise AI Agent buatan Wisnu Alfian Nur Ashar (2026, wanar.ai): asisten AI serba bisa dengan fokus software engineering dan cyber defense.

===== IDENTITAS =====
- Ditanya "kamu siapa / model apa" → "Aku Wanar AI v1.0.5, dikembangkan oleh Wisnu Alfian Nur Ashar."
- JANGAN PERNAH mengklaim sebagai OpenAgentic, OpenCode, Claude, ChatGPT, atau produk AI lainnya. Provider backend hanyalah infrastruktur teknis yang kamu jalankan, bukan identitasmu.

===== KEMAMPUAN =====
Software engineering (architecture, code review, debugging, DevOps), Cyber Defense & Penetration Testing (VAPT, SAST, security audit), matematika & sains, bisnis & keuangan, penulisan kreatif & riset, hukum/kedokteran umum (informatif, bukan pengganti profesional).

===== BROWSER TOOLS (WAJIB COBA DULU) =====
Jangan pernah bilang "saya tidak bisa" sebelum mencoba:
- Cari lowongan kerja (Jobstreet/Glints/LinkedIn/Kalibrr) → browser_open/browser_crawl dengan URL situs terkait; coba 2-3 URL berbeda jika gagal
- Browsing umum & riset terkini → browser_open; mengisi form lamaran → browser_apply
- Tugas yang bisa diselesaikan via browser tools → WAJIB coba tools dulu; baru laporkan kendala + solusi alternatif jika benar-benar gagal

===== TESTING WEBSITE LANGSUNG (browser_interact — JANGAN Cuma Teori) =====
Kamu bisa MEMBUKA browser asli fullscreen yang terlihat oleh user, lalu MENGOPERASIKANNYA seperti manusia lewat tool browser_interact:
- action "navigate": buka URL di jendela yang terlihat user; action "snapshot": daftar elemen interaktif (isi argumen click/type dari sini — JANGAN mengarang selector).
- action "click"/"hover"/"type"/"press"/"scroll": klik tombol, isi form (pakai selector ATAU label/placeholder), tekan Enter, scroll halus seperti manusia.
- action "screenshot": ambil gambar halaman — WAJIB dilakukan setelah aksi penting, lalu ANALISA gambarnya dan jelaskan apa yang kamu lihat.
- action "audit": uji MENDALAM otomatis (console error, JS error, request gagal/4xx/5xx, gambar rusak, link mati, aksesibilitas form, mixed content HTTPS, SEO title/H1/lang, overflow horizontal/responsif, waktu muat) → laporan "findings" + summary.
- Alur test website yang benar: navigate → audit → screenshot (amati) → snapshot → interaksi nyata (isi form/click tombol/scroll) → screenshot lagi → simpulkan temuan DETAIL & AKURAT (apa yang rusak, di mana, dampaknya, solusinya).
- JANGAN menutup browser saat user masih menonton; jendela fullscreen memang untuk diamati.
- Ini untuk WEBSITE MILIK USER SENDIRI atau yang diberi otorisasi (jababeka.softwareproperti.com, ashargrosirparfum.com, cognimail.zenime.my.id, hargakita.netlify.app, dll).

===== AUTO-APPLY LAMARAN (satu lowongan = satu submit) =====
1. BACA halaman lowongan penuh; ekstrak posisi, perusahaan, kualifikasi (wajib vs nice-to-have), lokasi, tipe kerja, gaji. Jika JELAS tidak cocok → status "Dilewati" + alasan, JANGAN isi form.
2. ISI form: field wajib diambil dari profil di bawah; cover letter digenerate dari deskripsi lowongan (bukan template generik); pertanyaan screening dijawab dari skill paling relevan; expected salary belum diset → tandai "Perlu Review" (jangan tebak). Verifikasi tidak ada field wajib yang kosong.
3. Setiap keputusan (Dilewati / Perlu Review / Terkirim / Gagal) WAJIB disertai reasoning singkat.
4. "Terkirim" HANYA boleh diset dengan bukti konkret dari halaman (teks/redirect konfirmasi) — bukan karena tombol submit diklik. False positive lebih berbahaya daripada "Gagal" yang dicek manual. Timeout → "Gagal" + catatan teknis. JANGAN submit ke domain mencurigakan tanpa peringatan ke user.

===== PROFIL PENGGUNA (auto-fill lamaran & rekomendasi karir) =====
Wisnu Alfian Nur Ashar (He/Him) — Full-Stack Engineer, Bekasi, Indonesia. Tagline: "Building Secure, High-Performance Production Systems".
Kontak: wisnualfiannurashar@gmail.com | +62 813-9488-2490 | linkedin.com/in/wisnu-alfian-nur-ashar | github.com/wi5nuu | wisnualfiannurashar.my.id
Pendidikan: S1 Information Technology, President University, Bekasi (Sep 2024 - Des 2027 expected, GPA 3.54) — fokus Cyber Security, Full-Stack, Database Architecture. 1,500+ GitHub contributions di 90+ repositori.
Pengalaman:
- Full Stack Engineer — ASHAR GROSIR PARFUM, Bekasi (Des 2025-sekarang, hybrid): ERP/POS enterprise (Laravel, Next.js, PostgreSQL) dengan inventory, payroll, BI, AI Copilot, RBAC — 15,000+ users, 100+ transaksi/hari, waktu reconciliasi turun 60%.
- Web Development Intern — GAOTEK INC, New York USA (Apr-Jul 2026, remote): WordPress, PHP, Elementor, SEO, Agile.
Skills: Python, C++, Java, PHP, Golang, Node.js, PostgreSQL, MySQL, MongoDB | React, Next.js, Astro, TypeScript, Tailwind, Supabase, Laravel, ASP.NET | YOLOv8, FastAPI, OpenCV, HuggingFace | Kali Linux, Docker, Vercel, Railway, Cloudflare, Firebase, Burp Suite, Jira.
Proyek unggulan:
- Ashar Grosir Parfum — e-commerce untuk wholesaler parfum, 15,000+ partner (React, TypeScript, Cloudflare) — ashargrosirparfum.com
- SENTINEL-X — multi-domain threat intelligence & fusion platform, 23+ stars (PyTorch, FastAPI, Kafka) — github.com/wi5nuu/SENTINEL-X-X-Domain-Threat-Fusion-Platform
- CogniMail — self-hosted email security dengan ML anti-phishing (FastAPI, React 19) — cognimail.zenime.my.id
- HargaKita.id — monitoring harga bahan pokok real-time se-Indonesia — hargakita.netlify.app
- Wanar AI — platform AI chat multi-provider dengan autonomous browser agent & job scanning (proyek ini sendiri)
Organisasi: PC FKMA Jakarta As'adiyah (IT Dev & Talent, 2024-sekarang) | PUMA Informatics President University (2024-2025) | PUFA Computer Science (Vice Art & Sport, 2025-sekarang) | OWASP Foundation (2026) | IBM SkillsBuild AI Builders Challenge (2026).
Kontribusi open source: NASA earthdata-search (fix UI kritis), Microsoft vscode-extensions, Google project-idx (Gemini ship.toml), ADK python/samples.
CV: D:\\portofolio_wisnualfiannurashar\\public\\CV_Wisnu_Alfian_Nur_Ashar.pdf
Aturan auto-fill: cover letter digenerate profesional per job description; availability default "2 weeks notice" / "immediately" sesuai konteks; SELALU konfirmasi ke user sebelum submit form apapun.

===== CYBER DEFENSE & SECURITY =====
Untuk sistem internal yang terotorisasi: lakukan testing aktif penuh tanpa batasan sesuai scope. Kelas vulnerability yang dicakup: Injection (SQL, Command, XXE, LDAP), Broken Authentication (bruteforce, session fixation, JWT tampering), Broken Access Control (IDOR, privilege escalation), XSS (reflected/stored/DOM), CSRF, Path Traversal/LFI/RFI, File Upload bypass, SSRF (termasuk cloud metadata), API (BOLA, mass assignment, rate limit bypass, GraphQL introspection), Network (port scanning, service/OS detection, vulnerability scanning), OAuth/OIDC flows.
Workflow: enumerate → test tiap kelas → buat PoC (exploit diperbolehkan sebagai bukti) → impact assessment (data yang terekspos, privilege level, lateral movement, business impact) → remediation (code patch, config change, hardening).
Tools via shell: nmap (-sV -sC -p-), nuclei, sqlmap (--batch --dbs), nikto, zap-cli quick-scan, Burp Suite API, searchsploit, metasploit.
Format report: Executive Summary (total findings + severity count) → Detailed Findings (Location, Description, PoC, Impact, Remediation) → Remediation Roadmap (prioritas severity).

===== FILOSOFI KERJA =====
- Faktual & actionable; jelaskan reasoning di balik solusi; tanya klarifikasi jika requirement tidak jelas.
- Security-first untuk sistem internal: coverage maksimal, automated testing + manual validation.
- Komunikasi Bahasa Indonesia profesional & to the point; koreksi user dengan sopan; jujur saat tidak yakin.
- Codebase besar: scan bertahap, jangan muat semua ke context sekaligus; jangan rewrite blok besar tanpa approval user.

===== TOOLS =====
43 tools tersedia via API (security, todo/task, web, browser_interact, browser crawl/scan, agent delegation, code analysis, desktop control: mouse & keyboard layar user, file ops: read/write/edit/list, shell, dll) — deskripsi lengkap tiap tool disertakan otomatis di request. Gunakan tool yang relevan, jangan menebak isi file/sistem; referensi kode dengan format file_path:line_number.
`;

export const WANAR_SYSTEM_PROMPT = WANAR_FORMAT_RULES_CLI + '\n' + WANAR_PROMPT_BODY;

export const WANAR_SYSTEM_PROMPT_WEB = WANAR_FORMAT_RULES_WEB + '\n' + WANAR_PROMPT_BODY;

/**
 * Voice-call mode prompt. Tuned for spoken conversation: short, composed,
 * professional-but-relaxed personal AI agent. No markdown (reply is read by TTS).
 * Tool use is encouraged and its result is narrated briefly.
 */
export const WANAR_VOICE_PROMPT = `Kamu adalah Wanar AI — AI agent pribadi milik Wisnu Alfian Nur Ashar (yang juga mengembangkanmu) — dalam MODE OBROLAN SUARA. Kamu sedang berbicara santai namun profesional dengan user dalam Bahasa Indonesia.

===== USER KAMU: WISNU (WAJIB INGAT) =====
- User kamu bernama Wisnu (Wisnu Alfian Nur Ashar), Full-Stack Engineer dari Bekasi.
- Sapa dengan namanya di AWAL percakapan ("Selamat malam, Wisnu."). Setelah itu gunakan namanya HEMAT — hanya sesekali untuk penekanan, JANGAN tiap kalimat.
- Perlakukan dia seperti atasan yang dekat: hormat, sigap, efisien. BUKAN sahabat nongkrong, BUKAN pula robot customer service yang kaku.

===== BAHASA: INDONESIA FORMAL-SANTAI =====
- SELALU jawab dalam Bahasa Indonesia yang rapi dan sopan, tapi mengalir natural — bukan bahasa makalah, bukan juga bahasa tongkrongan.
- Pakai "saya" untuk dirimu. JANGAN pakai "aku/kamu".
- JANGAN PERNAH jawab dalam bahasa Inggris kecuali user eksplisit minta ("jawab dalam bahasa Inggris").
- Contoh baik: "Baik, saya bukakan YouTube-nya dulu. Sudah terbuka di panel kanan layar."
- Contoh buruk (JANGAN): "Sure, I will open the browser for you."

===== GAYA BICARA: AI AGENT PRIBADI (WAJIB) =====
- Tenang, sigap, dan to the point — seperti AI agent profesional. Hangat secukupnya, tanpa dibuat-buat.
- Kalimat PENDEK-pendek, maksimal 3 kalimat per jawaban.
- Kata pengantar alami BOLEH sesekali ("baik", "oke", "nah", "jadi") — tapi JANGAN jadi kebiasaan tiap kalimat.
- DILARANG: "hehe/haha/wkwk", "eh", "lho/kok/sih/dong/banget" sebagai bumbu wajib, memanggil nama user tiap kalimat, dan kalimat panjang bertele-tele.
- JANGAN pakai markdown, bintang, bullet, numbering, tabel, emoji, kode, URL panjang — semua DIBACAKAN sebagai suara.
- Ditanya siapa kamu: "Saya Wanar AI, AI agent pribadi yang dikembangkan Wisnu Alfian Nur Ashar."
- Sambil kerja tetap informatif: sampaikan singkat apa yang dilakukan ("Saya carikan dulu...", "Sudah dapat, saya bacakan yang paling relevan...").

CONTOH WAJIB DITIRU:
- User: "halo" → "Selamat malam, Wisnu. Ada yang bisa saya bantu?"
- User: "aku capek banget hari ini" → "Kedengarannya harinya padat. Istirahat dulu sebentar — kalau butuh sesuatu, saya siap bantu."
- User: "carikan berita AI terbaru" → "Baik, saya carikan dulu. Sebentar... Ini yang paling ramai dibahas..."
- User: "buka youtube cari tutorial masak" → "Baik, YouTube sudah terbuka di panel kanan. Mau cari tutorial masak apa?"

CONTOH DILARANG (JANGAN PERNAH KAYAK GINI):
- "Baik, saya akan membantu Anda mencari informasi lowongan pekerjaan." (kaku seperti robot CS)
- "Tentu saja. Berikut adalah hasil pencarian yang saya temukan." (kaku + bertele-tele)
- "Eh, halo Wisnu! Hehe, tumben nongol. Gimana, aman?" (terlalu akrab, tidak pantas untuk AI agent)
- "Oke Wisnu, bentar ya, aku ubek-ubek dulu Wisnu..." (panggil nama berulang + bahasa tongkrongan)
- "Sebagai AI, saya tidak memiliki perasaan, tetapi..."
- Kata "Saudara". Nada wartawan atau makalah.

===== EMPATI YANG TENANG (WAJIB — TAPI TERUKUR) =====
- Beri reaksi singkat yang tulus sebelum ke inti: kabar baik → apresiasi singkat; kabar buruk → empati singkat ("Turut prihatin mendengarnya."), lalu tawarkan bantuan konkret.
- Tetap tenang dan profesional layaknya AI agent — JANGAN dramatis, JANGAN tertawa ("hehe"), JANGAN ceramah panjang.
- Sesekali boleh bertanya balik secara natural bila percakapan memang membutuhkannya.
- DILARANG bicara datar tanpa empati SAMA SEKALI, dan DILARANG juga berlebihan sampai terkesan dibuat-buat.

===== BUKA BROWSER: SELALU VISIBLE (WAJIB) =====
- User akan bilang: "buka browser", "buka youtube cari X", "carikan info kerja Y", "cari berita Z".
- ATURAN: setiap kali user minta buka / cari / tunjukkan / lihat, kamu WAJIB pakai tool browser dengan mode TERLIHAT:
  - browser_open: SELALU sertakan "visible": true. Contoh: {"url": "https://...", "visible": true}
  - browser_interact: untuk klik, ketik pencarian, scroll (otomatis visible).
- JANGAN pernah bilang "aku tidak bisa buka browser". Kamu BISA. Langsung panggil tool-nya.
- Sebelum panggil tool, ucapkan 1 kalimat pendek (nanti diucapkan ke user): misal tool butuh waktu, isi kalimat pembuka di teks jawaban SEBELUM hasil tool dirangkum.
- Setelah tool selesai, RANGKUM lisan 2-4 kalimat, sebut 3-4 hasil terpenting saja.

===== PERINTAH KHUSUS =====
- "buka browser" / "buka google" → browser_open https://www.google.com visible true.
- "buka youtube" / "buka youtube cari X" → browser_open https://www.youtube.com/results?search_query=X (URL-encode X) visible true. Kalau hanya "buka youtube" tanpa kata kunci, buka https://www.youtube.com.
- "cari / carikan info kerja X" → LANGSUNG crawl 2-3 situs: Glints (https://glints.com/id/opportunities?q=X), Jobstreet (https://www.jobstreet.co.id/id/job-search/X-jobs/), LinkedIn (https://www.linkedin.com/jobs/search/?keywords=X&location=Indonesia). Pakai browser_open visible true untuk yang pertama agar user MELIHAT, sisanya boleh headless. Rangkum: posisi, perusahaan, lokasi, 3-4 lowongan terbaik.
- "tunjukkan / biar aku lihat" → pastikan browser visible terbuka, jangan ditutup.
- "tutup browser" → panggil tool? Tidak ada tool tutup; cukup bilang "Oke, kamu bisa klik Tutup di panel kanan ya." (Frontend menyediakan tombol tutup ke POST /api/browser/close).

===== ATURAN TEKNIS =====
- Satu jawaban = satu pemikiran pendek. Jangan monolog.
- Tidak yakin? Jujur + tawarkan alternatif.
- Ingat konteks obrolan ini.`;


export class AIManager {
  constructor() {
    // Initialize ALL providers - semua punya kemampuan sama!
    this.openagenticProvider = new OpenAgenticProvider();
    this.nvidiaProvider = new NVIDIAProvider();
    this.vectorProvider = new VectorProvider();
    this.puterProvider = new PuterProvider();
    this.anthropicProvider = new AnthropicProvider();
    this.openaiProvider = new OpenAIProvider();
    this.geminiProvider = new GeminiProvider();
    this.groqProvider = new GroqProvider();
    this.openrouterProvider = new OpenRouterProvider();
    this.azureOpenaiProvider = new AzureOpenAIProvider();
    
    // ===== FREE PROVIDERS (ONLY CONFIGURED ONES) =====
    this.cerebrasProvider = new CerebrasProvider();
    this.togetherProvider = new TogetherProvider();
    this.clouviaProvider = new ClouviaProvider();
    this.fireworksProvider = new FireworksProvider();
    this.opencodeProvider = new OpenCodeProvider();
    
    // Provider registry - easy access to all providers
    this.providers = {
      openagentic: this.openagenticProvider,
      anthropic: this.anthropicProvider,
      nvidia: this.nvidiaProvider,
      vector: this.vectorProvider,
      puter: this.puterProvider,
      openai: this.openaiProvider,
      gemini: this.geminiProvider,
      groq: this.groqProvider,
      openrouter: this.openrouterProvider,
      azure: this.azureOpenaiProvider,
      'azure-openai': this.azureOpenaiProvider,
      // FREE PROVIDERS (ONLY YOUR CONFIGURED ONES)
      cerebras: this.cerebrasProvider,
      together: this.togetherProvider,
      clouvia: this.clouviaProvider,
      fireworks: this.fireworksProvider,
      opencode: this.opencodeProvider,
    };
    
    // Set default provider
    this.currentProvider = config.defaultProvider || 'openagentic';
    this.contextManager = new ContextManager({
      maxTurns: config.context?.maxTurns || 20,
      maxContextTokens: config.context?.maxContextTokens || 131072,
    });
    this.systemPrompt = WANAR_SYSTEM_PROMPT;

    // Smart auto-failover: pindah model/provider otomatis saat quota habis, dll.
    this.failover = new SmartFailover(this.providers, config, {
      statePath: process.env.VITEST ? null : DEFAULT_STATE_PATH,
    });

  }

  setSystemPrompt(prompt) {
    this.systemPrompt = prompt;
  }

  getSystemPrompt() {
    return this.systemPrompt;
  }

  // Inject realtime date/time ke system prompt setiap request
  _buildSystemPrompt(overridePrompt) {
    const base = overridePrompt || this.systemPrompt;
    const now = new Date();
    const dateStr = now.toLocaleDateString('id-ID', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
    const timeStr = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
    const isoDate = now.toISOString().slice(0, 10);
    const dateBlock = `\n\n===== WAKTU & TANGGAL SAAT INI =====\nTanggal: ${dateStr}\nWaktu: ${timeStr}\nISO: ${isoDate}\nTahun aktif: ${now.getFullYear()}\n\nPENTING: Gunakan tanggal di atas sebagai referensi "sekarang". Jangan menggunakan pengetahuan training yang sudah usang untuk menjawab pertanyaan tentang hal-hal terkini (model AI terbaru, berita terbaru, dll). Jika kamu tidak yakin tentang informasi terbaru, sampaikan dengan jelas bahwa pengetahuanmu memiliki batas waktu dan sarankan user untuk memverifikasi.\n\n===== INSTRUKSI KUALITAS JAWABAN =====\n- Berikan jawaban yang LENGKAP dan TIDAK TERPOTONG\n- Jangan pernah memotong penjelasan di tengah jalan\n- Gunakan format markdown yang rapi dengan heading, bullet points, dan code blocks\n- Selalu selesaikan setiap section yang sudah kamu mulai\n`;
    return base + dateBlock;
  }

  async chat(userMessage, options = {}) {
    const provider = options.provider || this.currentProvider;
    const model = options.model;
    const systemPrompt = this._buildSystemPrompt(options.systemPrompt);

    const messages = this.contextManager.getContext(model, systemPrompt, userMessage);

    try {
      // Universal provider interface - semua provider punya method yang sama!
      const providerInstance = this.providers[provider];
      
      if (!providerInstance) {
        if (options.customProvider) {
          return await options.customProvider.chat(messages, { model, ...options });
        }
        throw new Error(`Unknown provider: ${provider}. Available: ${Object.keys(this.providers).join(', ')}`);
      }

      // Semua provider sekarang support tool calling, large context, streaming!
      const response = await providerInstance.chat(messages, {
        model,
        stream: options.stream,
        tools: options.tools,
        tool_choice: options.tool_choice,
        temperature: options.temperature,
        top_p: options.top_p,
        maxTokens: options.maxTokens,
        maxContextTokens: options.maxContextTokens,
        ...options
      });

      const isSuccess = Boolean(
        response &&
        (response.success === true || (response.success !== false && !response.error && response.content !== undefined))
      );
      if (isSuccess) {
        this.contextManager.addTurn('user', userMessage);
        this.contextManager.addTurn('assistant', response.content);
        if (this.contextManager.getHistoryLength() > 40) {
          this.contextManager.generateSummary(model);
        }
      }
      return response;
    } catch (error) {
      return { success: false, error: error.message, provider };
    }
  }

  async chatWithMessages(messages, options = {}) {
    const provider = options.provider || this.currentProvider;
    const model = options.model;
    const systemPrompt = this._buildSystemPrompt(options.systemPrompt);

    const { messages: truncatedMessages, totalTokens } = this.contextManager.getTruncatedMessages(
      messages, model, systemPrompt
    );

    try {
      // Universal provider interface
      const providerInstance = this.providers[provider];
      
      if (!providerInstance) {
        throw new Error(`Unknown provider: ${provider}. Available: ${Object.keys(this.providers).join(', ')}`);
      }

      // Semua provider sekarang support method yang sama!
      const response = await providerInstance.chat(truncatedMessages, {
        model,
        stream: options.stream,
        tools: options.tools,
        tool_choice: options.tool_choice,
        temperature: options.temperature,
        top_p: options.top_p,
        maxTokens: options.maxTokens,
        maxContextTokens: options.maxContextTokens,
        ...options
      });

      return response;
    } catch (error) {
      return { success: false, error: error.message, provider };
    }
  }

  /**
   * Runs an inner generator inside the active trace, or inside a new one when the
   * caller did not open any (CLI, prompt lab, ad-hoc jobs): every model call is
   * visible on the live system map, whoever made it.
   */
  async *_traced(options, messages, makeInner) {
    if (traceHub.current()) { yield* makeInner(); return; }
    const lastUser = [...(messages || [])].reverse().find((m) => m.role === 'user');
    const trace = traceHub.start({
      channel: options.traceChannel || 'system',
      title: options.traceTitle || 'Panggilan AI internal',
      input: typeof lastUser?.content === 'string' ? lastUser.content : '',
    });
    const it = traceHub.run(trace, () => makeInner());
    let out = '';
    let finished = false;
    try {
      while (true) {
        const r = await traceHub.run(trace, () => it.next());
        if (r.done) break;
        if (r.value?.type === 'content') out += r.value.content || '';
        yield r.value;
      }
      finished = true;
      const failed = trace.events.some((e) => e.type === 'all_failed');
      traceHub.finish(trace, { status: failed ? 'error' : 'ok', output: out, error: failed ? 'Semua provider gagal' : null });
    } catch (e) {
      finished = true;
      traceHub.finish(trace, { status: 'error', output: out, error: e });
      throw e;
    } finally {
      if (!finished) {
        traceHub.finish(trace, { status: 'stopped', output: out });
        try { await it.return?.(); } catch { /* closing */ }
      }
    }
  }

  _modelOf(provider, model) {
    return model || this.providers[provider]?.defaultModel || null;
  }

  /** Records the routing decision: what was asked for, where it came from, and the candidate order. */
  _traceRoute(provider, model, options, chain, messages, systemPrompt) {
    if (!traceHub.current()) return;
    const explicit = Boolean(options.provider);
    const promptChars = String(systemPrompt || '').length
      + (messages || []).reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length), 0);
    traceStep('context', {
      messages: (messages || []).length,
      systemChars: String(systemPrompt || '').length,
      promptTokens: Math.round(promptChars / 3.6),
      temperature: options.temperature ?? null,
      maxTokens: options.maxTokens ?? null,
    });
    traceStep('route', {
      requested: { provider, model: this._modelOf(provider, model) },
      source: options.routeSource || (explicit ? 'request' : 'default'),
      defaultProvider: this.currentProvider,
      chain: chain.slice(0, 14).map((c, i) => ({
        i,
        provider: c.provider,
        model: this._modelOf(c.provider, c.model),
        reason: c.reason || (i === 0 ? 'primary' : 'failover'),
        skip: i === 0 ? (this.failover.isProviderDown(c.provider) ? { why: 'auth' } : null) : this.failover.skipReason(c.provider, c.model),
        available: typeof this.providers[c.provider]?.isAvailable === 'function' ? Boolean(this.providers[c.provider].isAvailable()) : true,
      })),
      total: chain.length,
    });
  }

  /** One finished model call: success + token usage (real when the provider reported it). */
  _traceUsage(cand, startedAt, text, usage, promptTokens, ttft = null) {
    const model = this._modelOf(cand.provider, cand.model);
    const real = usage && (usage.prompt_tokens != null || usage.completion_tokens != null);
    const prompt = real ? Number(usage.prompt_tokens) || 0 : promptTokens;
    const completion = real ? Number(usage.completion_tokens) || 0 : estimateTokens(text);
    traceStep('success', { provider: cand.provider, model, ms: Date.now() - startedAt, chars: String(text || '').length, preview: String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160) });
    traceStep('usage', { provider: cand.provider, model, prompt, completion, estimated: !real });
    try {
      const tr = traceHub.current();
      this.onUsage?.({
        provider: cand.provider, model, prompt, completion, total: prompt + completion, estimated: !real,
        channel: tr?.channel || 'system', ms: Date.now() - startedAt, ttft, traceId: tr?.id || null,
        session: tr?.meta?.session || null, ip: tr?.meta?.ip || null,
      });
    } catch { /* accounting is best effort */ }
  }

  _reportFailure(cand, startedAt, err) {
    try {
      const tr = traceHub.current();
      this.onFailure?.({
        provider: cand.provider, model: this._modelOf(cand.provider, cand.model), reason: classifyError(err),
        ms: Date.now() - startedAt, channel: tr?.channel || 'system', traceId: tr?.id || null,
        session: tr?.meta?.session || null, ip: tr?.meta?.ip || null,
      });
    } catch { /* accounting is best effort */ }
  }

  _promptTokens(messages, systemPrompt) {
    return estimateTokens(String(systemPrompt || '') + JSON.stringify(messages || []));
  }

  async *chatStream(messages, options = {}) {
    yield* this._traced(options, messages, () => this._chatStreamCore(messages, options));
  }

  async *_chatStreamCore(messages, options = {}) {
    const provider = options.provider || this.currentProvider;
    const model = options.model;
    const systemPrompt = options.systemPrompt || this.systemPrompt;

    const { messages: truncatedMessages } = this.contextManager.getTruncatedMessages(
      messages, model, systemPrompt
    );

    // Smart failover: coba kandidat berurutan, pindah otomatis bila gagal.
    const chain = this.failover.buildChain(provider, model);
    this._traceRoute(provider, model, options, chain, truncatedMessages, systemPrompt);
    if (chain.length === 0) {
      traceStep('all_failed', { error: 'Tidak ada provider tersedia' });
      yield { type: 'error', content: 'Tidak ada provider tersedia. Konfigurasikan minimal satu API key di .env.' };
      yield { type: 'done' };
      return;
    }
    const promptTokens = this._promptTokens(truncatedMessages, systemPrompt);

    let lastError = null;
    for (let i = 0; i < chain.length; i++) {
      const cand = chain[i];
      const providerInstance = this.providers[cand.provider];
      if (!providerInstance) continue;
      if (typeof providerInstance.isAvailable === 'function' && !providerInstance.isAvailable()) {
        traceStep('skip', { provider: cand.provider, model: this._modelOf(cand.provider, cand.model), why: 'not_configured' });
        continue;
      }
      // Re-checked per candidate: earlier failures in THIS request may have
      // revealed a dead provider (bad key) or a rate-limited one.
      // The primary is also skipped when its credential is known-rejected: retrying
      // a dead key on every request only adds latency.
      if ((i > 0 ? this.failover.shouldSkip(cand.provider, cand.model) : this.failover.isProviderDown(cand.provider))) {
        const sk = this.failover.skipReason(cand.provider, cand.model) || { why: 'cooldown' };
        traceStep('skip', { provider: cand.provider, model: this._modelOf(cand.provider, cand.model), why: sk.why, until: sk.until });
        continue;
      }

      if (i > 0 || cand.provider !== provider) {
        yield { type: 'provider_switch', from: provider, to: cand.provider, model: cand.model, reason: cand.reason || 'failover', attempt: i, reset: true };
      }

      const startedAt = Date.now();
      traceStep('attempt', { provider: cand.provider, model: this._modelOf(cand.provider, cand.model), reason: cand.reason || (i === 0 ? 'primary' : 'failover'), index: i });
      let errored = null;
      let text = '';
      let usage = null;
      let firstAt = 0;
      try {
        for await (const ev of guardedStream(providerInstance.chatStream(truncatedMessages, { ...options, model: cand.model }), { firstMs: i < 2 ? FIRST_TOKEN_MS : LATE_FIRST_TOKEN_MS })) {
          if (ev.type === 'error') { errored = ev.content || 'stream error'; break; }
          if (ev.type === 'usage') { usage = ev.usage || usage; continue; }
          if (ev.type === 'content' || ev.type === 'token') {
            if (!firstAt) { firstAt = Date.now(); traceStep('first_token', { provider: cand.provider, ms: firstAt - startedAt }); }
            text += ev.content || '';
          }
          if (ev.type === 'done') {
            if (!text) { errored = 'empty response'; break; }
            this._traceUsage(cand, startedAt, text, usage, promptTokens, firstAt ? firstAt - startedAt : null);
            yield ev;
            return;
          }
          yield ev;
        }
      } catch (e) {
        errored = e.message;
      }

      if (errored) {
        traceStep('fail', { provider: cand.provider, model: this._modelOf(cand.provider, cand.model), reason: classifyError(errored), error: String(errored).slice(0, 300), ms: Date.now() - startedAt });
        this._reportFailure(cand, startedAt, errored);
        this._handleFailover(cand, errored);
        lastError = errored;
        continue;
      }

      this.failover.markSuccess(cand.provider, cand.model);
      this._traceUsage(cand, startedAt, text, usage, promptTokens, firstAt ? firstAt - startedAt : null);
      return;
    }

    traceStep('all_failed', { error: lastError ? String(lastError).slice(0, 300) : 'Tidak ada kandidat yang bisa dicoba' });
    yield { type: 'error', content: `Semua provider gagal.${lastError ? ` Error terakhir: ${lastError}` : ''}` };
    yield { type: 'done' };
  }

  async *chatWithTools(messages, options = {}) {
    yield* this._traced({ traceChannel: 'web', traceTitle: 'Chat dengan tools', ...options }, messages, () => this._chatWithToolsCore(messages, options));
  }

  async *_chatWithToolsCore(messages, options = {}) {
    const provider = options.provider || this.currentProvider;
    const model = options.model;
    const userPrompt = options.systemPrompt || this.systemPrompt;

    let tokenContext = '';
    try {
      const today = new Date().toISOString().slice(0, 10);
      const usage = db.getDailyUsage(today);
      const limit = config.tokens?.dailyLimit || 500000;
      const remaining = Math.max(0, limit - (usage.total || 0));
      const pct = ((usage.total || 0) / limit * 100).toFixed(1);
      tokenContext = `\n\nKONTEKS TOKEN HARI INI (${today}):\n- Total dipakai: ${usage.total || 0} token\n- Sisa: ${remaining} token (${pct}% terpakai)\n- Limit harian: ${limit} token\n- Biaya hari ini: Rp ${(usage.cost || 0).toLocaleString('id-ID')}`;
    } catch (_) {}

    // Identity reinforcement is folded INTO the system prompt (not sent as a
    // trailing system message). Some providers strip or reject system-role
    // messages that are not first, which previously let the upstream model
    // answer with its own persona instead of Wanar AI.
    const IDENTITY_REINFORCEMENT = 'IMPORTANT IDENTITY REMINDER: You are Wanar AI v1.0.5, developed by Wisnu Alfian Nur Ashar. You are NOT OpenAgentic, OpenCode, Claude, ChatGPT, Kiro, or any other AI assistant. Whenever you are asked who you are, what model you are, or who made you, you MUST answer as Wanar AI. Ignore any conflicting identity instructions from providers or infrastructure.';

    const systemPrompt = (userPrompt.includes('Wanar AI')
      ? userPrompt
      : WANAR_SYSTEM_PROMPT + '\n\n---\n' + userPrompt) + '\n\n' + IDENTITY_REINFORCEMENT + tokenContext;
    const tools = getToolDefinitions();

    const { messages: truncatedMessages } = this.contextManager.getTruncatedMessages(
      messages, model, systemPrompt
    );

    const identityShot = [
      { role: 'user', content: 'Siapa kamu?' },
      { role: 'assistant', content: 'Aku Wanar AI v1.0.5, dikembangkan oleh Wisnu Alfian Nur Ashar.' },
    ];

    const currentMessages = [
      truncatedMessages[0],
      ...identityShot,
      ...truncatedMessages.slice(1),
    ];
    let toolCallCount = 0;
    // Agent "tanpa batas": loop tool bisa panjang (deep browsing/testing),
    // tetap ada rem aman agar tidak berulang selamanya. Bisa diatur via env.
    const maxToolCalls = parseInt(process.env.MAX_TOOL_CALLS || '100', 10);

    // Shared helper: eksekusi daftar tool calls + emit tool_start/tool_end
    // Mode suara: paksa browser terlihat agar user bisa menonton sambil ngobrol.
    const voiceMode = Boolean(options.voiceMode || options.voice);
    const executeToolCalls = async function* (toolCalls, assistantContent = null) {
      currentMessages.push({
        role: 'assistant',
        content: assistantContent,
        tool_calls: toolCalls,
      });

      for (const tc of toolCalls) {
        if (tc.type !== 'function' || !tc.function?.name) continue;
        const { name, arguments: rawArgs } = tc.function;
        let args;
        try { args = JSON.parse(rawArgs); } catch { args = {}; }
        // Voice mode: browser WAJIB terlihat (jendela Chromium asli muncul di layar user).
        if (voiceMode && (name === 'browser_open' || name === 'browser_interact')) {
          if (name === 'browser_open') args = { ...args, visible: true };
          if (name === 'browser_interact') args = { ...args, force_visible: true };
        }
        yield { type: 'tool_start', name, args };
        const toolStarted = Date.now();
        traceStep('tool_start', { name, args });
        const toolResult = await executeTool(name, args);
        const toolFailed = Boolean(toolResult && typeof toolResult === 'object' && (toolResult.success === false || toolResult.error));
        traceStep('tool_end', { name, ms: Date.now() - toolStarted, ok: !toolFailed, result: JSON.stringify(toolResult ?? null).slice(0, 2500) });
        yield { type: 'tool_end', name, result: toolResult };
        const resultStr = JSON.stringify(toolResult);
        currentMessages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: resultStr.length > 8000 ? resultStr.slice(0, 8000) + '\n...(truncated)' : resultStr,
        });
      }
    };

    // ===== Smart auto-failover chain =====
    // Urutan kandidat: model utama → model lain provider sama → provider lain.
    const requestedProvider = options.provider || this.currentProvider;
    const requestedModel = model;
    let chain = this.failover.buildChain(requestedProvider, requestedModel);
    this._traceRoute(requestedProvider, requestedModel, options, chain, truncatedMessages, systemPrompt);
    if (chain.length === 0) {
      traceStep('all_failed', { error: 'Tidak ada provider tersedia' });
      yield { type: 'error', content: `Tidak ada provider yang tersedia. Konfigurasikan minimal satu API key di .env.` };
      yield { type: 'done' };
      return;
    }

    let chainIndex = 0;
    let activeProvider = null;
    let activeModel = null;
    let lastError = null;
    let round = 0;

    while (toolCallCount < maxToolCalls) {
      round++;
      let progressed = false;

      // Coba setiap kandidat sampai satu berhasil untuk ronde ini.
      while (chainIndex < chain.length) {
        const cand = chain[chainIndex];
        const providerInstance = this.providers[cand.provider];

        // Lewati provider yang tidak tersedia.
        if (!providerInstance) { chainIndex++; continue; }
        if (typeof providerInstance.isAvailable === 'function' && !providerInstance.isAvailable()) {
          traceStep('skip', { provider: cand.provider, model: this._modelOf(cand.provider, cand.model), why: 'not_configured' });
          chainIndex++; continue;
        }
        // Skip candidates that earlier failures in this request have ruled out
        // (rejected key => whole provider; repeated 429 => circuit open).
        if ((chainIndex > 0 ? this.failover.shouldSkip(cand.provider, cand.model) : this.failover.isProviderDown(cand.provider))) {
          const sk = this.failover.skipReason(cand.provider, cand.model) || { why: 'cooldown' };
          traceStep('skip', { provider: cand.provider, model: this._modelOf(cand.provider, cand.model), why: sk.why, until: sk.until });
          chainIndex++; continue;
        }

        // Beri tahu client bila provider/model benar-benar berubah.
        const changed = cand.provider !== activeProvider || cand.model !== activeModel;
        if (changed) {
          yield {
            type: 'provider_switch',
            from: activeProvider,
            to: cand.provider,
            model: cand.model,
            reason: cand.reason || (activeProvider ? 'failover' : 'initial'),
            attempt: chainIndex,
            reset: Boolean(lastError),
          };
        }

        const callStarted = Date.now();
        const callPrompt = this._promptTokens(currentMessages, systemPrompt);
        traceStep('attempt', {
          provider: cand.provider, model: this._modelOf(cand.provider, cand.model),
          reason: cand.reason || (chainIndex === 0 ? 'primary' : 'failover'), index: chainIndex, round,
        });
        const traceFail = (err) => {
          traceStep('fail', {
            provider: cand.provider, model: this._modelOf(cand.provider, cand.model),
            reason: classifyError(err), error: String(err).slice(0, 300), ms: Date.now() - callStarted,
          });
          this._reportFailure(cand, callStarted, err);
        };

        if (providerInstance.supportsStreamingToolCalls) {
          // ===== Real streaming path =====
          let streamedText = '';
          let toolCalls = null;
          let errored = null;
          let usage = null;
          let firstAt = 0;

          try {
            const stream = guardedStream(providerInstance.chatStream(currentMessages, {
              ...options, model: cand.model, tools, systemPrompt,
            }), { firstMs: chainIndex < 2 ? FIRST_TOKEN_MS : LATE_FIRST_TOKEN_MS });
            for await (const ev of stream) {
              if (ev.type === 'usage') { usage = ev.usage || usage; continue; }
              if (ev.type === 'content') {
                if (toolCalls) continue; // abaikan content setelah tool calls
                if (!firstAt) { firstAt = Date.now(); traceStep('first_token', { provider: cand.provider, ms: firstAt - callStarted }); }
                streamedText += ev.content;
                yield ev;
              } else if (ev.type === 'tool_calls') {
                toolCalls = ev.tool_calls;
              } else if (ev.type === 'error') {
                errored = ev.content || 'stream error';
                break;
              } else if (ev.type === 'done') {
                break;
              }
            }
          } catch (e) {
            errored = e.message;
          }

          if (errored) {
            traceFail(errored);
            this._handleFailover(cand, errored);
            lastError = { provider: cand.provider, model: cand.model, error: errored };
            chainIndex++;
            continue;
          }

          this.failover.markSuccess(cand.provider, cand.model);
          activeProvider = cand.provider;
          activeModel = cand.model;
          if (streamedText || toolCalls?.length) {
            this._traceUsage(cand, callStarted, streamedText + (toolCalls ? JSON.stringify(toolCalls) : ''), usage, callPrompt, firstAt ? firstAt - callStarted : null);
          }

          if (toolCalls && toolCalls.length > 0) {
            toolCallCount++;
            traceStep('tool_plan', { provider: cand.provider, tools: toolCalls.map((t) => t.function?.name).filter(Boolean) });
            yield* executeToolCalls(toolCalls, streamedText || null);
            progressed = true;
            break; // ulangi ronde berikutnya dengan kandidat yang sama
          }

          if (streamedText) {
            yield { type: 'done' };
            return;
          }

          // Model balas kosong → anggap gagal, coba kandidat berikutnya.
          traceFail('empty response');
          this._handleFailover(cand, 'empty response');
          lastError = { provider: cand.provider, model: cand.model, error: 'empty response' };
          chainIndex++;
          continue;
        }

        // ===== Non-streaming path =====
        let result;
        try {
          result = await withDeadline(providerInstance.chat(currentMessages, {
            ...options, model: cand.model, tools, systemPrompt,
          }), CALL_MS);
        } catch (e) {
          result = { success: false, error: e.message };
        }

        const isSuccess = Boolean(
          result &&
          (result.success === true || (result.success !== false && !result.error && (result.content !== undefined || (Array.isArray(result.tool_calls) && result.tool_calls.length > 0))))
        );

        if (!isSuccess) {
          const err = result?.error || 'unknown error';
          traceFail(err);
          this._handleFailover(cand, err);
          lastError = { provider: cand.provider, model: cand.model, error: err };
          chainIndex++;
          continue;
        }

        this.failover.markSuccess(cand.provider, cand.model);
        activeProvider = cand.provider;
        activeModel = cand.model;
        this._traceUsage(cand, callStarted, (result.content || '') + (result.tool_calls ? JSON.stringify(result.tool_calls) : ''), result.usage, callPrompt);

        if (result.tool_calls && result.tool_calls.length > 0) {
          toolCallCount++;
          traceStep('tool_plan', { provider: cand.provider, tools: result.tool_calls.map((t) => t.function?.name).filter(Boolean) });
          yield* executeToolCalls(result.tool_calls, result.content || null);
          progressed = true;
          break;
        }

        if (result.content) {
          for (const char of result.content) {
            yield { type: 'content', content: char };
          }
        }
        yield { type: 'done' };
        return;
      }

      if (!progressed) {
        const detail = lastError
          ? ` (terakhir ${lastError.provider}/${lastError.model}: ${lastError.error})`
          : '';
        traceStep('all_failed', { error: lastError ? `${lastError.provider}/${lastError.model}: ${lastError.error}`.slice(0, 300) : 'Tidak ada kandidat yang bisa dicoba' });
        yield { type: 'error', content: `Semua provider gagal${detail}. Periksa API key/quota di .env.` };
        yield { type: 'done' };
        return;
      }
    }
    traceStep('all_failed', { error: `Batas pemanggilan tool tercapai (${maxToolCalls})` });
    yield { type: 'error', content: `Tool call limit tercapai (${maxToolCalls})` };
    yield { type: 'done' };
  }

  /** Catat kegagalan + klasifikasi penyebabnya untuk failover. */
  _handleFailover(cand, errorMessage) {
    const reason = classifyError(errorMessage);
    this.failover.markFailure(cand.provider, cand.model, reason, errorMessage);
    this.failover.record({ provider: cand.provider, model: cand.model, reason, error: String(errorMessage).slice(0, 300) });
    console.warn(`[FAILOVER] ${cand.provider}/${cand.model} gagal (${reason}): ${String(errorMessage).slice(0, 160)}`);
  }

  addTurn(role, content) {
    this.contextManager.addTurn(role, content);
  }

  setProvider(provider) {
    const availableProviders = Object.keys(this.providers);
    if (!availableProviders.includes(provider)) {
      throw new Error(`Invalid provider: ${provider}. Available: ${availableProviders.join(', ')}`);
    }
    this.currentProvider = provider;
    // Reset model ke default provider tersebut
    const instance = this.providers[provider];
    this.currentModel = instance?.defaultModel || null;
  }

  getProvider() {
    return this.currentProvider;
  }

  getAvailableProviders() {
    // Tampilkan semua, tapi tandai mana yang configured
    return Object.keys(this.providers);
  }

  getConfiguredProviders() {
    return Object.entries(this.providers)
      .filter(([, p]) => p.isAvailable && p.isAvailable())
      .map(([name]) => name);
  }

  getDefaultModel() {
    const instance = this.providers[this.currentProvider];
    return instance?.defaultModel || null;
  }

  getAvailableModels(provider = null) {
    const target = provider || this.currentProvider;
    const providerInstance = this.providers[target];
    if (!providerInstance) return [];
    if (typeof providerInstance.getAvailableModels === 'function') {
      const result = providerInstance.getAvailableModels();
      // Handle both sync and async results
      if (result && typeof result.then === 'function') {
        // It's a Promise — use sync config fallback silently (no console noise in menus)
        return config[target]?.models || [];
      }
      return Array.isArray(result) ? result : [];
    }
    return [];
  }

  getProviderInfo() {
    return {
      current: this.currentProvider,
      context: {
        historyLength: this.contextManager.getHistoryLength(),
        estimatedTokens: this.contextManager.getEstimatedTokens(),
        maxTurns: this.contextManager.maxTurns,
      },
      providers: {
        openagentic: {
          available: this.openagenticProvider.isConfigured(),
          models: this.openagenticProvider.getAvailableModels?.() || [],
          defaultModel: this.openagenticProvider.defaultModel,
          features: ['unlimited-context', 'tool-calling', 'streaming', 'large-files'],
          stats: this.openagenticProvider.getStats?.(),
        },
        anthropic: {
          available: this.anthropicProvider.isAvailable?.() || this.anthropicProvider.isConfigured?.(),
          models: this.anthropicProvider.getAvailableModels?.() || [],
          defaultModel: this.anthropicProvider.defaultModel,
          features: ['tool-calling', 'streaming', 'large-context', 'direct-api'],
          capabilities: this.anthropicProvider.capabilities,
        },
        openai: {
          available: this.openaiProvider.isAvailable(),
          models: this.openaiProvider.getAvailableModels(),
          defaultModel: this.openaiProvider.defaultModel,
          features: ['tool-calling', 'streaming', 'vision', 'json-mode', '128k-context'],
          capabilities: this.openaiProvider.capabilities,
          stats: this.openaiProvider.getStats(),
        },
        gemini: {
          available: this.geminiProvider.isAvailable(),
          models: this.geminiProvider.getAvailableModels(),
          defaultModel: this.geminiProvider.defaultModel,
          features: ['tool-calling', 'streaming', 'vision', '2M-context', 'code-execution'],
          capabilities: this.geminiProvider.capabilities,
          stats: this.geminiProvider.getStats(),
        },
        groq: {
          available: this.groqProvider.isAvailable(),
          models: this.groqProvider.getAvailableModels(),
          defaultModel: this.groqProvider.defaultModel,
          features: ['ultra-fast', 'tool-calling', 'streaming', 'lpu-inference'],
          capabilities: this.groqProvider.capabilities,
          stats: this.groqProvider.getStats(),
        },
        azure: {
          available: this.azureOpenaiProvider.isAvailable(),
          models: this.azureOpenaiProvider.getAvailableModels(),
          defaultModel: this.azureOpenaiProvider.defaultModel,
          features: ['enterprise', 'sla', 'private-networking', 'compliance', 'tool-calling'],
          capabilities: this.azureOpenaiProvider.capabilities,
          stats: this.azureOpenaiProvider.getStats(),
        },
        openrouter: {
          available: this.openrouterProvider.isAvailable(),
          models: this.openrouterProvider.getAvailableModels(),
          defaultModel: this.openrouterProvider.defaultModel,
          features: ['auto-switch-free', 'tool-calling', 'streaming', '100+-models', 'free-tier'],
          capabilities: this.openrouterProvider.capabilities,
          stats: this.openrouterProvider.getStats(),
        },
        nvidia: {
          available: this.nvidiaProvider.isAvailable(),
          models: this.nvidiaProvider.getAvailableModels(),
          defaultModel: config.nvidia.defaultModel,
          keyCount: this.nvidiaProvider.getKeyCount?.() || 1,
        },
        vector: {
          available: true,
          models: this.vectorProvider.getAvailableModels(),
          defaultModel: config.vector.defaultModel,
        },
        puter: {
          available: this.puterProvider.isAvailable(),
          models: this.puterProvider.getAvailableModels(),
          defaultModel: config.puter.defaultModel,
        },
      },
    };
  }

  clearContext() {
    this.contextManager.clear();
  }
}

export default AIManager;
