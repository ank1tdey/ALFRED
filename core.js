/* ==========================================================================
   ALFRED OS v0.4 — AI core
   Everything about talking to a model lives here (no DOM code), so it can
   be tested on its own. Loaded in the browser before app.js.
   ========================================================================== */

(function (root) {
  "use strict";

  /* ---------- Errors ---------- */

  function makeError(code, message, status) {
    const err = new Error(message || code);
    err.code = code;
    err.status = status;
    return err;
  }

  /* ---------- Actions (Alfred acting on your data) ----------
     The model writes lines like:
       [[ACTION: {"type":"add_task","title":"Revise SQL joins","tag":"SQL"}]]
     We strip them from the visible text and run them on your data. */

  const ACTION_SRC = "\\[\\[ACTION:\\s*(\\{[\\s\\S]*?\\})\\s*\\]\\]";

  function extractActions(raw) {
    const found = [];
    const re = new RegExp(ACTION_SRC, "g");
    let m;
    while ((m = re.exec(raw)) !== null) {
      try {
        const a = JSON.parse(m[1]);
        if (a && typeof a.type === "string") found.push(a);
      } catch (e) {
        /* ignore malformed action */
      }
    }
    return found;
  }

  /* Text to show in the chat: actions removed, plus any half-written
     action still streaming in. */
  function visibleText(raw) {
    return String(raw || "")
      .replace(new RegExp(ACTION_SRC, "g"), "")
      .replace(/\[\[ACTION:[\s\S]*$/, "")
      .replace(/\[{1,2}[A-Z]{0,6}$/, "")
      .trim();
  }

  const clean = (v, max) => String(v == null ? "" : v).trim().slice(0, max);

  /* Validate an action. Returns a normalized copy or null. */
  function normalizeAction(a) {
    if (!a || typeof a.type !== "string") return null;

    switch (a.type) {
      case "add_task": {
        const title = clean(a.title, 200);
        if (!title) return null;
        const tag = clean(a.tag, 10).toUpperCase() || "TASK";
        return { type: "add_task", title, tag };
      }
      case "complete_task": {
        const title = clean(a.title, 200);
        return title ? { type: "complete_task", title } : null;
      }
      case "add_note": {
        const title = clean(a.title, 80);
        const text = clean(a.text, 2000);
        return title && text ? { type: "add_note", title, text } : null;
      }
      case "remember": {
        const text = clean(a.text, 500);
        return text ? { type: "remember", text } : null;
      }
      default:
        return null;
    }
  }

  function describeAction(a) {
    const n = normalizeAction(a);
    if (!n) return null;
    switch (n.type) {
      case "add_task":
        return `Task added: ${n.title}`;
      case "complete_task":
        return `Task completed: ${n.title}`;
      case "add_note":
        return `Note saved: ${n.title}`;
      case "remember":
        return `Remembered: ${n.text}`;
    }
    return null;
  }

  /* Apply an action to the state object. Returns a short result message,
     or null if it was invalid / nothing happened. The caller saves state. */
  function applyAction(state, a) {
    const n = normalizeAction(a);
    if (!n) return null;

    switch (n.type) {
      case "add_task":
        state.tasks.push({ title: n.title, meta: "Added by Alfred", tag: n.tag, done: false });
        return `Task added: ${n.title}`;

      case "complete_task": {
        const needle = n.title.toLowerCase();
        const open = state.tasks.filter((t) => !t.done);
        const match =
          open.find((t) => t.title.toLowerCase() === needle) ||
          open.find((t) => t.title.toLowerCase().includes(needle));
        if (!match) return null;
        match.done = true;
        return `Task completed: ${match.title}`;
      }

      case "add_note":
        state.notes.push([n.title, n.text]);
        return `Note saved: ${n.title}`;

      case "remember":
        state.memory.push({ text: n.text, at: new Date().toISOString() });
        return `Remembered: ${n.text}`;
    }
    return null;
  }

  /* ---------- System prompt ---------- */

  function buildSystemPrompt(state) {
    const open =
      state.tasks
        .filter((t) => !t.done)
        .map((t) => `- ${t.title} (${t.meta})`)
        .join("\n") || "- none";

    const projects = state.projects.map(([name, pct]) => `- ${name}: ${pct}% complete`).join("\n");

    const memories =
      state.memory
        .slice(-30)
        .map((m) => `- ${m.text}`)
        .join("\n") || "- none yet";

    return `You are Alfred, the calm, loyal and quietly witty personal AI assistant inside ALFRED OS, a personal operating system built by Ankit.
Address the user as "Master Wayne" now and then, in the style of a Batman-style butler, but never overdo it.
Be concise and practical. Prefer short answers unless asked for depth.
Only use the context below when it is relevant. Never invent tasks, projects or memories that are not listed.

ACTIONS
You can change the user's data, but ONLY when the user clearly asks you to add a task, complete a task, save a note, or remember something.
To do it, put one action per line at the very end of your reply, in exactly this format, then confirm in plain words:
[[ACTION: {"type":"add_task","title":"Revise SQL joins","tag":"SQL"}]]
[[ACTION: {"type":"complete_task","title":"part of an open task's title"}]]
[[ACTION: {"type":"add_note","title":"Short title","text":"Note body"}]]
[[ACTION: {"type":"remember","text":"A fact to remember"}]]
Never delete anything. Never use an action unless the user asked for it.

OPEN TASKS:
${open}

PROJECTS:
${projects}

THINGS THE USER ASKED YOU TO REMEMBER:
${memories}`;
  }

  /* ---------- Streaming ---------- */

  /* Read a streamed response line by line. */
  async function readLines(res, onLine) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep the unfinished line for the next chunk
      lines.forEach((l) => onLine(l.replace(/\r$/, "")));
    }

    buffer += decoder.decode();
    if (buffer.trim()) onLine(buffer.replace(/\r$/, ""));
  }

  /* Ollama sends one JSON object per line. */
  function parseOllamaLine(line) {
    if (!line.trim()) return null;
    let chunk;
    try {
      chunk = JSON.parse(line);
    } catch (e) {
      return null;
    }
    if (chunk.error) return { error: String(chunk.error) };
    if (chunk.message && chunk.message.content) return { text: chunk.message.content };
    return null;
  }

  /* Claude sends Server-Sent Events: lines starting with "data: {json}". */
  function parseClaudeLine(line) {
    if (!line.startsWith("data:")) return null;
    let evt;
    try {
      evt = JSON.parse(line.slice(5).trim());
    } catch (e) {
      return null;
    }
    if (evt.type === "error") {
      return { error: (evt.error && evt.error.message) || "Claude returned an error" };
    }
    if (evt.type === "content_block_delta" && evt.delta && evt.delta.type === "text_delta") {
      return { text: evt.delta.text };
    }
    return null;
  }

  async function runStream(res, parseLine, onToken, errorCode) {
    let full = "";
    let failure = null;

    await readLines(res, (line) => {
      const r = parseLine(line);
      if (!r) return;
      if (r.error) {
        failure = failure || r.error;
        return;
      }
      full += r.text;
      onToken(full);
    });

    if (failure) {
      const code = errorCode(failure);
      throw makeError(code, failure);
    }
    return full;
  }

  /* Local model through Ollama. base = "" (via server.js) or http://localhost:11434 */
  async function streamOllama({ base = "", model, system, messages, onToken, fetchImpl }) {
    const f = fetchImpl || fetch;
    const res = await f(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: system }, ...messages],
        stream: true,
      }),
    });

    const codeFor = (text) => (/not found/i.test(text) ? "NO_MODEL" : "OLLAMA");

    if (!res.ok) {
      const body = await res.text();
      throw makeError(res.status === 404 ? "NO_MODEL" : codeFor(body), body, res.status);
    }
    return runStream(res, parseOllamaLine, onToken, codeFor);
  }

  /* Claude through server.js, which holds the API key (never the browser). */
  async function streamClaude({ base = "", model, system, messages, onToken, fetchImpl }) {
    const f = fetchImpl || fetch;
    const res = await f(`${base}/claude/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, system, messages }),
    });

    if (!res.ok) {
      const body = await res.text();
      if (res.status === 503 && /NO_KEY/.test(body)) {
        throw makeError("NO_KEY", "No Claude API key configured", 503);
      }
      let message = body;
      try {
        const j = JSON.parse(body);
        message = (j.error && (j.error.message || j.error)) || body;
      } catch (e) {
        /* keep raw body */
      }
      throw makeError("CLAUDE", String(message).slice(0, 300), res.status);
    }
    return runStream(res, parseClaudeLine, onToken, () => "CLAUDE");
  }

  /* ---------- Export ---------- */

  const api = {
    makeError,
    extractActions,
    visibleText,
    normalizeAction,
    describeAction,
    applyAction,
    buildSystemPrompt,
    parseOllamaLine,
    parseClaudeLine,
    streamOllama,
    streamClaude,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.AlfredCore = api;
})(typeof self !== "undefined" ? self : this);
