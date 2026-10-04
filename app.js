/* ==========================================================================
   ALFRED OS v0.4 — saved chats · Local/Claude switch · Alfred actions
   (AI logic lives in core.js)
   ========================================================================== */

const {
  extractActions,
  visibleText,
  describeAction,
  applyAction,
  buildSystemPrompt,
  streamOllama,
  streamClaude,
  makeError,
} = window.AlfredCore;

const KEY = "alfred-os-v02"; // unchanged so your existing data carries over
const DEFAULT_MODEL = "llama3.2";
const DEFAULT_CLAUDE_MODEL = "claude-sonnet-5-5";
const MAX_CHATS = 50;

/* Through server.js, /api/* is proxied to Ollama.
   If index.html is double-clicked (file://), talk to Ollama directly. */
const IS_FILE = location.protocol === "file:";
const OLLAMA = IS_FILE ? "http://localhost:11434" : "";

/* ---------- State ---------- */

const defaultState = {
  tasks: [
    { title: "Finish Amity BBA study block", meta: "Today · 60 min", tag: "BBA", done: false },
    { title: "Build ALFRED OS foundation", meta: "Today · Core project", tag: "ALFRED", done: false },
    { title: "Cook & Klean internship check-in", meta: "Today · Internship", tag: "WORK", done: false },
    { title: "30 min finance modelling", meta: "Today · Practice", tag: "FINANCE", done: false },
  ],
  projects: [
    ["ALFRED OS", 18],
    ["Amity BBA", 32],
    ["Business Analyst", 12],
  ],
  notes: [
    ["The Alfred principle", "Build the system before giving it intelligence."],
    ["Today", "Consistency over complexity. Brick for brick."],
  ],
  memory: [],
  settings: {},
  chats: [],
  currentChat: null,
};

const state = JSON.parse(localStorage.getItem(KEY) || "null") || defaultState;

// Fill in anything missing (older saves from v0.2 / v0.3)
state.memory = state.memory || [];
state.chats = state.chats || [];
state.currentChat = state.currentChat || null;
state.settings = state.settings || {};
state.settings.model = state.settings.model || DEFAULT_MODEL;
state.settings.claudeModel = state.settings.claudeModel || DEFAULT_CLAUDE_MODEL;
state.settings.provider = state.settings.provider || "local";

const save = () => localStorage.setItem(KEY, JSON.stringify(state));

/* ---------- Helpers ---------- */

const $ = (selector) => document.querySelector(selector);

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));

const PAGE_TITLES = {
  dashboard: "COMMAND CENTER",
  tasks: "TASKS",
  projects: "PROJECTS",
  notes: "NOTES",
  knowledge: "KNOWLEDGE",
  ai: "ALFRED AI",
  settings: "SETTINGS",
};

const activeView = () => $(".nav-item.active").dataset.view;

/* ---------- Clock ---------- */

function updateClock() {
  const now = new Date();
  $("#clock").textContent = now.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

setInterval(updateClock, 1000);
updateClock();

/* ==========================================================================
   AI STATUS
   ========================================================================== */

let aiOnline = null; // Ollama reachable? null = checking
let claudeKey = null; // server has a Claude key? null = checking
let installedModels = [];
let aiBusy = false;

const provider = () => state.settings.provider;

function providerReady() {
  return provider() === "claude" ? claudeKey === true : aiOnline === true;
}

function aiLabel() {
  const ready = provider() === "claude" ? claudeKey : aiOnline;
  return ready === null ? "…" : ready ? "ONLINE" : "OFFLINE";
}

function refreshStatus() {
  const name = provider() === "claude" ? "Claude" : "Local";
  $("#coreStatus").textContent = providerReady()
    ? `Alfred AI online · ${name}`
    : `Alfred AI offline · ${name}`;
}

async function checkOllama() {
  try {
    const res = await fetch(`${OLLAMA}/api/tags`);
    if (!res.ok) throw new Error("bad status");
    const data = await res.json();
    installedModels = (data.models || []).map((m) => m.name);
    aiOnline = true;
  } catch (e) {
    aiOnline = false;
    installedModels = [];
  }
}

async function checkClaude() {
  if (IS_FILE) {
    claudeKey = false;
    return;
  }
  try {
    const res = await fetch("/claude/status");
    claudeKey = (await res.json()).hasKey === true;
  } catch (e) {
    claudeKey = false;
  }
}

async function checkAI() {
  await Promise.all([checkOllama(), checkClaude()]);
  refreshStatus();
  const view = activeView();
  if (view === "dashboard" || view === "settings") render(view);
}

/* ==========================================================================
   CHATS
   ========================================================================== */

const getChat = () => state.chats.find((c) => c.id === state.currentChat) || null;

function newChatObject(firstText) {
  const chat = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title: firstText.replace(/\s+/g, " ").slice(0, 40),
    messages: [],
    updated: Date.now(),
  };
  state.chats.unshift(chat);
  state.chats = state.chats.slice(0, MAX_CHATS);
  state.currentChat = chat.id;
  return chat;
}

