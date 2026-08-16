<div align="center">

<img src="client/public/logo.png" alt="Wanar AI Logo" width="120" />

# Wanar AI v2.0

**Platform AI Chat Multi-Provider + Autonomous Job Application Agent**

Dibuat oleh **Wisnu Alfian Nur Ashar**

[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=flat-square&logo=node.js)](https://nodejs.org)
[![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react)](https://react.dev)
[![Playwright](https://img.shields.io/badge/Playwright-1.x-45ba4b?style=flat-square)](https://playwright.dev)
[![SQLite](https://img.shields.io/badge/SQLite-WAL-003B57?style=flat-square&logo=sqlite)](https://sqlite.org)
[![License](https://img.shields.io/badge/License-Private-red?style=flat-square)](./LICENSE)

</div>

---

## Tampilan UI

![Wanar AI Chat Interface](client/public/UI/chatui.png)

---

## Deskripsi

Wanar AI adalah platform AI pribadi yang menggabungkan:

- **AI Chat** dengan 53+ model dari berbagai provider (Claude, GPT-4o, Gemini, DeepSeek, dll)
- **Job Application Agent** — crawl lowongan kerja, deteksi form, isi otomatis, dan submit lamaran tanpa campur tangan manual
- **Database lokal** berbasis SQLite — semua data tersimpan di mesin kamu sendiri, tidak ada yang dikirim ke server luar

---

## Fitur Utama

### AI Chat
- Multi-provider: OpenAgentic (53 model), NVIDIA, Puter.js (gratis)
- Streaming SSE real-time
- Session history dengan sidebar
- Provider & model selector langsung dari input bar
- Context window management otomatis

### Job Application Agent
- Crawl halaman listing lowongan (Linktree, Glints, Jobstreet, dll)
- Deteksi Google Forms secara otomatis
- Isi form otomatis: nama, email, nomor HP, universitas, jurusan, IPK, LinkedIn, dll
- Generate cover letter personal per perusahaan
- Submit + verifikasi konfirmasi halaman
- Mode CDP: connect ke Chrome yang sudah login untuk hindari CAPTCHA
- Audio CAPTCHA solver gratis (tanpa API key berbayar)
- Live feed SSE — monitor setiap langkah secara real-time
- Review queue untuk field yang perlu persetujuan manual
- Trusted Mode: auto-submit jika confidence field ≥85%

### Keamanan & Privasi
- Semua data tersimpan lokal di SQLite (tidak ada cloud sync)
- API key dibaca dari `.env` — tidak pernah hardcoded
- Database tidak pernah di-push ke GitHub

---

## Instalasi

### Prasyarat

- Node.js 18+ — [nodejs.org](https://nodejs.org)
- Google Chrome (untuk mode CDP)
- Windows 10/11

### Setup

```bash
# 1. Clone repo
git clone https://github.com/wi5nuu/WANAR-AI.git
cd WANAR-AI

# 2. Install dependencies backend
npm install

# 3. Install dependencies frontend
cd client && npm install && cd ..

# 4. Salin template environment
cp .env.example .env
# Edit .env dan isi API key kamu

# 5. Build frontend
cd client && npm run build && cd ..

# 6. Jalankan server
node src/server.js
```

Buka browser di `http://localhost:3000`

---

## Konfigurasi `.env`

```env
# Provider utama
OPENAGENTIC_API_KEY=your_key_here
OPENAGENTIC_BASE_URL=https://openagentic.id/api/v1

# NVIDIA (opsional)
NVIDIA_API_KEY=your_key_here

# Server
PORT=3000
HOST=localhost

# Batas penggunaan harian
DAILY_TOKEN_LIMIT=300000000
DAILY_COST_LIMIT_USD=50
```

Lihat `.env.example` untuk daftar lengkap konfigurasi.

---

## Cara Pakai Job Agent

1. Buka `http://localhost:3000/job-agent`
2. Klik **Launch Chrome CDP** — agent akan connect ke Chrome yang sudah login Google
3. Klik **Sesi Baru**
4. Isi URL listing lowongan (contoh: `https://linktr.ee/icc_pu`)
5. Centang **Trusted Mode** untuk auto-submit langsung
6. Klik **Mulai** dan monitor live feed

---

## Struktur Project

```
wanar-ai/
├── client/                    # Frontend React + Vite
│   ├── src/
│   │   ├── components/        # JobAgent, Chat, Sidebar, dll
│   │   └── styles/
│   └── public/
│       ├── logo.png
│       └── UI/chatui.png
├── src/                       # Backend Node.js Express
│   ├── server.js              # Entry point + semua endpoint
│   ├── ai-manager.js          # Multi-provider AI manager
│   ├── database.js            # SQLite CRUD
│   └── tools/
│       ├── job-agent.js       # Engine autonomous job agent
│       ├── browser.js         # Playwright browser tools
│       └── registry.js        # Tool registry
├── config/
│   └── config.js              # Provider configuration
├── .env.example               # Template konfigurasi
└── package.json
```

---

## Tech Stack

| Layer | Teknologi |
|-------|-----------|
| Backend | Node.js, Express, SQLite (better-sqlite3) |
| Frontend | React 19, Vite, CSS Variables |
| Browser Automation | Playwright (Chromium + CDP) |
| AI Providers | OpenAgentic, NVIDIA, Puter.js |
| Realtime | Server-Sent Events (SSE) |
| Database | SQLite WAL mode (lokal) |

---

## Catatan Keamanan

- File `.env` tidak pernah di-push ke GitHub (ada di `.gitignore`)
- Database SQLite (`data/`) tidak di-push — berisi data pribadi
- Repo ini bersifat **Private** — tidak untuk distribusi publik
- Jangan share API key kamu kepada siapapun

---

<div align="center">

**Wanar AI v2.0** — Dibuat oleh Wisnu Alfian Nur Ashar · 2026

</div>
