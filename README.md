# 🤖 Wanar AI v1.0

**Professional AI Agent with Dual Provider Support**  
Yunwu.ai (GPT-4o / Claude / Gemini) + Puter.js (Free Claude API)

---

## 📋 Daftar Isi

- [Instalasi](#-instalasi)
- [Cara Menjalankan](#-cara-menjalankan)
- [Mode CLI (Terminal)](#-mode-cli-terminal)
- [Mode Web Server (Chatbot UI)](#-mode-web-server-chatbot-ui)
- [Dual Provider System](#-dual-provider-system)
- [Commands CLI](#-commands-cli)
- [Available Models](#-available-models)
- [Struktur Project](#-struktur-project)
- [Troubleshooting](#-troubleshooting)

---

## ⚡ Instalasi

### Prasyarat
- Node.js 18+ (download di [nodejs.org](https://nodejs.org))
- NPM (sudah termasuk dengan Node.js)

### Langkah Instalasi

`ash
# 1. Pindah ke folder project
cd D:\wanar-ai

# 2. Install dependencies (hanya sekali)
npm install
`

---

## 🚀 Cara Menjalankan

Ada **3 cara** untuk menjalankan Wanar AI:

### 📟 Mode CLI (Terminal)

Chat langsung dari terminal Windows/PowerShell:

`ash
# Cara 1 - Langsung
node src/cli.js

# Cara 2 - Via npm script
npm run cli
`

**Tampilan:**
`
╔═══════════════════════════════════════════════════════════╗
║                    WANAR AI v1.0                          ║
║         Professional AI Agent Terminal Interface          ║
╚═══════════════════════════════════════════════════════════╝

Current Provider: YUNWU
Available Models: gpt-4o, gpt-4-turbo, claude-3-5-sonnet, gemini-2.0-flash

Commands:
  /help        - Show help
  /provider    - Switch provider (yunwu/puter)
  /model       - Change model
  /clear       - Clear conversation history
  /info        - Show provider info
  /exit        - Exit Wanar AI

You: Halo, siapa kamu?
Wanar AI: Halo! Saya Wanar AI, asisten AI profesional Anda...

[YUNWU - gpt-4o] Tokens: 58
`

### 🌐 Mode Web Server (Chatbot UI)

Buka di browser dengan tampilan chat modern:

`ash
# Cara 1 - Langsung
node src/server.js

# Cara 2 - Via npm script
npm run web
`

Setelah server berjalan, buka browser dan akses:
`
http://localhost:3000
`

**Fitur Web UI:**
- Tampilan chat modern dengan tema dark
- Dropdown untuk pilih provider (Yunwu.ai / Puter.js)
- Dropdown untuk pilih model
- Tombol Clear Chat
- Riwayat percakapan

### 🎯 Mode Interaktif (Pilih sendiri)

Pilih antara CLI atau Web Server saat startup:

`ash
# Cara 1 - Langsung
node src/index.js

# Cara 2 - Via npm script
npm start
`

Nanti akan muncul pilihan:
`
=======================================================
  WANAR AI v1.0 - Professional AI Agent
  Dual Provider: Yunwu.ai + Puter.js
=======================================================

Select interface:
  1) Terminal CLI  - Chat directly in terminal
  2) Web Server   - Open web interface in browser

Enter choice (1 or 2):
`

---

## 🔄 Dual Provider System

Wanar AI mendukung **dua provider AI** yang bisa dipilih sesuai kebutuhan:

### Provider 1: Yunwu.ai
- **Models:** GPT-4o, GPT-4-turbo, Claude 3.5 Sonnet, Gemini 2.0 Flash
- **Cocok untuk:** Semua kebutuhan, performa stabil
- **Konfigurasi:** Sudah terisi API key (.env)

### Provider 2: Puter.js
- **Models:** Claude Fable 5, Claude Sonnet 5, Claude Opus 4.8, Claude Haiku 4.5
- **Cocok untuk:** Akses Claude gratis tanpa API key
- **Catatan:** Hanya berfungsi di Web UI (browser)

### Cara Switch Provider

**Di CLI (Terminal):**
`ash
# Cek provider saat ini
/provider

# Ganti ke Puter.js
/provider puter

# Ganti ke Yunwu.ai
/provider yunwu

# Lihat model yang tersedia
/model
`

**Di Web UI:**
- Gunakan dropdown "Provider" di bagian atas
- Pilih "Yunwu.ai" atau "Puter.js"
- Model akan otomatis menyesuaikan

---

## ⌨️ Commands CLI

| Command | Fungsi | Contoh |
|---------|--------|--------|
| /help | Menampilkan bantuan | /help |
| /provider | Cek atau ganti provider | /provider puter |
| /model | Lihat model tersedia | /model |
| /clear | Hapus riwayat chat | /clear |
| /info | Info detail provider | /info |
| /exit | Keluar dari Wanar AI | /exit |

---

## 🧠 Available Models

### Yunwu.ai
| Model | Provider | Deskripsi |
|-------|----------|-----------|
| gpt-4o | OpenAI | Model paling stabil & cepat (default) |
| gpt-4-turbo | OpenAI | GPT-4 versi turbo |
| claude-3-5-sonnet-20241022 | Anthropic | Claude Sonnet terbaru |
| gemini-2.0-flash | Google | Gemini 2.0 Flash |

### Puter.js (Free Claude)
| Model | Provider | Deskripsi |
|-------|----------|-----------|
| claude-fable-5 | Anthropic | Claude paling canggih |
| claude-sonnet-5 | Anthropic | Claude Sonnet 5 (default) |
| claude-opus-4.8-fast | Anthropic | Claude Opus mode cepat |
| claude-opus-4-8 | Anthropic | Claude Opus standar |
| claude-haiku-4-5 | Anthropic | Claude Haiku ringan |

---

## 📁 Struktur Project

`
D:\wanar-ai
├── config/
│   └── config.js              # Dual provider configuration
├── src/
│   ├── index.js               # Main entry point
│   ├── cli.js                 # Terminal CLI interface
│   ├── server.js              # Web server
│   ├── ai-manager.js          # AI provider manager
│   └── providers/
│       ├── yunwu.js           # Yunwu.ai provider
│       └── puter.js           # Puter.js provider (Free Claude API)
├── public/
│   ├── index.html             # Web UI
│   ├── css/style.css          # Styling
│   └── js/app.js              # Frontend logic
├── .env                       # Environment variables
├── .env.example               # Template environment
└── package.json               # Dependencies
`

---

## 🔧 Troubleshooting

### Error: 'node' is not recognized
Install Node.js dari https://nodejs.org (pilih LTS version)

### Error: Cannot find module 'express'
`ash
cd D:\wanar-ai
npm install
`

### Error: Port 3000 already in use
Edit file .env dan ganti PORT=3000 ke port lain (misal PORT=4000)

### Error: etch is not defined
Update Node.js ke versi 18+:
`ash
node --version
`

### API Yunwu.ai tidak merespon
`ash
# Test API key
curl https://yunwu.ai/v1/chat/completions ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer YOUR_API_KEY" ^
  -d "{\"model\":\"gpt-4o\",\"messages\":[{\"role\":\"user\",\"content\":\"test\"}]}"
`

### Puter.js tidak berfungsi di CLI
Puter.js membutuhkan browser environment. Gunakan **Mode Web Server** (
pm run web) untuk menggunakan Puter.js.

---

## 📝 Quick Reference

`ash
# Install dependencies
cd D:\wanar-ai && npm install

# Mode CLI (terminal interaktif)
npm run cli

# Mode Web (buka di browser http://localhost:3000)
npm run web

# Mode pilihan (pilih CLI atau Web)
npm start
`

---

**Wanar AI v1.0**  
Professional AI Agent | Ashar Grosir Perfume Management System  
Dibuat: 18 Juli 2026
