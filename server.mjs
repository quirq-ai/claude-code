// claude-code container: sign in to Claude Code with your own subscription, then run `claude remote-control`
// so you can drive the session from claude.ai/code or the Claude app.
//
//   * prints a one-time CONNECT link to the logs (a random token, or CONNECT_TOKEN); only whoever reads the
//     logs can open the connect page;
//   * the connect page shows Claude's sign-in link and takes the code back (it is bound to this login by
//     PKCE, so it is useless anywhere else); with `docker run -it` the code can also be typed in the logs' terminal;
//   * once signed in, runs `claude remote-control` (restarted with backoff if it exits) and shows its links;
//   * GET /healthz for probes. The sign-in lives in $HOME on the volume, so a restart skips the login.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const env = process.env;
const PORT = Number(env.PORT || 8080);
const HOME = env.HOME || "/data/home";
const WORKDIR = env.WORKDIR || "/data/work";
const PUBLIC_URL = (env.PUBLIC_URL || "").replace(/\/+$/, "");
const TOKEN = env.CONNECT_TOKEN || randomBytes(24).toString("base64url");
const NAME = env.SESSION_NAME || "";
const PERMISSION_MODE = env.PERMISSION_MODE || "";      // e.g. acceptEdits; empty = Claude Code's default
const CREDENTIALS = join(HOME, ".claude", ".credentials.json");

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07/g;
const URL_RE = /https:\/\/[^\s"'<>]+/g;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

let state = "starting";          // starting | login | signing_in | running | restarting
let loginUrl = null;
let loginProc = null;
let rcProc = null;
let rcLinks = [];
let restarts = 0;
let lastError = null;

const signedIn = () => existsSync(CREDENTIALS);

// First run in a fresh home: skip the onboarding screens and trust the work directory.
function prepare() {
  for (const d of [HOME, WORKDIR]) mkdirSync(d, { recursive: true });
  const file = join(HOME, ".claude.json");
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(file, "utf8")); } catch {}
  cfg.hasCompletedOnboarding = true;
  cfg.projects = cfg.projects || {};
  cfg.projects[WORKDIR] = { ...(cfg.projects[WORKDIR] || {}), hasTrustDialogAccepted: true };
  writeFileSync(file, JSON.stringify(cfg, null, 2));
  if (env.TASK && !existsSync(join(WORKDIR, "TASK.md"))) writeFileSync(join(WORKDIR, "TASK.md"), `# Task\n\n${env.TASK}\n`);
}

const childEnv = () => ({ PATH: env.PATH, HOME, LANG: "C.UTF-8", TERM: "dumb", BROWSER: "/bin/false", NO_COLOR: "1" });

// ---------------------------------------------------------------- sign-in
function startLogin() {
  state = "login"; loginUrl = null;
  log("Not signed in yet: starting `claude auth login`.");
  const p = spawn("claude", ["auth", "login", "--claudeai"], { cwd: WORKDIR, env: childEnv(), stdio: ["pipe", "pipe", "pipe"] });
  loginProc = p;
  const onData = (buf) => {
    const text = buf.toString().replace(ANSI, "");
    const url = text.match(URL_RE)?.find((u) => u.includes("oauth"));
    if (url && !loginUrl) {
      loginUrl = url;
      log("Sign-in link ready. Open the connect page to finish signing in:");
      announce();
      if (process.stdin.isTTY) log(`Or open this link and paste the code here:\n${url}`);
    }
    for (const line of text.split(/\r?\n/)) if (line.trim() && !line.includes("oauth/authorize")) log(`[login] ${line.trim()}`);
  };
  p.stdout.on("data", onData); p.stderr.on("data", onData);
  p.on("exit", (code) => {
    if (loginProc !== p) return;
    loginProc = null;
    if (signedIn()) { log("Signed in."); lastError = null; startRemoteControl(); return; }
    lastError = `Sign-in did not finish (exit ${code}). A new sign-in link is being made.`;
    log(lastError);
    setTimeout(startLogin, 2000);
  });
}

function submitCode(code) {
  code = String(code || "").trim();
  if (!loginProc || !code || code.length > 1000 || /\s/.test(code)) return false;
  state = "signing_in";
  loginProc.stdin.write(`${code}\n`);
  return true;
}

// ---------------------------------------------------------------- remote control
function startRemoteControl() {
  state = "running"; rcLinks = [];
  const args = ["remote-control", "--name", NAME || `claude-code-${randomBytes(3).toString("hex")}`];
  if (PERMISSION_MODE) args.push("--permission-mode", PERMISSION_MODE);
  log(`Starting \`claude ${args.join(" ")}\` in ${WORKDIR}`);
  const p = spawn("claude", args, { cwd: WORKDIR, env: childEnv(), stdio: ["ignore", "pipe", "pipe"] });
  rcProc = p;
  const onData = (buf) => {
    const text = buf.toString().replace(ANSI, "");
    for (const u of text.match(URL_RE) || []) if (!rcLinks.includes(u)) rcLinks.push(u);
    for (const line of text.split(/\r?\n/)) if (line.trim()) log(`[remote-control] ${line.trim()}`);
  };
  p.stdout.on("data", onData); p.stderr.on("data", onData);
  p.on("exit", (code, signal) => {
    if (rcProc !== p || shuttingDown) return;
    rcProc = null;
    log(`remote-control exited (${signal || code})`);
    if (!signedIn()) { startLogin(); return; }          // signed out (e.g. token revoked): sign in again
    state = "restarting";
    const delay = Math.min(60000, 3000 * 2 ** Math.min(restarts, 4));
    restarts += 1;
    setTimeout(() => { if (!shuttingDown) startRemoteControl(); }, delay);
  });
}

