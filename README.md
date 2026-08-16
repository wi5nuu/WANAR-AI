<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:0066ff,100:00ccff&height=200&section=header&text=WANAR%20AI&fontSize=80&fontColor=ffffff&animation=fadeIn&fontAlignY=38&desc=Professional%20Multi-Provider%20AI%20Agent&descAlignY=60&descSize=18" width="100%"/>

<br/>

<img src="client/public/logo.png" alt="Wanar AI" width="120" style="border-radius: 50%"/>

<br/><br/>

[![Typing SVG](https://readme-typing-svg.herokuapp.com?font=Fira+Code&size=22&pause=1000&color=00CCFF&center=true&vCenter=true&width=600&lines=Wanar+AI+v1.0.1;Professional+AI+Chat+Platform;Autonomous+Job+Application+Agent;Built+with+Love+by+Wisnu+%26+Zahra)](https://git.io/typing-svg)

<br/>

> **Made with love by Wisnu Alfian Nur Ashar & Siti Nurfadhila Az Zahra Syam**
> 
> *"Dibangun dengan cinta, untuk masa depan yang lebih cerdas"*

<br/>

![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=for-the-badge&logo=node.js&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?style=for-the-badge&logo=react&logoColor=black)
![Playwright](https://img.shields.io/badge/Playwright-Automation-45ba4b?style=for-the-badge&logo=playwright&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-Local%20DB-003B57?style=for-the-badge&logo=sqlite&logoColor=white)

<br/>

![Version](https://img.shields.io/badge/Version-1.0.1-blue?style=flat-square)
![License](https://img.shields.io/badge/License-Private-red?style=flat-square)
![Made with Love](https://img.shields.io/badge/Made%20with-Love-ff69b4?style=flat-square)
![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)

</div>

---

<div align="center">

## Screenshots

<img src="client/public/UI/homeuichat.png" alt="Home UI" width="100%"/>

<br/>

<img src="client/public/UI/demochat.png" alt="Demo Chat" width="100%"/>

<br/>

<img src="client/public/UI/cli.png" alt="CLI" width="100%"/>

</div>

---

<div align="center">

## Overview

</div>

Wanar AI is a self-hosted AI platform that runs entirely on your local machine. It combines a professional multi-model AI chat interface with an autonomous job application agent capable of crawling job listings, detecting Google Forms, filling them out field by field, and submitting — all without manual intervention.

All data stays local. No cloud sync. No third-party data collection.

---

<div align="center">

## Features

</div>

<table>
<tr>
<td width="50%">

### AI Chat
- 53+ models — Claude, GPT-4o, Gemini, DeepSeek, Llama, and more
- Real-time streaming responses via Server-Sent Events
- Session history with sidebar navigation
- Provider and model selector in the input bar
- Automatic context window management
- RAG support for codebase indexing

</td>
<td width="50%">

### Job Application Agent
- Crawl Linktree, Glints, Jobstreet, LinkedIn, Google Sheets
- Automatic Google Forms detection and field extraction
- Smart field mapping — name, email, phone, GPA, LinkedIn, GitHub, 30+ fields
- Index-based DOM form fill — no fragile label matching
- Mouse movement simulation (anti-bot detection)
- Auto-generated cover letter per company and position
- Audio CAPTCHA solver (free, no API required)
- Real-time live feed with per-field fill monitoring

</td>
</tr>
</table>

---

<div align="center">

## Tech Stack

</div>

<div align="center">

![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-000000?style=for-the-badge&logo=express&logoColor=white)
![React](https://img.shields.io/badge/React-61DAFB?style=for-the-badge&logo=react&logoColor=black)
![Vite](https://img.shields.io/badge/Vite-646CFF?style=for-the-badge&logo=vite&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-003B57?style=for-the-badge&logo=sqlite&logoColor=white)
![Playwright](https://img.shields.io/badge/Playwright-45ba4b?style=for-the-badge&logo=playwright&logoColor=white)

</div>

<br/>

| Layer | Technology |
|-------|------------|
| Backend | Node.js 18+, Express 5 |
| Frontend | React 19, Vite 5 |
| Database | SQLite via better-sqlite3 (WAL mode) |
| Browser Automation | Playwright (Chromium + Chrome CDP) |
| AI Providers | OpenAgentic, NVIDIA, Anthropic, OpenAI, Gemini, Groq |
| Realtime Updates | Server-Sent Events (SSE) |
| Security | Helmet, CORS, Rate Limiting |
| CLI | Node.js readline, global npm package |

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
- Add global CLI commands `wanarai` and `wanar` via npm global install
- Add `wanarai --new` / `wanarai -n` to start a fresh session
- Auto-resume last session on startup with message count and timestamp
- Interactive model and provider menus with arrow-key navigation and search
- Real-time streaming output — AI response displayed per chunk in terminal
- Tool call output displayed inline (bash, read_file, etc.)
- Separate system prompts for CLI (plain text) and Web (markdown)
- Remove filesystem and shell path restrictions — agent can access any folder
- Add co-creator: Siti Nurfadhila Az Zahra Syam
- Redesign CLI with large ASCII art WANAR AI banner

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

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:00ccff,100:0066ff&height=120&section=footer&text=Made%20with%20Love%20by%20Wisnu%20%26%20Zahra&fontSize=20&fontColor=ffffff&animation=fadeIn" width="100%"/>

**Wanar AI v1.0.1 — Wisnu Alfian Nur Ashar & Siti Nurfadhila Az Zahra Syam — 2026**

</div>
