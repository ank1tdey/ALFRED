# ALFRED OS v0.4

Batman-inspired personal operating system with **Alfred AI**. Two brains you can switch between with one click:

- **Local · Ollama** — free, private, runs on your own computer
- **Claude** — much smarter for hard questions (finance modelling, SQL, long reasoning); pay per use

## What's new in v0.4

- **Local / Claude switch** at the top of the Alfred AI page
- **Saved chats** — every conversation is stored; reopen, start a new one, or delete from the dropdown
- **Alfred can act** — say "add a task: revise SQL joins", "save a note about…", "mark the finance task done" or "remember my exam is Friday". Alfred does it and shows a ✓ chip. He can add and complete, but never delete.
- Claude's API key lives only on the server (`.env`), never in the browser

## Run it

**Mac:** double-click `start-alfred.command` (first time: right-click → Open).
**Windows:** double-click `start-alfred.bat`.
**Anywhere:** `node server.js`, then open http://localhost:3000

Local mode needs Ollama running with a model (`ollama pull llama3.2`).

## Turn on Claude mode (optional)

1. Create an API key at https://console.anthropic.com → Settings → API Keys. Add a little credit; personal use is usually cheap.
2. In this folder, make a copy of `.env.example` named exactly `.env`
   (in VS Code: right-click `.env.example` → Copy, then Paste, then rename; or in Terminal: `cp .env.example .env`).
3. Open `.env` and paste your key after `ANTHROPIC_API_KEY=`
4. Stop the server (Ctrl+C) and start it again.
5. In Alfred AI, click **Claude**. The sidebar should say *Alfred AI online · Claude*.

Keep `.env` private — don't share it or upload it anywhere. The server never serves it, and `.gitignore` keeps it out of Git.

**Privacy:** in Claude mode, your messages plus your task/memory context are sent to Anthropic. In Local mode nothing leaves your computer.

The default Claude model is `claude-sonnet-5-5`. You can change it in Settings (for example a cheaper, faster model).

## Troubleshooting

| Problem | Fix |
| --- | --- |
| Local: "Alfred AI offline" | Open the Ollama app, then Settings → Test connections |
| "Model isn't installed" | `ollama pull <name>` and make sure the name in Settings matches |
| Claude: "needs an API key" | Check the `.env` steps above, then restart the server |
| Claude: "invalid x-api-key" | The key was pasted wrong or revoked — create a new one |
| Claude: other errors | The message from Claude is shown in the chat (e.g. no credit left) |
| Alfred didn't add my task | Small local models sometimes miss the action format. Ask again more directly ("add a task: …") or use Claude |
| Page looks old after an update | Hard refresh: Cmd+Shift+R (Mac) / Ctrl+Shift+R (Windows) |

## Files

- `index.html`, `styles.css`, `app.js` — the interface
- `core.js` — the AI logic (prompts, actions, streaming for Ollama and Claude)
- `server.js` — local server: serves the app, forwards to Ollama, holds the Claude key
- `.env.example` — template for your key
- `start-alfred.command` (Mac), `start-alfred.bat` (Windows) — launchers

## Roadmap

- v0.5 — search across chats, notes and knowledge; richer data model
- v0.6 — backend + sync
- v0.7 — voice + wake word
- v1.0 — ecosystem + AI + device automation
