# Puter AI Chat

A full-stack AI chat app built with [Puter.js](https://developer.puter.com) and React. No backend, no API keys, no billing setup — Puter handles auth, AI, and cloud storage in the browser.

## Features

- **Streaming AI responses** via `puter.ai.chat()` with multiple models
- **Conversation history** with proper message context
- **Cloud persistence** using Puter's key-value store (`puter.kv`)
- **Session management** — create, switch, and delete chats
- **Dark/light theme** (follows system preference)

## Quick start

```bash
cd puter-chat
npm install
npm run dev
```

Open http://localhost:5173. On your first message, Puter will prompt you to sign in — that's it.

## How it works

Puter.js uses a **user-pays** model: each user signs in with their Puter account and covers their own AI usage. You never manage API keys or server infrastructure.

```javascript
import puter from '@heyputer/puter.js';

// Stream a chat response
const stream = await puter.ai.chat(messages, { model: 'claude-sonnet-5', stream: true });
for await (const part of stream) {
  console.log(part.text);
}

// Persist sessions to the cloud
await puter.kv.set('chat_sessions', sessions);
```

## Models

Default models included: GPT-5.4 Nano, Claude Sonnet 5, GPT-5.5, Claude Fable 5. Puter supports hundreds more — change the `MODELS` list in `src/hooks/usePuterChat.js`.

## Learn more

- [Puter.js Getting Started](https://developer.puter.com/tutorials/getting-started-with-puterjs/)
- [Puter.js in React](https://developer.puter.com/tutorials/puter-js-react/)
