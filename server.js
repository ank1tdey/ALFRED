/* ==========================================================================
   ALFRED OS v0.4 — local server
   - Serves the app at http://localhost:3000
   - /api/*       -> your local Ollama (http://127.0.0.1:11434)
   - /claude/*    -> Claude API, using the key from your .env file.
                     The key stays on this server and is never sent to the browser.
   No npm packages needed.  Run:  node server.js
   ========================================================================== */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;

/* ---------- Load .env (simple KEY=value lines) ---------- */

function loadEnv() {
  try {
    const text = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
    text.split(/\r?\n/).forEach((line) => {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m || line.trim().startsWith("#")) return;
      const value = m[2].replace(/^["']|["']$/g, "");
      if (!(m[1] in process.env)) process.env[m[1]] = value;
    });
  } catch (e) {
    /* no .env file — that's fine, Claude mode just stays off */
  }
}
loadEnv();

const PORT = process.env.PORT || 3000;
const OLLAMA_HOST = process.env.OLLAMA_HOST || "127.0.0.1";
const OLLAMA_PORT = process.env.OLLAMA_PORT || 11434;
const CLAUDE_BASE = new URL(process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com");
const MAX_BODY = 1024 * 1024; // 1 MB

const getKey = () => (process.env.ANTHROPIC_API_KEY || "").trim();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const sendJson = (res, status, obj) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
};

/* ---------- Ollama proxy ---------- */

function proxyToOllama(req, res) {
  const upstream = http.request(
    {
      host: OLLAMA_HOST,
      port: OLLAMA_PORT,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `${OLLAMA_HOST}:${OLLAMA_PORT}` },
    },
    (upRes) => {
      res.writeHead(upRes.statusCode, upRes.headers);
      upRes.pipe(res);
    }
  );

  upstream.on("error", () => sendJson(res, 502, { error: "Ollama is not reachable" }));
  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
}

/* ---------- Claude proxy ---------- */

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function proxyToClaude(req, res) {
  const key = getKey();
  if (!key) return sendJson(res, 503, { error: "NO_KEY" });

  let input;
  try {
    input = JSON.parse(await readBody(req, MAX_BODY));
  } catch (e) {
    return sendJson(res, 400, { error: "Bad request body" });
  }

  // Only pass on the fields we expect — the browser can't craft anything else.
  const payload = JSON.stringify({
    model: String(input.model || "claude-sonnet-5-5"),
    max_tokens: 1500,
    system: String(input.system || ""),
    messages: Array.isArray(input.messages) ? input.messages : [],
    stream: true,
  });

  const lib = CLAUDE_BASE.protocol === "http:" ? http : https;
  const upstream = lib.request(
    {
      hostname: CLAUDE_BASE.hostname,
      port: CLAUDE_BASE.port || (CLAUDE_BASE.protocol === "http:" ? 80 : 443),
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
    },
    (upRes) => {
      res.writeHead(upRes.statusCode, {
        "Content-Type": upRes.headers["content-type"] || "text/event-stream",
        "Cache-Control": "no-cache",
      });
      upRes.pipe(res);
    }
  );

  upstream.on("error", () => sendJson(res, 502, { error: "Could not reach the Claude API" }));
  res.on("close", () => upstream.destroy());
  upstream.end(payload);
}

/* ---------- Static files ---------- */

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  const relative = urlPath === "/" ? "index.html" : urlPath;
  const filePath = path.join(ROOT, path.normalize(relative));
  const name = path.basename(filePath);

  // Never expose the server code, .env (your API key) or any dotfile.
  if (!filePath.startsWith(ROOT) || name === "server.js" || name.startsWith(".")) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not found");
    }
    const type = MIME[path.extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
    res.end(data);
  });
}

/* ---------- Routing ---------- */

const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];

  if (url === "/claude/status" && req.method === "GET") {
    return sendJson(res, 200, { hasKey: Boolean(getKey()) });
  }
  if (url === "/claude/chat" && req.method === "POST") return proxyToClaude(req, res);
  if (url.startsWith("/api/")) return proxyToOllama(req, res);

  serveStatic(req, res);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("");
  console.log("  ALFRED OS v0.4 is running.");
  console.log(`  Open:    http://localhost:${PORT}`);
  console.log(`  Ollama:  http://${OLLAMA_HOST}:${OLLAMA_PORT}`);
  console.log(`  Claude:  ${getKey() ? "API key found" : "no API key (add one to .env to enable)"}`);
  console.log("  Stop:    press Ctrl+C");
  console.log("");
});
