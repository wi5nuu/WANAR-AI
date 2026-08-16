<div align="center">

<img src="client/public/logo.png" alt="Wanar AI" width="100" />

# Wanar AI v1.0.1

**Professional AI Chat Platform + Autonomous Job Application Agent**

by Wisnu Alfian Nur Ashar

![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=flat-square&logo=node.js&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black)
![Playwright](https://img.shields.io/badge/Playwright-Automation-45ba4b?style=flat-square)
![SQLite](https://img.shields.io/badge/SQLite-Local%20DB-003B57?style=flat-square&logo=sqlite)
![Version](https://img.shields.io/badge/Version-1.0.1-blue?style=flat-square)
![License](https://img.shields.io/badge/License-Private-red?style=flat-square)

</div>

---

![Wanar AI Interface](client/public/UI/chatui.png)

---

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [Running the Application](#running-the-application)
- [Using the AI Chat](#using-the-ai-chat)
- [Using the Job Agent](#using-the-job-agent)
- [Profile Setup](#profile-setup)
- [Project Structure](#project-structure)
- [API Endpoints](#api-endpoints)
- [Tech Stack](#tech-stack)
- [Changelog](#changelog)

---

## Overview

Wanar AI is a self-hosted AI platform that runs entirely on your local machine. It combines a professional multi-model AI chat interface with an autonomous job application agent capable of crawling job listings, detecting Google Forms, filling them out field by field, and submitting — all without manual intervention.

All data stays local. No cloud sync. No third-party data collection.

---

## Features

### AI Chat

- 53+ models from multiple providers: Claude (Anthropic), GPT-4o, Gemini, DeepSeek, Llama, and more
- Real-time streaming responses via Server-Sent Events (SSE)
- Session history with sidebar navigation and title ellipsis
- Provider and model selector directly in the input bar
- Automatic context window management and summarization
- RAG (Retrieval Augmented Generation) support for codebase indexing

### Job Application Agent

- Crawl job listing pages: Linktree, Glints, Jobstreet, LinkedIn, Google Sheets, and more
- Automatic Google Forms detection and field extraction
- Smart field mapping to your profile: name, email, phone, university, major, GPA, LinkedIn, GitHub, and 30+ more fields
- Index-based form fill — directly targets each field container in the DOM, not fragile label matching
- Mouse movement simulation before every click (anti-bot detection)
- Auto-generated cover letter per company and position
- Scroll to bottom + hover before submit (natural behavior)
- Confirmation page verification after submit
- Chrome CDP integration — connects to your already-logged-in Chrome to avoid CAPTCHA
- Audio CAPTCHA solver (free, no paid API required)
- Real-time live feed with per-field fill monitoring via SSE
- Review queue for fields requiring manual approval
- Trusted Mode: auto-submit when field confidence is 85% or above
- Session pause, resume, and abort support
- Full apply history stored in local SQLite database

### Privacy and Security

- SQLite database stored locally in `data/` — never pushed to any server
- API keys loaded from `.env` file — never hardcoded in source
- `.gitignore` covers all sensitive files: `.env`, `data/`, `*.traineddata`, `node_modules/`

---

## Requirements

- Node.js 18 or higher — [nodejs.org](https://nodejs.org)
- Google Chrome (for CDP mode)
- Windows 10/11
- Git

---

## Installation

```bash
# 1. Clone the repository
git clone https://github.com/wi5nuu/WANAR-AI.git
cd WANAR-AI

# 2. Install backend dependencies
npm install

# 3. Install frontend dependencies
cd client && npm install && cd ..

# 4. Copy environment template and fill in your API keys
cp .env.example .env

# 5. Build the frontend
cd client && npm run build && cd ..
```

---

## Configuration

Copy `.env.example` to `.env` and fill in your values:

```env
# Required — main AI provider
OPENAGENTIC_API_KEY=your_key_here
OPENAGENTIC_BASE_URL=https://openagentic.id/api/v1

# Optional — additional providers
NVIDIA_API_KEY=your_key_here

# Server
PORT=3000
HOST=localhost

# Usage limits (optional)
DAILY_TOKEN_LIMIT=300000000
DAILY_COST_LIMIT_USD=50
```

See `.env.example` for the full list of available options.

---

## Running the Application

```bash
# Start the server (serves both API and frontend)
node src/server.js

# Or use npm script
npm run web
```

Open your browser at `http://localhost:3000`

---

## Using the AI Chat

1. Open `http://localhost:3000`
2. Select a provider and model from the selector in the input bar
3. Type your message and press Enter or click Send
4. Sessions are saved automatically in the sidebar
5. Click any session to resume the conversation

### Available Providers

| Provider | Models | Notes |
|----------|--------|-------|
| OpenAgentic | 53+ models | Requires API key |
| NVIDIA | Llama, Mistral, etc. | Requires API key |
| Puter.js | Claude, GPT-4o | Free, browser-based |

---

## Using the Job Agent

### Step 1: Launch Chrome CDP

1. Open `http://localhost:3000/job-agent`
2. Click **Launch Chrome CDP** — this opens Chrome with remote debugging enabled on port 9222
3. In the opened Chrome window, log in to Google if not already logged in

### Step 2: Create a Session

1. Click **New Session**
2. Enter a name for the session
3. Enter the job listing URL (e.g. a Linktree page with company career links)
4. Enable **Trusted Mode** to allow auto-submit without manual approval
5. Click **Start**

### Step 3: Monitor the Live Feed

The live feed shows every step in real time:

| Event | Meaning |
|-------|---------|
| Navigating | Agent is opening the form URL |
| Form detected | Google Forms found on the page |
| X fields found | Number of form fields extracted |
| Filling X fields | Auto-fill started |
| → Field: value | Each field being filled (real-time) |
| SUBMITTED | Form successfully submitted |
| Review needed | Field confidence too low, needs manual approval |
| Skipped | Form closed, robots.txt blocked, or no form found |
| CAPTCHA | CAPTCHA detected — auto-solving or waiting for manual solve |

### Trusted Mode vs Review Mode

- **Trusted Mode ON**: agent fills and submits automatically as long as critical fields (name, email) are detected with confidence above 85%
- **Trusted Mode OFF**: all jobs go to the review queue for manual approval before submit

### Review Queue

Jobs in the review queue can be approved or rejected from the Job Agent page. Approved jobs will be submitted with the pre-filled values.

---

## Profile Setup

Before running the Job Agent, fill in your profile at `http://localhost:3000/profile`:

| Field | Used For |
|-------|---------|
| Full Name | Nama lengkap / Your name fields |
| Email | Email fields |
| Phone | No. HP / Telepon fields |
| Address | Alamat / Domisili fields |
| City | Kota fields |
| University | Universitas / Perguruan tinggi fields |
| Major | Jurusan / Program studi fields |
| GPA | IPK fields |
| LinkedIn URL | LinkedIn fields |
| GitHub URL | GitHub fields |
| Skills | Keahlian / Skills fields |
| Expected Salary | Gaji yang diharapkan fields |
| Available Start Date | Bisa mulai / Available from fields |

The more fields you fill in, the higher the field-mapping confidence and the fewer jobs go to the review queue.

---

## Project Structure

```
wanar-ai/
├── client/                     # React + Vite frontend
│   ├── src/
│   │   ├── App.jsx             # Route definitions
│   │   ├── components/
│   │   │   ├── JobAgent.jsx    # Job Agent UI + live feed
│   │   │   ├── ChatArea.jsx    # AI chat interface
│   │   │   ├── Sidebar.jsx     # Session sidebar
│   │   │   ├── InputBar.jsx    # Input + provider selector
│   │   │   ├── Profile.jsx     # User profile form
│   │   │   ├── Settings.jsx    # App settings
│   │   │   └── AnalyticsPage.jsx
│   │   ├── hooks/
│   │   │   ├── useChat.js      # Chat state management
│   │   │   ├── useSessions.js  # Session management
│   │   │   └── useConfig.js    # Config/provider state
│   │   └── styles-v2-enterprise.css
│   └── public/
│       ├── logo.png
│       └── UI/chatui.png
├── src/                        # Node.js Express backend
│   ├── server.js               # Main server + all API endpoints
│   ├── ai-manager.js           # Multi-provider AI orchestration
│   ├── database.js             # SQLite schema + CRUD
│   ├── advanced-context-manager.js
│   └── tools/
│       ├── job-agent.js        # Autonomous job application engine
│       ├── browser.js          # Playwright browser tools
│       ├── filesystem.js       # File system tools
│       ├── search.js           # Web search tools
│       └── registry.js         # Tool registration
├── config/
│   └── config.js               # Provider + model configuration
├── data/                       # SQLite database (gitignored)
│   └── wanar.db
├── .env                        # Your API keys (gitignored)
├── .env.example                # Environment template
└── package.json
```

---

## API Endpoints

### Chat

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/chat` | Send a chat message (streaming SSE) |
| GET | `/api/sessions` | List all chat sessions |
| POST | `/api/sessions` | Create a new session |
| DELETE | `/api/sessions/:id` | Delete a session |

### Job Agent

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/job-agent/sessions` | List all job sessions |
| POST | `/api/job-agent/sessions` | Create a new job session |
| POST | `/api/job-agent/sessions/:id/start` | Start a job session |
| POST | `/api/job-agent/sessions/:id/pause` | Pause a running session |
| POST | `/api/job-agent/sessions/:id/abort` | Abort a running session |
| GET | `/api/job-agent/sessions/:id/jobs` | Get all jobs in a session |
| GET | `/api/job-agent/events/:id` | SSE live feed for a session |
| GET | `/api/job-agent/review-queue` | Get jobs pending review |
| POST | `/api/job-agent/review/:jobId/approve` | Approve a review item |
| POST | `/api/job-agent/review/:jobId/reject` | Reject a review item |
| POST | `/api/job-agent/launch-chrome` | Launch Chrome with CDP on port 9222 |

### Profile

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/profile` | Get user profile |
| PUT | `/api/profile` | Update user profile |

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Backend | Node.js 18+, Express 5 |
| Frontend | React 19, Vite 5 |
| Database | SQLite via better-sqlite3 (WAL mode) |
| Browser Automation | Playwright (Chromium + Chrome CDP) |
| AI Providers | OpenAgentic, NVIDIA, Puter.js |
| Realtime Updates | Server-Sent Events (SSE) |
| Security | Helmet, CORS, Rate Limiting |
| Styling | CSS Variables, custom design system |

---

## Changelog

### v1.0.1 (current)
- Rewrite `fillGoogleForm` to use index-based DOM targeting instead of fragile label matching
- Add mouse movement simulation before every field interaction and submit click
- Rewrite `submitFormAndVerify` with scroll-to-bottom, hover, and 9-selector submit button detection
- Add per-field live feed emission so every fill action is visible in real time
- Fix `checkRobotsTxt` to use `fetch()` instead of `page.goto()` (was navigating away from form)
- Fix `extractFormFields` operator precedence bug in `aria-labelledby` ternary
- Add `extractGoogleFormFields` with 5 selector variants for all Google Forms versions
- Audio CAPTCHA solver (free, no API key required)
- Chrome CDP launcher button in Job Agent UI
- Expand `FIELD_MAP` with 30+ Indonesian field patterns

### v1.0.0
- Initial release
- Multi-provider AI chat (OpenAgentic, NVIDIA, Puter.js)
- Job Application Agent: crawl, detect, fill, submit
- SQLite local database
- Live feed SSE monitoring
- Profile management + cover letter generation
- Review queue for low-confidence fields

---

<div align="center">

Wanar AI v1.0.1 — Wisnu Alfian Nur Ashar — 2026

</div>