// ---------------------------------------------------------------- connect page
const connectLink = () => `${PUBLIC_URL || `http://localhost:${PORT}`}/connect#${TOKEN}`;
function announce() { log(`CONNECT: ${connectLink()}`); }

const tokenHash = createHash("sha256").update(TOKEN).digest();
function authorized(req) {
  const m = String(req.headers.authorization || "").match(/^Bearer\s+(\S+)$/);
  return Boolean(m) && timingSafeEqual(createHash("sha256").update(m[1]).digest(), tokenHash);
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Claude Code connect</title><style>
body{font:16px/1.5 system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;background:#faf9f5;color:#1f1e1d}
@media(prefers-color-scheme:dark){body{background:#1f1e1d;color:#eee}a{color:#d97757}}
.box{border:1px solid #8884;border-radius:10px;padding:16px;margin:16px 0}input{width:100%;padding:8px;box-sizing:border-box;font:inherit}
button{margin-top:8px;padding:8px 16px;font:inherit;cursor:pointer}code{word-break:break-all}.err{color:#c33}</style></head><body>
<h1>Claude Code</h1><div id="out">Loading…</div><script>
const token = location.hash.slice(1); history.replaceState(null, "", location.pathname);
const H = { Authorization: "Bearer " + token };
const out = document.getElementById("out");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
async function load() {
  const r = await fetch("api/status", { headers: H });
  if (r.status === 401) { out.innerHTML = '<p class="err">This link is not valid. Use the CONNECT link from the container logs.</p>'; return; }
  const s = await r.json(); let h = "";
  if (s.error) h += '<p class="err">' + esc(s.error) + "</p>";
  if (s.state === "login" && s.loginUrl) h += '<div class="box"><p><b>1.</b> <a href="' + esc(s.loginUrl) + '" target="_blank" rel="noopener">Sign in to Claude</a> with your subscription.</p>'
    + '<p><b>2.</b> Paste the code it shows:</p><form id="f"><input id="c" autocomplete="off" placeholder="code"><button>Connect</button></form></div>';
  else if (s.state === "running") h += '<div class="box"><p>Remote Control is on. Open <a href="https://claude.ai/code" target="_blank" rel="noopener">claude.ai/code</a> or the Claude app and pick <b>' + esc(s.name) + "</b>.</p>"
    + s.links.map((u) => '<p><a href="' + esc(u) + '" target="_blank" rel="noopener"><code>' + esc(u) + "</code></a></p>").join("") + "</div>";
  else h += "<p>" + esc({ starting: "Starting…", login: "Preparing the sign-in link…", signing_in: "Signing in…", restarting: "Restarting Remote Control…" }[s.state] || s.state) + "</p>";
  out.innerHTML = h;
  const f = document.getElementById("f");
  if (f) f.onsubmit = async (e) => { e.preventDefault();
    await fetch("api/code", { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ code: document.getElementById("c").value }) }); load(); };
  else setTimeout(load, 3000);
}
load();
</script></body></html>`;

let shuttingDown = false;
const server = createServer(async (req, res) => {
  const send = (code, body, type = "application/json") => {
    res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer" });
    res.end(type === "application/json" ? JSON.stringify(body) : body);
  };
  const path = new URL(req.url, "http://x").pathname;
  if (req.method === "GET" && path === "/healthz") return send(200, { state, restarts });
  if (req.method === "GET" && (path === "/" || path === "/connect")) return send(200, PAGE, "text/html; charset=utf-8");
  if (path.startsWith("/api/") && !authorized(req)) return send(401, { error: "unauthorized" });
  if (req.method === "GET" && path === "/api/status") {
    return send(200, { state, loginUrl: state === "login" ? loginUrl : null, links: rcLinks, name: NAME || null, error: lastError });
  }
  if (req.method === "POST" && path === "/api/code") {
    let body = "";
    for await (const c of req) { body += c; if (body.length > 4096) return send(413, { error: "too large" }); }
    let code; try { code = JSON.parse(body).code; } catch { return send(400, { error: "bad json" }); }
    return submitCode(code) ? send(202, { ok: true }) : send(409, { error: "Not waiting for a sign-in code." });
  }
  send(404, { error: "not found" });
});

// `docker run -it`: a line typed into the container is taken as the sign-in code.
if (process.stdin.isTTY) {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (line) => { if (submitCode(line)) log("Code received."); });
}

prepare();
server.listen(PORT, () => {
  log(`claude-code container on :${PORT}`);
  announce();
  if (signedIn()) startRemoteControl(); else startLogin();
});

const shutdown = () => {
  shuttingDown = true;
  log("shutting down");
  for (const p of [loginProc, rcProc]) try { p?.kill("SIGTERM"); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