/* Messages sent to the model: no local-command messages, last 20,
   and always starting with a user message. */
function contextMessages(chat) {
  const msgs = chat.messages
    .filter((m) => !m.local)
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content }));
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  return msgs;
}

/* Commands handled locally (instant, no model needed). Returns a string or null. */
function localCommand(text) {
  if (/^remember\s+/i.test(text)) {
    const memory = text.replace(/^remember\s+/i, "");
    state.memory.push({ text: memory, at: new Date().toISOString() });
    save();
    return `Memory stored: ${memory}`;
  }

  if (/^(status|system status)$/i.test(text)) {
    const ready = providerReady();
    const who =
      provider() === "claude"
        ? `Claude (${state.settings.claudeModel})`
        : `local (${state.settings.model})`;
    return `ALFRED OS online. AI brain: ${who}, ${ready ? "online" : "offline"}. ${state.memory.length} memories, ${state.chats.length} saved chats.`;
  }

  if (/^tasks$/i.test(text)) {
    return `${state.tasks.filter((t) => !t.done).length} open tasks.`;
  }

  return null;
}

function friendlyError(err) {
  switch (err.code) {
    case "NO_MODEL":
      return `The model "${state.settings.model}" isn't installed yet. In a terminal run:  ollama pull ${state.settings.model}`;
    case "NO_KEY":
      return "Claude mode needs an API key. Copy .env.example to .env, paste your key inside, then restart the server (Ctrl+C, then node server.js).";
    case "NO_SERVER":
      return "Claude mode needs the server. Run  node server.js  and open http://localhost:3000 instead of double-clicking index.html.";
    case "CLAUDE":
      return `Claude returned an error: ${err.message}`;
    case "OLLAMA":
      return `Ollama returned an error: ${err.message}`;
  }

  if (provider() === "claude") {
    return "I can't reach the server. Make sure  node server.js  is still running.";
  }
  const fileHint = IS_FILE
    ? " You opened index.html directly, so also start Ollama with OLLAMA_ORIGINS=* — or run  node server.js  and open http://localhost:3000."
    : "";
  return `I can't reach Ollama. Make sure the Ollama app is running (or run  ollama serve  in a terminal).${fileHint}`;
}

function runProvider(chat, onToken) {
  const system = buildSystemPrompt(state);
  const messages = contextMessages(chat);

  if (provider() === "claude") {
    if (IS_FILE) throw makeError("NO_SERVER", "Server required");
    return streamClaude({ model: state.settings.claudeModel, system, messages, onToken });
  }

  return streamOllama({ base: OLLAMA, model: state.settings.model, system, messages, onToken });
}

/* ---------- Templates ---------- */

function taskRow(task, index) {
  return `
    <div class="row ${task.done ? "done" : ""}">
      <div class="row-left">
        <button class="check" onclick="toggleTask(${index})">${task.done ? "✓" : ""}</button>
        <div>
          <div class="task-title">${esc(task.title)}</div>
          <small class="muted">${esc(task.meta)}</small>
        </div>
      </div>
      <span class="tag">${esc(task.tag)}</span>
    </div>`;
}

function projectCard(project) {
  const [name, percent] = project;
  return `
    <div class="card project">
      <b>${esc(name)}</b>
      <span class="muted">${percent}% complete</span>
      <div class="bar"><i style="width:${percent}%"></i></div>
    </div>`;
}

/* ---------- Views ---------- */

const views = {
  dashboard(c) {
    const open = state.tasks.filter((t) => !t.done).length;

    c.innerHTML = `
      <div class="hero">
        <div class="eyebrow">PERSONAL OPERATING SYSTEM</div>
        <h1>Good morning, Ankit.</h1>
        <p>One system. One command center. Built brick by brick.</p>
      </div>

      <div class="grid">
        <div class="card"><div class="label">OPEN TASKS</div><div class="metric">${open}</div></div>
        <div class="card"><div class="label">PROJECTS</div><div class="metric">${state.projects.length}</div></div>
        <div class="card"><div class="label">MEMORIES</div><div class="metric">${state.memory.length}</div></div>
        <div class="card"><div class="label">AI LAYER</div><div class="metric">${aiLabel()}</div></div>
      </div>

      <div class="section">
        <h2>Today's command queue</h2>
        <div class="list">${state.tasks.map(taskRow).join("")}</div>
      </div>

      <div class="section">
        <h2>Active systems</h2>
        <div class="grid grid-auto">${state.projects.map(projectCard).join("")}</div>
      </div>`;
  },

  tasks(c) {
    c.innerHTML = `
      <div class="eyebrow">EXECUTION</div>
      <h1>Tasks</h1>
      <div class="input-row">
        <input id="taskInput" placeholder="Add a task and press Enter" />
      </div>
      <div class="list">${state.tasks.map(taskRow).join("")}</div>`;

    $("#taskInput").addEventListener("keydown", (e) => {
      const value = e.target.value.trim();
      if (e.key === "Enter" && value) {
        state.tasks.push({ title: value, meta: "Added now", tag: "TASK", done: false });
        save();
        render("tasks");
      }
    });
  },

  projects(c) {
    c.innerHTML = `
      <div class="eyebrow">WORKSPACE</div>
      <h1>Projects</h1>
      <div class="grid grid-auto">${state.projects.map(projectCard).join("")}</div>`;
  },

  notes(c) {
    c.innerHTML = `
      <div class="eyebrow">MEMORY SPACE</div>
      <h1>Notes</h1>
      <div class="grid grid-auto">
        ${state.notes
          .map(
            (n) => `
          <div class="card note">
            <h3>${esc(n[0])}</h3>
            <p>${esc(n[1])}</p>
          </div>`
          )
          .join("")}
      </div>`;
  },

  knowledge(c) {
    c.innerHTML = `
      <div class="eyebrow">KNOWLEDGE</div>
      <h1>Knowledge</h1>
      <div class="card" style="margin-top:22px">
        <p class="muted" style="margin:0">
          This layer will become Alfred's searchable knowledge base:
          BBA material, BA concepts, project documentation and your own notes.
        </p>
      </div>`;
  },

  ai(c) {
    const isClaude = provider() === "claude";
    const note = isClaude
      ? `Claude mode · model <b>${esc(state.settings.claudeModel)}</b>. Messages in this chat (and your task/memory context) are sent to Anthropic.`
      : `Local mode · model <b>${esc(state.settings.model)}</b>. Running on your computer; nothing leaves it.`;

    c.innerHTML = `
      <div class="eyebrow">INTELLIGENCE LAYER</div>
      <h1>Alfred AI</h1>
      <div class="card ai-box">
        <div class="ai-top">
          <div class="seg-group" role="group" aria-label="AI brain">
            <button class="seg ${isClaude ? "" : "on"}" data-p="local">Local · Ollama</button>
            <button class="seg ${isClaude ? "on" : ""}" data-p="claude">Claude</button>
          </div>
          <div class="chat-tools">
            <select id="chatSelect" class="select" aria-label="Saved chats"></select>
            <button id="newChat" class="ghost">+ New</button>
            <button id="delChat" class="ghost">Delete</button>
          </div>
        </div>

        <div class="warning ${providerReady() ? "" : "warn-off"}">
          ${note}
          ${providerReady() ? "" : "<br><b>This brain is offline</b> — see Settings to connect it."}
        </div>

        <div id="chat" class="chat"></div>

        <div class="input-row">
          <input id="aiInput" class="ai-input" placeholder="Give Alfred a command…" autocomplete="off" />
          <button id="sendAI" class="primary">Send</button>
        </div>
      </div>`;

    const chatEl = $("#chat");
    const input = $("#aiInput");
    const select = $("#chatSelect");

    const scroll = () => (chatEl.scrollTop = chatEl.scrollHeight);

    const addBubble = (cls, text) => {
      const el = document.createElement("div");
      el.className = `bubble msg ${cls}`.trim();
      el.textContent = text;
      chatEl.appendChild(el);
      scroll();
      return el;
    };

    /* Fill an assistant bubble: visible text + "✓ Task added" chips */
    const fillAssistant = (el, raw, chipTexts) => {
      el.textContent = visibleText(raw) || (chipTexts.length ? "" : "…");
      chipTexts.forEach((t) => {
        const chip = document.createElement("div");
        chip.className = "chip";
        chip.textContent = `✓ ${t}`;
        el.appendChild(chip);
      });
    };

    const showWelcome = () => {
      const el = document.createElement("div");
      el.className = "bubble";
      el.innerHTML =
        "Good morning, Master Wayne. Ask me anything. I can also add tasks, save notes and remember things — just ask. Try <b>status</b>, <b>tasks</b>, or <b>remember ...</b>.";
      chatEl.appendChild(el);
    };

    const fillSelect = () => {
      const chats = [...state.chats].sort((a, b) => b.updated - a.updated);
      select.innerHTML =
        `<option value="">New chat</option>` +
        chats.map((ch) => `<option value="${esc(ch.id)}">${esc(ch.title || "Untitled")}</option>`).join("");
      select.value = state.currentChat || "";
    };

    const showChat = () => {
      chatEl.innerHTML = "";
      const chat = getChat();
      if (!chat || chat.messages.length === 0) return showWelcome();

      chat.messages.forEach((m) => {
        if (m.role === "user") return addBubble("user", m.content);
        const el = addBubble("", "");
        if (m.local) el.textContent = m.content;
        else fillAssistant(el, m.content, extractActions(m.content).map(describeAction).filter(Boolean));
      });
      scroll();
    };

    fillSelect();
    showChat();

    /* --- Controls --- */

    document.querySelectorAll(".seg").forEach((btn) => {
      btn.onclick = () => {
        if (aiBusy) return;
        state.settings.provider = btn.dataset.p;
        save();
        refreshStatus();
        render("ai");
      };
    });

    select.onchange = () => {
      if (aiBusy) return;
      state.currentChat = select.value || null;
      save();
      showChat();
      input.focus();
    };

    $("#newChat").onclick = () => {
      if (aiBusy) return;
      state.currentChat = null;
      save();
      fillSelect();
      showChat();
      input.focus();
    };

    $("#delChat").onclick = () => {
      const chat = getChat();
      if (aiBusy || !chat) return;
      if (!confirm(`Delete this chat?\n\n"${chat.title}"`)) return;
      state.chats = state.chats.filter((x) => x.id !== chat.id);
      state.currentChat = null;
      save();
      fillSelect();
      showChat();
    };

    /* --- Sending --- */

    const send = async () => {
      const value = input.value.trim();
      if (!value || aiBusy) return;

      let chat = getChat();
      if (!chat) {
        chat = newChatObject(value);
        chatEl.innerHTML = ""; // clear the welcome bubble
        fillSelect();
      }

      addBubble("user", value);
      input.value = "";

      // Instant local commands
      const local = localCommand(value);
      if (local !== null) {
        chat.messages.push(
          { role: "user", content: value, local: true },
          { role: "assistant", content: local, local: true }
        );
        chat.updated = Date.now();
        save();
        addBubble("", local);
        return;
      }

      aiBusy = true;
      $("#sendAI").disabled = true;
      const bubble = addBubble("", "…");
      chat.messages.push({ role: "user", content: value });

      try {
        const raw = await runProvider(chat, (text) => {
          bubble.textContent = visibleText(text) || "…";
          scroll();
        });

        chat.messages.push({ role: "assistant", content: raw });

        // Let Alfred act on your data (add task, save note, ...)
        const results = extractActions(raw)
          .map((a) => applyAction(state, a))
          .filter(Boolean);

        fillAssistant(bubble, raw, results);
      } catch (err) {
        chat.messages.pop(); // drop the unanswered user message
        bubble.textContent = friendlyError(err);

        if (chat.messages.length === 0) {
          // Nothing was ever answered — don't keep an empty chat around
          state.chats = state.chats.filter((x) => x.id !== chat.id);
          state.currentChat = null;
          fillSelect();
        }
      } finally {
        if (state.chats.includes(chat)) chat.updated = Date.now();
        save();
        aiBusy = false;
        $("#sendAI").disabled = false;
        scroll();
        input.focus();
      }
    };

    $("#sendAI").onclick = send;
    input.onkeydown = (e) => {
      if (e.key === "Enter") send();
    };
    input.focus();
  },

  settings(c) {
    const modelNote = aiOnline
      ? `Connected. ${installedModels.length} model(s) installed: ${installedModels.map(esc).join(", ") || "none yet"}.`
      : "Not connected. Start the Ollama app, then press Test connection.";

    const keyNote = IS_FILE
      ? "Claude needs the server: run <code>node server.js</code> and open http://localhost:3000."
      : claudeKey
        ? "API key found on the server."
        : "No API key yet. Copy <code>.env.example</code> to <code>.env</code>, paste your key inside, then restart the server.";

    c.innerHTML = `
      <div class="eyebrow">SYSTEM</div>
      <h1>Settings</h1>
      <div class="settings-grid">
        <div class="card toggle"><span>Local storage</span><span class="badge">ON</span></div>
        <div class="card toggle"><span>Active brain</span><span class="badge">${provider() === "claude" ? "CLAUDE" : "LOCAL"} · ${aiLabel()}</span></div>

        <div class="card ai-settings">
          <div class="label">LOCAL MODEL (OLLAMA)</div>
          <div class="input-row">
            <input id="modelInput" list="modelList" value="${esc(state.settings.model)}" placeholder="e.g. llama3.2" />
            <datalist id="modelList">
              ${installedModels.map((m) => `<option value="${esc(m)}"></option>`).join("")}
            </datalist>
          </div>
          <p class="muted">${modelNote} Add models with <code>ollama pull &lt;name&gt;</code>.</p>
        </div>

        <div class="card ai-settings">
          <div class="label">CLAUDE MODEL</div>
          <div class="input-row">
            <input id="claudeInput" value="${esc(state.settings.claudeModel)}" placeholder="e.g. claude-sonnet-5-5" />
            <button id="testAI" class="primary">Test connections</button>
          </div>
          <p class="muted">${keyNote} The key stays on the server and never reaches the browser.</p>
        </div>
      </div>`;

    $("#modelInput").addEventListener("change", (e) => {
      const value = e.target.value.trim();
      if (value) {
        state.settings.model = value;
        save();
      }
    });

    $("#claudeInput").addEventListener("change", (e) => {
      const value = e.target.value.trim();
      if (value) {
        state.settings.claudeModel = value;
        save();
      }
    });

    $("#testAI").onclick = () => {
      aiOnline = null;
      claudeKey = null;
      $("#coreStatus").textContent = "Checking…";
      checkAI();
    };
  },
};

/* ---------- Router ---------- */

function render(view = "dashboard") {
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.view === view);
  });

  $("#pageTitle").textContent = PAGE_TITLES[view] || view.toUpperCase();
  (views[view] || views.settings)($("#content"));
}

window.toggleTask = (index) => {
  state.tasks[index].done = !state.tasks[index].done;
  save();
  render(activeView());
};

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => render(button.dataset.view));
});

$("#newBtn").onclick = () => render("tasks");

render();
checkAI();
