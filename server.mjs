#!/usr/bin/env node
// RouteDeck: one-click control panel for Headroom (token compression) and
// OmniRoute (multi-provider AI router). No dependencies: Node 18+ only.

import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CATALOG } from "./lib/catalog.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(ROOT, "ui");
const IS_WIN = process.platform === "win32";
const HOME_DIR = path.join(os.homedir(), ".routedeck");
const CONFIG_FILE = path.join(HOME_DIR, "config.json");
const APP_PORT = Number(process.env.ROUTEDECK_PORT || 7777);

// ---------------------------------------------------------------- config

const DEFAULTS = {
  headroom: {
    enabled: true,
    command: "", // path to headroom executable; "" = find on PATH
    port: 8787,
    optimize: true, // compression on/off
    kompress: true, // ML text compression
    cache: true,
    mode: "cache", // "cache" | "token"
    shareStats: false, // Headroom's anonymous beacon
  },
  omniroute: {
    enabled: true,
    dir: "", // source checkout folder; "" = use the `omniroute` command
    port: 20128,
    password: "", // dashboard password, used to manage providers
    apiKey: "", // optional OmniRoute API key for clients
  },
  claude: {
    route: "both", // "both" | "omniroute" | "headroom"
    model: "",
    workDir: os.homedir(),
    ponytailMode: "full", // "lite" | "full" | "ultra" | "off" (used only when Ponytail is installed)
  },
  app: {
    openBrowser: true,
    startServicesOnLaunch: false,
    launchAtLogin: false,
    silentBackground: false,
  },
};

function deepMerge(base, extra) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    if (v && typeof v === "object" && !Array.isArray(v) && typeof base?.[k] === "object") {
      out[k] = deepMerge(base[k], v);
    } else if (k in (base || {})) {
      out[k] = v;
    }
  }
  return out;
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return structuredClone(DEFAULTS);
  try {
    return deepMerge(DEFAULTS, JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")));
  } catch (e) {
    // Keep the broken file so the user's settings aren't silently overwritten.
    const backup = CONFIG_FILE + ".broken";
    fs.copyFileSync(CONFIG_FILE, backup);
    console.warn(`Settings file was unreadable (${e.message}). Saved a copy at ${backup}; using defaults.`);
    return structuredClone(DEFAULTS);
  }
}

let config = loadConfig();

function saveConfig() {
  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

// Never send secrets back to the browser in full.
function publicConfig() {
  const c = structuredClone(config);
  c.omniroute.hasPassword = Boolean(c.omniroute.password);
  c.omniroute.password = "";
  c.omniroute.hasApiKey = Boolean(c.omniroute.apiKey);
  c.omniroute.apiKey = "";
  return c;
}

// ---------------------------------------------------------------- logs

const logs = { headroom: [], omniroute: [], routedeck: [] };
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

function log(service, text) {
  const buf = logs[service];
  for (const line of String(text).replace(ANSI, "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    buf.push({ t: Date.now(), line });
  }
  if (buf.length > 800) buf.splice(0, buf.length - 800);
}

// ---------------------------------------------------------------- helpers

function portOpen(port, host = "127.0.0.1", timeout = 800) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (ok) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeout, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

async function fetchJson(url, opts = {}, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal, redirect: "manual" });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text.slice(0, 300) };
    }
    return { ok: res.ok, status: res.status, headers: res.headers, body };
  } finally {
    clearTimeout(timer);
  }
}

function getSearchDirs() {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  if (IS_WIN) {
    if (process.env.APPDATA) {
      dirs.push(path.join(process.env.APPDATA, "npm"));
    }
    if (process.env.LOCALAPPDATA) {
      dirs.push(path.join(process.env.LOCALAPPDATA, "Programs", "Python", "Python312", "Scripts"));
      dirs.push(path.join(process.env.LOCALAPPDATA, "Programs", "Python", "Python311", "Scripts"));
      dirs.push(path.join(process.env.LOCALAPPDATA, "Programs", "Python", "Python310", "Scripts"));
      dirs.push(path.join(process.env.LOCALAPPDATA, "Programs", "Python", "Python312"));
      dirs.push(path.join(process.env.LOCALAPPDATA, "Programs", "Python", "Python311"));
      dirs.push(path.join(process.env.LOCALAPPDATA, "Programs", "Python", "Python310"));
    }
    for (const d of ["D:\\Python312\\Scripts", "D:\\Python312", "C:\\Python312\\Scripts", "C:\\Python312"]) {
      if (fs.existsSync(d)) dirs.push(d);
    }
  }
  return [...new Set(dirs)];
}

function which(cmd) {
  const dirs = getSearchDirs();
  const exts = IS_WIN ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const d of dirs) {
    for (const e of exts) {
      const p = path.join(d, cmd + e);
      if (fs.existsSync(p)) return p;
    }
  }
  return "";
}

function testPython(bin) {
  try {
    execFileSync(bin, ["--version"], { stdio: "ignore", timeout: 3000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function findPython() {
  for (const name of ["python", "python3", "py"]) {
    const p = which(name);
    if (p && testPython(p)) return { cmd: name, path: p };
  }
  if (IS_WIN) {
    const candidates = [
      "D:\\Python312\\python.exe",
      "C:\\Python312\\python.exe",
      "C:\\Python311\\python.exe",
      "C:\\Python310\\python.exe",
      path.join(process.env.LOCALAPPDATA || "", "Programs", "Python", "Python312", "python.exe"),
      path.join(process.env.LOCALAPPDATA || "", "Programs", "Python", "Python311", "python.exe"),
      path.join(process.env.LOCALAPPDATA || "", "Programs", "Python", "Python310", "python.exe"),
    ];
    for (const cand of candidates) {
      if (fs.existsSync(cand) && testPython(cand)) return { cmd: cand, path: cand };
    }
  }
  return null;
}

function findNpm() {
  const p = which("npm");
  if (p) return { cmd: "npm", path: p };
  return null;
}

function pidsOnPort(port) {
  return new Promise((resolve) => {
    if (IS_WIN) {
      execFile("netstat", ["-ano", "-p", "TCP"], { windowsHide: true }, (err, out) => {
        if (err) return resolve([]);
        const pids = new Set();
        for (const line of out.split(/\r?\n/)) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 5 && parts[3] === "LISTENING" && parts[1].endsWith(":" + port)) {
            pids.add(parts[4]);
          }
        }
        resolve([...pids].filter((p) => p !== "0"));
      });
    } else {
      execFile("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], (err, out) =>
        resolve(err ? [] : out.split(/\s+/).filter(Boolean))
      );
    }
  });
}

function killTree(pid) {
  return new Promise((resolve) => {
    if (IS_WIN) {
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () =>
        resolve()
      );
    } else {
      try {
        process.kill(-Number(pid), "SIGTERM");
      } catch {
        try {
          process.kill(Number(pid), "SIGTERM");
        } catch {}
      }
      resolve();
    }
  });
}

// ---------------------------------------------------------------- services

const children = { headroom: null, omniroute: null };
const startedAt = { headroom: 0, omniroute: 0 };

function findHeadroom() {
  if (config.headroom.command && fs.existsSync(config.headroom.command)) {
    return config.headroom.command;
  }
  const bin = which("headroom");
  if (bin) return bin;
  const py = findPython();
  if (py?.path) {
    const inPyScripts = path.join(path.dirname(py.path), "Scripts", IS_WIN ? "headroom.exe" : "headroom");
    if (fs.existsSync(inPyScripts)) return inPyScripts;
  }
  return "";
}

function omnirouteCommand() {
  const dir = config.omniroute.dir;
  if (dir && fs.existsSync(path.join(dir, "package.json"))) {
    return { cmd: "npm", args: ["run", "dev"], cwd: dir, label: `npm run dev (${dir})` };
  }
  const bin = which("omniroute");
  if (bin) return { cmd: bin, args: [], cwd: os.homedir(), label: bin };
  if (IS_WIN && process.env.APPDATA) {
    const appdataOmni = path.join(process.env.APPDATA, "npm", "omniroute.cmd");
    if (fs.existsSync(appdataOmni)) return { cmd: appdataOmni, args: [], cwd: os.homedir(), label: appdataOmni };
  }
  return null;
}

// ---------------------------------------------------------------- dependency installer

function checkEngines() {
  const python = findPython();
  const npm = findNpm();

  const omniCmd = omnirouteCommand();
  const omnirouteInstalled = Boolean(omniCmd);

  const headroomBin = findHeadroom();
  const headroomInstalled = Boolean(headroomBin);

  const missing = [];
  if (!omnirouteInstalled) missing.push("omniroute");
  if (!headroomInstalled) missing.push("headroom");

  const warnings = [];
  if (!npm && !omnirouteInstalled) {
    warnings.push("Node.js / npm is required to install OmniRoute. Download from https://nodejs.org/");
  }
  if (!python && !headroomInstalled) {
    warnings.push("Python 3 & pip are required to install Headroom. Download from https://www.python.org/downloads/ (ensure 'Add Python to PATH' is checked).");
  }

  const canInstall = (!missing.includes("omniroute") || Boolean(npm)) &&
                     (!missing.includes("headroom") || Boolean(python));

  return {
    missing,
    canInstall,
    omniroute: {
      installed: omnirouteInstalled,
      path: omniCmd?.label || "",
    },
    headroom: {
      installed: headroomInstalled,
      path: headroomBin || "",
    },
    prerequisites: {
      node: { found: true, version: process.version },
      npm: { found: Boolean(npm), path: npm?.path || "" },
      python: { found: Boolean(python), path: python?.path || "", cmd: python?.cmd || "" },
    },
    warnings,
  };
}

let isInstalling = false;

function runStreamingCommand(cmd, args, onLine, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      shell: IS_WIN && !cmd.toLowerCase().endsWith(".exe"),
      windowsHide: true,
      env: process.env,
    });
    let buffer = "";
    const handleData = (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        if (line.trim()) onLine(line.replace(ANSI, ""));
      }
    };
    child.stdout.on("data", handleData);
    child.stderr.on("data", handleData);

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Installation timed out after 5 minutes"));
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("exit", (code) => {
      clearTimeout(timer);
      if (buffer.trim()) onLine(buffer.replace(ANSI, ""));
      if (code === 0) resolve();
      else reject(new Error(`Command failed with exit code ${code}`));
    });
  });
}

async function handleInstallStream({ req, res }) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "connection": "keep-alive",
    "access-control-allow-origin": "*",
  });

  const send = (data) => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
  };

  if (isInstalling) {
    send({ type: "error", message: "An installation is already running. Please wait for it to complete." });
    res.end();
    return;
  }

  isInstalling = true;

  try {
    const status = checkEngines();
    if (status.missing.length === 0) {
      send({ type: "done", message: "All engines are already installed!", engines: status });
      res.end();
      return;
    }

    if (status.warnings.length > 0 && !status.canInstall) {
      send({
        type: "error",
        message: "Cannot install missing engines due to missing requirements:\n• " + status.warnings.join("\n• "),
        warnings: status.warnings,
        engines: status,
      });
      res.end();
      return;
    }

    send({
      type: "start",
      missing: status.missing,
      totalSteps: status.missing.length,
      message: `Starting installation for: ${status.missing.join(", ")}`,
    });

    let currentStep = 0;
    for (const eng of status.missing) {
      currentStep++;
      if (eng === "omniroute") {
        send({
          type: "step",
          step: "omniroute",
          index: currentStep,
          total: status.missing.length,
          message: "Installing OmniRoute via npm (npm install -g omniroute)...",
          cmd: "npm install -g omniroute",
        });
        log("routedeck", "▶ npm install -g omniroute");

        const npmCmd = IS_WIN ? "cmd.exe" : "npm";
        const npmArgs = IS_WIN ? ["/c", "npm", "install", "-g", "omniroute"] : ["install", "-g", "omniroute"];

        await runStreamingCommand(npmCmd, npmArgs, (line) => {
          log("omniroute", line);
          send({ type: "log", step: "omniroute", line });
        });

        send({ type: "step-success", step: "omniroute", message: "✓ OmniRoute successfully installed!" });
      } else if (eng === "headroom") {
        const py = status.prerequisites.python?.cmd || (status.prerequisites.python?.path ? status.prerequisites.python.path : "python");
        const cmdDisplay = `${py} -m pip install "headroom-ai[proxy]"`;

        send({
          type: "step",
          step: "headroom",
          index: currentStep,
          total: status.missing.length,
          message: `Installing Headroom via pip (${cmdDisplay})...`,
          cmd: cmdDisplay,
        });
        log("routedeck", `▶ ${cmdDisplay}`);

        const pyArgs = ["-m", "pip", "install", "headroom-ai[proxy]"];
        await runStreamingCommand(py, pyArgs, (line) => {
          log("headroom", line);
          send({ type: "log", step: "headroom", line });
        });

        send({ type: "step-success", step: "headroom", message: "✓ Headroom successfully installed!" });
      }
    }

    const postStatus = checkEngines();
    send({
      type: "done",
      success: true,
      message: "✓ All engines installed and ready to start!",
      engines: postStatus,
    });
    res.end();
  } catch (err) {
    send({
      type: "error",
      message: `Installation failed: ${err.message}`,
    });
    res.end();
  } finally {
    isInstalling = false;
  }
}

function spawnService(name, cmd, args, cwd, env) {
  log(name, `▶ ${cmd} ${args.join(" ")}`);
  const child = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    shell: IS_WIN && /\.(cmd|bat)$|^npm$/i.test(path.basename(cmd)),
    windowsHide: true,
    detached: !IS_WIN,
  });
  child.stdout.on("data", (d) => log(name, d));
  child.stderr.on("data", (d) => log(name, d));
  child.on("exit", (code) => {
    log(name, `■ stopped (exit code ${code})`);
    if (children[name] === child) children[name] = null;
  });
  child.on("error", (e) => log(name, `✖ ${e.message}`));
  children[name] = child;
  startedAt[name] = Date.now();
}

async function startOmniRoute() {
  if (!config.omniroute.enabled) return { skipped: "disabled in settings" };
  if (await portOpen(config.omniroute.port)) return { alreadyRunning: true };
  const c = omnirouteCommand();
  if (!c) {
    throw new Error("OmniRoute not found. Install it with: npm install -g omniroute");
  }
  const env = { PORT: String(config.omniroute.port) };
  // Windows: SWC refuses cache folders with loose permissions. Use a private one if present.
  const swcCache = path.join(os.homedir(), ".swc-native-cache");
  if (IS_WIN && fs.existsSync(swcCache)) env.SWC_NATIVE_BINDING_CACHE = swcCache;
  spawnService("omniroute", c.cmd, c.args, c.cwd, env);
  return { started: true, via: c.label };
}

async function startHeadroom() {
  if (!config.headroom.enabled) return { skipped: "disabled in settings" };
  if (await portOpen(config.headroom.port)) return { alreadyRunning: true };
  const bin = findHeadroom();
  if (!bin) {
    throw new Error('Headroom not found. Install it with: pip install "headroom-ai[proxy]"');
  }
  const h = config.headroom;
  const args = ["proxy", "--port", String(h.port), "--mode", h.mode];
  if (!h.optimize) args.push("--no-optimize");
  if (!h.cache) args.push("--no-cache");
  if (!h.kompress) args.push("--disable-kompress");
  if (config.omniroute.enabled) {
    const up = `http://127.0.0.1:${config.omniroute.port}`;
    args.push("--openai-api-url", up, "--anthropic-api-url", up);
  }
  const env = { PYTHONUTF8: "1", HEADROOM_BEACON: h.shareStats ? "on" : "off" };
  spawnService("headroom", bin, args, path.dirname(bin), env);
  return { started: true, via: bin };
}

async function stopService(name) {
  const port = config[name].port;
  const child = children[name];
  if (child?.pid) await killTree(child.pid);
  for (const pid of await pidsOnPort(port)) await killTree(pid);
  children[name] = null;
  log(name, "■ stop requested");
  return { stopped: true };
}

async function serviceStatus() {
  const [hOpen, oOpen] = await Promise.all([
    portOpen(config.headroom.port),
    portOpen(config.omniroute.port),
  ]);
  let headroomHealth = null;
  if (hOpen) {
    try {
      const r = await fetchJson(`http://127.0.0.1:${config.headroom.port}/health`, {}, 2500);
      headroomHealth = r.body?.status || (r.ok ? "healthy" : "unhealthy");
    } catch {
      headroomHealth = "starting";
    }
  }
  const state = (name, open) => {
    if (!config[name].enabled) return "off";
    if (open) return "running";
    if (children[name]) return "starting";
    return "stopped";
  };
  return {
    headroom: {
      state: state("headroom", hOpen && headroomHealth !== "starting"),
      port: config.headroom.port,
      health: headroomHealth,
      managed: Boolean(children.headroom),
      found: Boolean(findHeadroom()),
      startedAt: startedAt.headroom,
    },
    omniroute: {
      state: state("omniroute", oOpen),
      port: config.omniroute.port,
      managed: Boolean(children.omniroute),
      found: Boolean(omnirouteCommand()),
      loggedIn: Boolean(session.cookie),
      startedAt: startedAt.omniroute,
    },
    claude: { found: Boolean(which("claude")) },
  };
}

// ---------------------------------------------------------------- OmniRoute API

const session = { cookie: "" };

function omniBase() {
  return `http://127.0.0.1:${config.omniroute.port}`;
}

async function omniLogin(password = config.omniroute.password) {
  if (!password) throw httpError(401, "Enter your OmniRoute password in Settings first.");
  const r = await fetchJson(
    `${omniBase()}/api/auth/login`,
    {
      method: "POST",
      headers: { "content-type": "application/json", origin: omniBase() },
      body: JSON.stringify({ password }),
    },
    15000
  );
  if (!r.ok) {
    throw httpError(r.status, r.body?.error?.message || r.body?.error || "Login failed");
  }
  const cookies = (r.headers.getSetCookie?.() || [])
    .map((c) => c.split(";")[0])
    .filter(Boolean);
  session.cookie = cookies.join("; ");
  return true;
}

async function omni(pathname, { method = "GET", body } = {}, retried = false) {
  if (!session.cookie) await omniLogin();
  const headers = { cookie: session.cookie, origin: omniBase() };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET") {
    const csrf = await fetchJson(`${omniBase()}/api/auth/csrf`, { headers }, 8000);
    if (csrf.body?.token) headers["x-omniroute-csrf"] = csrf.body.token;
  }
  const r = await fetchJson(
    omniBase() + pathname,
    { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
    60000
  );
  if (r.status === 401 && !retried) {
    session.cookie = "";
    return omni(pathname, { method, body }, true);
  }
  if (!r.ok) {
    const msg =
      r.body?.error?.message || r.body?.error || r.body?.message || `OmniRoute said ${r.status}`;
    throw httpError(r.status, typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return r.body;
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// ---------------------------------------------------------------- AI Clients (Claude Code, Cursor, OpenCode, Cline, Aider)

const CLIENTS = {
  claude: {
    id: "claude",
    name: "Claude Code",
    tagline: "Anthropic's terminal-based agentic coding tool",
    bin: "claude",
    installNote: "Run: npm install -g @anthropic-ai/claude-code",
    configType: "env",
    configFile: "Environment variables",
  },
  cursor: {
    id: "cursor",
    name: "Cursor",
    tagline: "AI-first code editor with OpenAI/Anthropic model support",
    bin: "cursor",
    installNote: "Download Cursor from https://cursor.com",
    configType: "file",
    configFile: ".cursor/settings.json",
  },
  opencode: {
    id: "opencode",
    name: "OpenCode",
    tagline: "Open-source terminal coding agent & code interpreter",
    bin: "opencode",
    installNote: "Run: pip install opencode-ai (or npm install -g opencode)",
    configType: "file",
    configFile: "opencode.json",
  },
  cline: {
    id: "cline",
    name: "Cline",
    tagline: "Autonomous coding agent extension for VS Code",
    bin: "code",
    installNote: "Install VS Code and the Cline extension",
    configType: "file",
    configFile: ".vscode/settings.json",
  },
  aider: {
    id: "aider",
    name: "Aider",
    tagline: "AI pair programming in your terminal",
    bin: "aider",
    installNote: "Run: pip install aider-chat",
    configType: "file",
    configFile: ".aider.conf.yml",
  },
};

function getEndpointUrls(route = config.claude.route) {
  const viaHeadroom = route !== "omniroute" && config.headroom.enabled;
  const port = viaHeadroom ? config.headroom.port : config.omniroute.port;
  const apiKey = (route !== "headroom" && config.omniroute.apiKey) || "routedeck";
  return {
    port,
    anthropicBaseUrl: `http://localhost:${port}`,
    openaiBaseUrl: `http://localhost:${port}/v1`,
    apiKey,
  };
}

function getClientDetails(clientId, targetDir, model, route) {
  const dir = targetDir || config.claude.workDir || os.homedir();
  const ep = getEndpointUrls(route);
  const effectiveModel = model || config.claude.model || "gemini/gemini-2.5-flash";
  const def = CLIENTS[clientId] || CLIENTS.claude;
  const isInstalled = Boolean(which(def.bin));

  let configSnippet = "";
  let launchCmd = "";

  if (clientId === "claude") {
    launchCmd = claudeCommandText();
    configSnippet = `# Environment variables automatically configured on launch:\nANTHROPIC_BASE_URL=${ep.anthropicBaseUrl}\nANTHROPIC_AUTH_TOKEN=${ep.apiKey}\n${effectiveModel ? `ANTHROPIC_MODEL=${effectiveModel}\n` : ""}`;
  } else if (clientId === "cursor") {
    launchCmd = IS_WIN ? `cursor "${dir}"` : `cursor ${JSON.stringify(dir)}`;
    configSnippet = JSON.stringify({
      "cursor.openaiBaseUrl": ep.openaiBaseUrl,
      "cursor.openaiApiKey": ep.apiKey,
      "cursor.model": effectiveModel,
    }, null, 2);
  } else if (clientId === "cline") {
    launchCmd = IS_WIN ? `code "${dir}"` : `code ${JSON.stringify(dir)}`;
    configSnippet = JSON.stringify({
      "cline.apiProvider": "openai-compatible",
      "cline.openAiBaseUrl": ep.openaiBaseUrl,
      "cline.openAiApiKey": ep.apiKey,
      "cline.openAiModelId": effectiveModel,
    }, null, 2);
  } else if (clientId === "opencode") {
    launchCmd = IS_WIN
      ? `set OPENAI_BASE_URL=${ep.openaiBaseUrl} && set OPENAI_API_KEY=${ep.apiKey} && opencode`
      : `OPENAI_BASE_URL=${ep.openaiBaseUrl} OPENAI_API_KEY=${ep.apiKey} opencode`;
    configSnippet = JSON.stringify({
      "api_base": ep.openaiBaseUrl,
      "api_key": ep.apiKey,
      "model": effectiveModel,
    }, null, 2);
  } else if (clientId === "aider") {
    launchCmd = `aider --openai-api-base ${ep.openaiBaseUrl} --openai-api-key ${ep.apiKey} --model openai/${effectiveModel}`;
    configSnippet = `# .aider.conf.yml\nopenai-api-base: ${ep.openaiBaseUrl}\nopenai-api-key: ${ep.apiKey}\nmodel: openai/${effectiveModel}\nanalytics: false\n`;
  }

  return {
    ...def,
    installed: isInstalled,
    launchCommand: launchCmd,
    configSnippet,
    endpoints: ep,
  };
}

function configureClient(clientId, targetDir, model, route) {
  const dir = targetDir && fs.existsSync(targetDir) ? targetDir : (config.claude.workDir && fs.existsSync(config.claude.workDir) ? config.claude.workDir : os.homedir());
  const ep = getEndpointUrls(route);
  const effectiveModel = model || config.claude.model || "gemini/gemini-2.5-flash";

  if (clientId === "cursor") {
    const cursorDir = path.join(dir, ".cursor");
    fs.mkdirSync(cursorDir, { recursive: true });
    const settingsPath = path.join(cursorDir, "settings.json");
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(settingsPath, "utf8")); } catch {}
    existing["cursor.openaiBaseUrl"] = ep.openaiBaseUrl;
    existing["cursor.openaiApiKey"] = ep.apiKey;
    if (effectiveModel) existing["cursor.model"] = effectiveModel;
    fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2), "utf8");

    const rulesPath = path.join(dir, ".cursorrules");
    if (!fs.existsSync(rulesPath)) {
      fs.writeFileSync(rulesPath, `# RouteDeck AI Configuration\n# Base URL: ${ep.openaiBaseUrl}\n# Model: ${effectiveModel}\n`, "utf8");
    }
    return {
      success: true,
      file: settingsPath,
      message: `Configured Cursor settings in ${settingsPath}`,
    };
  }

  if (clientId === "cline") {
    const vscodeDir = path.join(dir, ".vscode");
    fs.mkdirSync(vscodeDir, { recursive: true });
    const settingsPath = path.join(vscodeDir, "settings.json");
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(settingsPath, "utf8")); } catch {}
    existing["cline.apiProvider"] = "openai-compatible";
    existing["cline.openAiBaseUrl"] = ep.openaiBaseUrl;
    existing["cline.openAiApiKey"] = ep.apiKey;
    if (effectiveModel) existing["cline.openAiModelId"] = effectiveModel;
    fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2), "utf8");
    return {
      success: true,
      file: settingsPath,
      message: `Configured Cline (VS Code) settings in ${settingsPath}`,
    };
  }

  if (clientId === "opencode") {
    const configPath = path.join(dir, "opencode.json");
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(configPath, "utf8")); } catch {}
    existing.api_base = ep.openaiBaseUrl;
    existing.api_key = ep.apiKey;
    if (effectiveModel) existing.model = effectiveModel;
    fs.writeFileSync(configPath, JSON.stringify(existing, null, 2), "utf8");
    return {
      success: true,
      file: configPath,
      message: `Configured OpenCode in ${configPath}`,
    };
  }

  if (clientId === "aider") {
    const configPath = path.join(dir, ".aider.conf.yml");
    const yml = [
      `# RouteDeck Aider Configuration`,
      `openai-api-base: ${ep.openaiBaseUrl}`,
      `openai-api-key: ${ep.apiKey}`,
      effectiveModel ? `model: openai/${effectiveModel}` : `model: openai/gemini/gemini-2.5-flash`,
      `analytics: false`,
    ].join("\n") + "\n";
    fs.writeFileSync(configPath, yml, "utf8");
    return {
      success: true,
      file: configPath,
      message: `Configured Aider in ${configPath}`,
    };
  }

  if (clientId === "claude") {
    return {
      success: true,
      message: "Claude Code is configured via environment variables automatically when launched.",
    };
  }

  throw httpError(400, `Unknown client: ${clientId}`);
}

function launchClient(clientId, targetDir, model, route) {
  const cwd = targetDir && fs.existsSync(targetDir) ? targetDir : (config.claude.workDir && fs.existsSync(config.claude.workDir) ? config.claude.workDir : os.homedir());
  const ep = getEndpointUrls(route);
  const effectiveModel = model || config.claude.model || "";

  if (clientId === "claude") {
    return launchClaude();
  }

  if (clientId === "cursor") {
    const bin = which("cursor");
    if (!bin) {
      throw httpError(400, "Cursor CLI ('cursor') not found. Please install Cursor and ensure 'cursor' is added to PATH.");
    }
    configureClient("cursor", cwd, model, route);
    spawn(bin, [cwd], { detached: true, stdio: "ignore", shell: IS_WIN }).unref();
    log("routedeck", `Opened Cursor in ${cwd}`);
    return { launched: true, client: "cursor" };
  }

  if (clientId === "cline") {
    const bin = which("code");
    if (!bin) {
      throw httpError(400, "VS Code CLI ('code') not found. Please install VS Code and ensure 'code' is added to PATH.");
    }
    configureClient("cline", cwd, model, route);
    spawn(bin, [cwd], { detached: true, stdio: "ignore", shell: IS_WIN }).unref();
    log("routedeck", `Opened VS Code (Cline) in ${cwd}`);
    return { launched: true, client: "cline" };
  }

  if (clientId === "opencode") {
    const bin = which("opencode");
    if (!bin) {
      throw httpError(400, "OpenCode not found. Install it with: pip install opencode-ai (or npm install -g opencode)");
    }
    const env = {
      ...process.env,
      OPENAI_BASE_URL: ep.openaiBaseUrl,
      OPENAI_API_KEY: ep.apiKey,
      ...(effectiveModel ? { OPENAI_MODEL: effectiveModel } : {}),
    };
    if (IS_WIN) {
      spawn("cmd.exe", ["/c", "start", '"RouteDeck - OpenCode"', "cmd", "/k", "opencode"], {
        cwd,
        env,
        detached: true,
        stdio: "ignore",
        windowsVerbatimArguments: true,
      }).unref();
    } else if (process.platform === "darwin") {
      const script = `cd ${JSON.stringify(cwd)} && OPENAI_BASE_URL=${JSON.stringify(ep.openaiBaseUrl)} OPENAI_API_KEY=${JSON.stringify(ep.apiKey)} opencode`;
      spawn("osascript", ["-e", `tell application "Terminal" to do script ${JSON.stringify(script)}`], {
        detached: true,
        stdio: "ignore",
      }).unref();
    } else {
      spawn("x-terminal-emulator", ["-e", "opencode"], { cwd, env, detached: true, stdio: "ignore" }).unref();
    }
    log("routedeck", `Opened OpenCode in ${cwd}`);
    return { launched: true, client: "opencode" };
  }

  if (clientId === "aider") {
    const bin = which("aider");
    if (!bin) {
      throw httpError(400, "Aider not found. Install it with: pip install aider-chat");
    }
    const aiderModel = effectiveModel ? `openai/${effectiveModel}` : "openai/gemini/gemini-2.5-flash";
    const aiderArgs = ["--openai-api-base", ep.openaiBaseUrl, "--openai-api-key", ep.apiKey, "--model", aiderModel];
    const env = {
      ...process.env,
      OPENAI_API_BASE: ep.openaiBaseUrl,
      OPENAI_API_KEY: ep.apiKey,
    };
    if (IS_WIN) {
      const fullCmd = `aider ${aiderArgs.join(" ")}`;
      spawn("cmd.exe", ["/c", "start", '"RouteDeck - Aider"', "cmd", "/k", fullCmd], {
        cwd,
        env,
        detached: true,
        stdio: "ignore",
        windowsVerbatimArguments: true,
      }).unref();
    } else if (process.platform === "darwin") {
      const script = `cd ${JSON.stringify(cwd)} && aider ${aiderArgs.map(x => JSON.stringify(x)).join(" ")}`;
      spawn("osascript", ["-e", `tell application "Terminal" to do script ${JSON.stringify(script)}`], {
        detached: true,
        stdio: "ignore",
      }).unref();
    } else {
      spawn("x-terminal-emulator", ["-e", `aider ${aiderArgs.join(" ")}`], { cwd, env, detached: true, stdio: "ignore" }).unref();
    }
    log("routedeck", `Opened Aider in ${cwd}`);
    return { launched: true, client: "aider" };
  }

  throw httpError(400, `Unknown client: ${clientId}`);
}

function claudeEnv() {
  const c = config.claude;
  const viaHeadroom = c.route !== "omniroute" && config.headroom.enabled;
  const port = viaHeadroom ? config.headroom.port : config.omniroute.port;
  const env = { ANTHROPIC_BASE_URL: `http://localhost:${port}` };
  if (c.route !== "headroom") {
    env.ANTHROPIC_AUTH_TOKEN = config.omniroute.apiKey || "routedeck";
  }
  if (ponytailState.installed && c.ponytailMode) env.PONYTAIL_DEFAULT_MODE = c.ponytailMode;
  if (c.model) {
    for (const k of [
      "ANTHROPIC_MODEL",
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      "CLAUDE_CODE_SUBAGENT_MODEL",
    ]) {
      env[k] = c.model;
    }
  }
  return env;
}

function claudeCommandText() {
  const env = claudeEnv();
  if (IS_WIN) {
    return Object.entries(env)
      .map(([k, v]) => `set ${k}=${v}`)
      .concat("claude")
      .join(" && ");
  }
  return (
    Object.entries(env)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(" ") + " claude"
  );
}

function launchClaude() {
  if (!which("claude")) {
    throw httpError(400, "Claude Code is not installed. Run: npm install -g @anthropic-ai/claude-code");
  }
  const env = { ...process.env, ...claudeEnv() };
  const cwd = fs.existsSync(config.claude.workDir) ? config.claude.workDir : os.homedir();
  if (IS_WIN) {
    spawn("cmd.exe", ["/c", "start", '"RouteDeck - Claude Code"', "cmd", "/k", "claude"], {
      cwd,
      env,
      detached: true,
      stdio: "ignore",
      windowsVerbatimArguments: true,
    }).unref();
  } else if (process.platform === "darwin") {
    const script = `cd ${JSON.stringify(cwd)} && ${claudeCommandText()}`;
    spawn("osascript", ["-e", `tell application "Terminal" to do script ${JSON.stringify(script)}`], {
      detached: true,
      stdio: "ignore",
    }).unref();
  } else {
    spawn("x-terminal-emulator", ["-e", "claude"], { cwd, env, detached: true, stdio: "ignore" }).unref();
  }
  log("routedeck", `Opened Claude Code in ${cwd} via ${claudeEnv().ANTHROPIC_BASE_URL}`);
  return { launched: true };
}

// ---------------------------------------------------------------- Ponytail (Claude Code plugin)
// https://github.com/DietrichGebert/ponytail: a skill that makes coding agents write less code.

const PONYTAIL_ID = "ponytail@ponytail";
const PONYTAIL_MARKETPLACE = "DietrichGebert/ponytail";
const ponytailState = { installed: false, enabled: false, version: "", checkedAt: 0 };

function runClaude(args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const bin = which("claude");
    if (!bin) return reject(httpError(400, "Claude Code is not installed."));
    const child = spawn(bin, args, {
      shell: IS_WIN, // claude is a .cmd shim on Windows; args are fixed constants.
      windowsHide: true,
      env: process.env,
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      log("routedeck", `claude ${args.join(" ")} → exit ${code}`);
      if (code === 0) resolve(out);
      else reject(httpError(500, out.replace(ANSI, "").trim().split(/\r?\n/).slice(-3).join(" ") || `claude exited with ${code}`));
    });
  });
}

async function refreshPonytail() {
  try {
    const list = JSON.parse(await runClaude(["plugin", "list", "--json"], 30000));
    const p = (Array.isArray(list) ? list : []).find((x) => String(x.id).startsWith("ponytail@"));
    Object.assign(ponytailState, {
      installed: Boolean(p),
      enabled: Boolean(p?.enabled),
      version: p?.version || "",
      checkedAt: Date.now(),
    });
  } catch {
    ponytailState.checkedAt = Date.now();
  }
  return ponytailState;
}

// ---------------------------------------------------------------- history (sampled from Headroom)

const HISTORY_FILE = path.join(HOME_DIR, "history.json");
const HISTORY_MAX = 7 * 24 * 12; // one week at 5-minute resolution
let history = [];
try {
  history = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  if (!Array.isArray(history)) history = [];
} catch {}

async function sampleHistory() {
  if (!config.headroom.enabled || !(await portOpen(config.headroom.port))) return;
  try {
    const r = await fetchJson(`http://127.0.0.1:${config.headroom.port}/stats-lifetime`, {}, 5000);
    const b = r.body || {};
    history.push({
      t: Date.now(),
      requests: b.requests?.total || 0,
      failed: b.requests?.failed || 0,
      tokensIn: b.tokens?.input || 0,
      tokensOut: b.tokens?.output || 0,
      tokensSaved: b.tokens?.saved || 0,
    });
    if (history.length > HISTORY_MAX) history.splice(0, history.length - HISTORY_MAX);
    fs.mkdirSync(HOME_DIR, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history));
  } catch {}
}

// ---------------------------------------------------------------- launch at login (Windows)

// ---------------------------------------------------------------- launch at login (Cross-Platform)

function getAutostartPath() {
  if (IS_WIN) {
    return path.join(
      process.env.APPDATA || "",
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "Startup",
      "RouteDeck.cmd"
    );
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "LaunchAgents", "com.routedeck.app.plist");
  }
  return path.join(os.homedir(), ".config", "autostart", "routedeck.desktop");
}

function applyLaunchAtLogin() {
  const f = getAutostartPath();
  const dir = path.dirname(f);
  if (config.app.launchAtLogin) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const node = process.execPath;
      const script = path.join(ROOT, "server.mjs");
      if (IS_WIN) {
        fs.writeFileSync(
          f,
          `@echo off\r\nstart "" /min "${node}" "${script}" --background\r\n`
        );
      } else if (process.platform === "darwin") {
        const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.routedeck.app</string>
    <key>ProgramArguments</key>
    <array>
        <string>${node}</string>
        <string>${script}</string>
        <string>--background</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
</dict>
</plist>\n`;
        fs.writeFileSync(f, plist, "utf8");
      } else {
        const desktop = `[Desktop Entry]
Type=Application
Version=1.0
Name=RouteDeck
Comment=Start RouteDeck AI router in background
Exec="${node}" "${script}" --background
Terminal=false
Hidden=false
X-GNOME-Autostart-enabled=true
`;
        fs.writeFileSync(f, desktop, "utf8");
      }
      log("routedeck", `Configured OS autostart at ${f}`);
    } catch (e) {
      log("routedeck", `Failed to set autostart: ${e.message}`);
    }
  } else if (fs.existsSync(f)) {
    try {
      fs.unlinkSync(f);
      log("routedeck", `Removed OS autostart file ${f}`);
    } catch (e) {
      log("routedeck", `Failed to remove autostart: ${e.message}`);
    }
  }
}

// ---------------------------------------------------------------- HTTP API

async function readBody(req) {
  let data = "";
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 1e6) throw httpError(413, "Body too large");
  }
  return data ? JSON.parse(data) : {};
}

const routes = {
  "GET /api/status": async () => serviceStatus(),
  "POST /api/start": async ({ body }) => {
    const which_ = body.service || "all";
    const out = {};
    // OmniRoute first so Headroom has somewhere to send traffic.
    if (which_ === "all" || which_ === "omniroute") out.omniroute = await startOmniRoute();
    if (which_ === "all" || which_ === "headroom") out.headroom = await startHeadroom();
    return out;
  },
  "POST /api/stop": async ({ body }) => {
    const which_ = body.service || "all";
    const out = {};
    if (which_ === "all" || which_ === "headroom") out.headroom = await stopService("headroom");
    if (which_ === "all" || which_ === "omniroute") out.omniroute = await stopService("omniroute");
    return out;
  },
  "POST /api/restart": async ({ body }) => {
    await routes["POST /api/stop"]({ body });
    await new Promise((r) => setTimeout(r, 1500));
    return routes["POST /api/start"]({ body });
  },
  "GET /api/logs": async ({ url }) => {
    const svc = url.searchParams.get("service") || "headroom";
    const since = Number(url.searchParams.get("since") || 0);
    return { lines: (logs[svc] || []).filter((l) => l.t > since).slice(-400) };
  },
  "GET /api/config": async () => publicConfig(),
  "POST /api/config": async ({ body }) => {
    const incoming = structuredClone(body);
    // Blank secret fields mean "keep the saved one".
    if (incoming.omniroute) {
      if (!incoming.omniroute.password) delete incoming.omniroute.password;
      if (!incoming.omniroute.apiKey) delete incoming.omniroute.apiKey;
      if (incoming.omniroute.password) session.cookie = "";
    }
    config = deepMerge(config, incoming);
    saveConfig();
    applyLaunchAtLogin();
    return publicConfig();
  },
  "POST /api/config/clear-secret": async ({ body }) => {
    if (body.field === "password") {
      config.omniroute.password = "";
      session.cookie = "";
    }
    if (body.field === "apiKey") config.omniroute.apiKey = "";
    saveConfig();
    return publicConfig();
  },
  "GET /api/detect": async () => ({
    headroom: findHeadroom(),
    omniroute: omnirouteCommand()?.label || "",
    claude: which("claude"),
    node: process.version,
    platform: process.platform,
  }),
  "POST /api/omniroute/login": async ({ body }) => {
    await omniLogin(body.password || config.omniroute.password);
    if (body.password && body.remember !== false) {
      config.omniroute.password = body.password;
      saveConfig();
    }
    return { loggedIn: true };
  },
  "GET /api/catalog": async () => CATALOG,
  "POST /api/providers/connect-keyless": async () => {
    if (!config.omniroute.enabled) throw httpError(400, "OmniRoute is disabled in settings.");
    if (!(await portOpen(config.omniroute.port))) {
      await startOmniRoute();
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 500));
        if (await portOpen(config.omniroute.port)) break;
      }
    }

    const keyless = CATALOG.filter((p) => p.keyless);
    let existingList = [];
    try {
      const existing = await omni("/api/providers");
      existingList = Array.isArray(existing) ? existing : (existing?.connections || existing?.providers || []);
    } catch {}
    const existingIds = new Set(existingList.map((p) => p.provider));

    const results = [];
    for (const item of keyless) {
      const canonicalId = item.id === "kilo-gateway" ? "kilocode" : item.id;
      if (existingIds.has(item.id) || existingIds.has(canonicalId)) {
        results.push({ provider: item.id, name: item.name, status: "already_connected" });
        continue;
      }
      try {
        let created = null;
        try {
          created = await omni("/api/providers", {
            method: "POST",
            body: {
              provider: canonicalId,
              name: item.name,
              allowNoCredential: true,
            },
          });
        } catch {
          // Fallback with anonymous token for keyless providers categorized under apikey in OmniRoute
          created = await omni("/api/providers", {
            method: "POST",
            body: {
              provider: canonicalId,
              name: item.name,
              apiKey: "anonymous",
            },
          });
        }

        const connectionId = created?.connection?.id || created?.id;
        if (connectionId) {
          try {
            await omni(`/api/providers/${encodeURIComponent(connectionId)}`, {
              method: "PUT",
              body: { isActive: true },
            });
          } catch {}
        }

        results.push({ provider: item.id, name: item.name, status: "connected" });
      } catch (err) {
        results.push({ provider: item.id, name: item.name, status: "error", error: err.message });
      }
    }

    const connectedOrExisting = results.filter((r) => r.status === "connected" || r.status === "already_connected").length;

    return {
      success: true,
      connectedCount: connectedOrExisting,
      total: keyless.length,
      results,
    };
  },
  "GET /api/providers": async () => {
    const data = await omni("/api/providers");
    const list = data?.connections || data?.providers || data || [];
    return (Array.isArray(list) ? list : []).map((c) => ({
      id: c.id,
      provider: c.provider,
      name: c.name || c.displayName || c.provider,
      isActive: c.isActive !== false && c.is_active !== 0,
      testStatus: c.testStatus || c.test_status || "",
      lastError: c.lastError || c.last_error || "",
      apiKey: c.apiKey || "",
    }));
  },
  "POST /api/providers": async ({ body }) => {
    const entry = CATALOG.find((p) => p.id === body.provider);
    const payload = {
      provider: body.provider,
      name: body.name || entry?.name || body.provider,
    };
    if (body.apiKey) payload.apiKey = String(body.apiKey).trim();
    else payload.allowNoCredential = true;
    const created = await omni("/api/providers", { method: "POST", body: payload });
    return created;
  },
  "POST /api/providers/toggle": async ({ body }) =>
    omni(`/api/providers/${encodeURIComponent(body.id)}`, {
      method: "PUT",
      body: { isActive: Boolean(body.isActive) },
    }),
  "POST /api/providers/test": async ({ body }) =>
    omni(`/api/providers/${encodeURIComponent(body.id)}/test`, { method: "POST", body: {} }),
  "POST /api/providers/delete": async ({ body }) =>
    omni(`/api/providers/${encodeURIComponent(body.id)}`, { method: "DELETE" }),
  "GET /api/models": async () => {
    try {
      const data = await omni("/v1/models");
      const list = (data?.data || []).map((m) => m.id).filter(Boolean);
      return [...new Set(list)].sort();
    } catch {
      return [];
    }
  },
  "GET /api/savings": async () => {
    if (!(await portOpen(config.headroom.port))) return { running: false };
    const r = await fetchJson(`http://127.0.0.1:${config.headroom.port}/stats`, {}, 5000);
    const s = r.body?.summary || {};
    return {
      running: true,
      requests: s.api_requests || 0,
      compressed: s.compression?.requests_compressed || 0,
      tokensSaved: s.compression?.total_tokens_saved_all_layers || 0,
      tokensBefore: s.compression?.total_tokens_before || 0,
      avgPct: s.compression?.avg_compression_pct || 0,
      bestPct: s.compression?.best_compression_pct || 0,
      usdSaved: s.cost?.total_saved_usd || 0,
    };
  },
  "GET /api/history": async ({ url }) => {
    const hours = Math.min(Number(url.searchParams.get("hours") || 24), 24 * 7);
    const since = Date.now() - hours * 3600e3;
    return history.filter((p) => p.t >= since);
  },
  "GET /api/analytics": async ({ url }) => {
    const range = ["1d", "7d", "30d", "90d"].includes(url.searchParams.get("range"))
      ? url.searchParams.get("range")
      : "7d";
    const out = { range, omniroute: null, omnirouteError: "", headroom: null };
    // Headroom (no login needed)
    if (config.headroom.enabled && (await portOpen(config.headroom.port))) {
      try {
        const r = await fetchJson(`http://127.0.0.1:${config.headroom.port}/stats`, {}, 6000);
        const s = r.body || {};
        out.headroom = {
          requests: s.requests?.total || 0,
          cached: s.requests?.cached || 0,
          failed: s.requests?.failed || 0,
          tokensIn: s.tokens?.input || 0,
          tokensOut: s.tokens?.output || 0,
          tokensSaved: s.summary?.compression?.total_tokens_saved_all_layers || 0,
          avgPct: s.summary?.compression?.avg_compression_pct || 0,
          byModel: s.requests?.by_model || {},
          layers: {
            Compression: s.savings?.by_layer?.compression?.all_layers_tokens || 0,
            "Output shaping": s.savings?.by_layer?.output_shaping?.tokens_saved || 0,
            "Tool search": s.savings?.by_layer?.tool_search?.tokens_saved || s.summary?.compression?.tool_schema_tokens_saved || 0,
            "Prefix cache": s.prefix_cache?.cache_read_tokens || 0,
          },
        };
      } catch {}
    }
    // OmniRoute (needs login)
    if (config.omniroute.enabled && (await portOpen(config.omniroute.port))) {
      try {
        const a = await omni(`/api/usage/analytics?range=${range}`);
        const top = (rows, n) =>
          (Array.isArray(rows) ? rows : [])
            .slice()
            .sort((x, y) => (y.requests || 0) - (x.requests || 0))
            .slice(0, n);
        out.omniroute = {
          summary: a?.summary || {},
          dailyTrend: a?.dailyTrend || [],
          byProvider: top(a?.byProvider, 8).map((p) => ({
            name: p.provider || p.name || "unknown",
            requests: Number(p.requests || 0),
            tokens: Number(p.totalTokens || 0),
            successRatePct: p.successRatePct ?? null,
          })),
          byModel: top(a?.byModel, 8).map((m) => ({
            name: m.model || m.rawModel || "unknown",
            provider: m.provider || "",
            requests: Number(m.requests || 0),
            tokens: Number(m.totalTokens || 0),
            avgLatencyMs: m.avgLatencyMs ?? null,
          })),
          errors: (a?.errorBreakdown || []).map((e) => ({ type: e.errorType || e.type, count: e.count })),
        };
      } catch (e) {
        out.omnirouteError = e.message;
      }
    } else {
      out.omnirouteError = "OmniRoute is not running.";
    }
    return out;
  },
  "GET /api/ponytail": async ({ url }) => {
    if (url.searchParams.get("refresh") || !ponytailState.checkedAt) await refreshPonytail();
    return { ...ponytailState, mode: config.claude.ponytailMode, claudeFound: Boolean(which("claude")) };
  },
  "POST /api/ponytail/install": async () => {
    try {
      await runClaude(["plugin", "marketplace", "add", PONYTAIL_MARKETPLACE]);
    } catch (e) {
      // Already added is fine; anything else surfaces from the install step.
      log("routedeck", `marketplace add: ${e.message}`);
    }
    await runClaude(["plugin", "install", PONYTAIL_ID]);
    return refreshPonytail();
  },
  "POST /api/ponytail/uninstall": async () => {
    await runClaude(["plugin", "uninstall", PONYTAIL_ID]);
    return refreshPonytail();
  },
  "GET /api/claude/command": async () => ({ command: claudeCommandText(), env: claudeEnv() }),
  "POST /api/claude/launch": async () => launchClaude(),
  "GET /api/clients/status": async ({ url }) => {
    const dir = url.searchParams.get("workDir") || config.claude.workDir || os.homedir();
    const model = url.searchParams.get("model") || config.claude.model || "";
    const route = url.searchParams.get("route") || config.claude.route || "both";
    const result = {};
    for (const [id, def] of Object.entries(CLIENTS)) {
      result[id] = getClientDetails(id, dir, model, route);
    }
    return { clients: result, activeRoute: route, activeModel: model, workDir: dir };
  },
  "POST /api/clients/launch": async ({ body }) => {
    const client = body.client || "claude";
    return launchClient(client, body.workDir, body.model, body.route);
  },
  "POST /api/clients/configure": async ({ body }) => {
    const client = body.client || "cursor";
    return configureClient(client, body.workDir, body.model, body.route);
  },
  "GET /api/providers/health": async () => {
    let providers = [];
    let isRunning = false;
    let errorMsg = "";
    if (config.omniroute.enabled && (await portOpen(config.omniroute.port))) {
      isRunning = true;
      try {
        const data = await omni("/api/providers");
        const list = data?.connections || data?.providers || data || [];
        providers = (Array.isArray(list) ? list : []).map((c) => {
          const testStatus = String(c.testStatus || c.test_status || "").toLowerCase();
          const lastError = String(c.lastError || c.last_error || "").toLowerCase();
          const isActive = c.isActive !== false && c.is_active !== 0;

          const isRateLimited =
            testStatus.includes("rate") ||
            testStatus.includes("429") ||
            testStatus.includes("limit") ||
            testStatus.includes("quota") ||
            lastError.includes("rate limit") ||
            lastError.includes("429") ||
            lastError.includes("quota") ||
            lastError.includes("too many requests") ||
            lastError.includes("exhausted");

          const isBad =
            !isRateLimited &&
            (testStatus.includes("fail") ||
              testStatus.includes("invalid") ||
              testStatus.includes("error") ||
              testStatus.includes("expired") ||
              Boolean(c.lastError));

          let status = "active";
          if (!isActive) status = "inactive";
          else if (isRateLimited) status = "rate_limited";
          else if (isBad) status = "error";

          const catalogEntry = CATALOG.find((p) => p.id === c.provider);

          return {
            id: c.id,
            provider: c.provider,
            name: c.name || c.displayName || catalogEntry?.name || c.provider,
            status,
            isActive,
            freeTier: catalogEntry?.free || "Free tier",
            testStatus: c.testStatus || c.test_status || "active",
            lastError: c.lastError || c.last_error || "",
          };
        });
      } catch (e) {
        errorMsg = e.message;
      }
    }

    const activeCount = providers.filter((p) => p.status === "active").length;
    const rateLimitedCount = providers.filter((p) => p.status === "rate_limited").length;
    const errorCount = providers.filter((p) => p.status === "error").length;
    const inactiveCount = providers.filter((p) => p.status === "inactive").length;

    return {
      running: isRunning,
      error: errorMsg,
      total: providers.length,
      counts: {
        active: activeCount,
        rateLimited: rateLimitedCount,
        error: errorCount,
        inactive: inactiveCount,
      },
      providers,
    };
  },
  "GET /api/engines/status": async () => checkEngines(),
  "GET /api/engines/install/stream": async ({ req, res }) => handleInstallStream({ req, res }),
  "POST /api/engines/install": async ({ req, res }) => handleInstallStream({ req, res }),
  "POST /api/open": async ({ body }) => {
    const target =
      body.target === "omniroute"
        ? `http://localhost:${config.omniroute.port}/dashboard`
        : body.target === "headroom"
          ? `http://localhost:${config.headroom.port}/dashboard`
          : "";
    if (!target) throw httpError(400, "Unknown target");
    openBrowser(target);
    return { opened: target };
  },
  "POST /api/headroom/mode": async ({ body }) => {
    const valid = ["cache", "token"];
    if (!valid.includes(body.mode)) throw httpError(400, "Invalid mode: must be cache or token");
    config.headroom.mode = body.mode;
    saveConfig();
    let reloaded = false;
    if (await portOpen(config.headroom.port)) {
      log("routedeck", `Reloading Headroom in mode: ${body.mode}`);
      await stopService("headroom");
      await startHeadroom();
      reloaded = true;
    }
    return { mode: config.headroom.mode, reloaded };
  },
  "POST /api/model/switch": async ({ body }) => {
    if (typeof body.model !== "string") throw httpError(400, "Model required");
    config.claude.model = body.model.trim();
    saveConfig();
    log("routedeck", `Default routing model updated to: ${config.claude.model || "auto"}`);
    return { model: config.claude.model };
  },
};

function openBrowser(url) {
  const [cmd, args] = IS_WIN
    ? ["cmd.exe", ["/c", "start", "", url]]
    : process.platform === "darwin"
      ? ["open", [url]]
      : ["xdg-open", [url]];
  spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  // Only answer this machine. Blocks other sites from driving the API (DNS rebinding / CSRF).
  const host = (req.headers.host || "").split(":")[0];
  if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  if (req.method !== "GET" && req.headers.origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.origin)) {
    res.writeHead(403).end("Forbidden origin");
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) {
      res.writeHead(404, { "content-type": "application/json" }).end('{"error":"Not found"}');
      return;
    }
    try {
      const body = req.method === "GET" ? {} : await readBody(req);
      const result = await handler({ body, url, req, res });
      if (res.writableEnded) return;
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(result ?? {}));
    } catch (e) {
      if (res.writableEnded) return;
      const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 500;
      if (status >= 500) log("routedeck", `✖ ${req.method} ${url.pathname}: ${e.message}`);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: e.name === "AbortError" ? "Timed out" : e.message }));
    }
    return;
  }

  const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const file = path.join(UI_DIR, path.normalize(rel));
  if (!file.startsWith(UI_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end("Not found");
    return;
  }
  res.writeHead(200, {
    "content-type": MIME[path.extname(file)] || "application/octet-stream",
    "cache-control": "no-store",
  });
  fs.createReadStream(file).pipe(res);
});

// ---------------------------------------------------------------- boot

const background = process.argv.includes("--background");

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.log(`RouteDeck is already running at http://localhost:${APP_PORT}`);
    if (!background && !config.app.silentBackground) openBrowser(`http://localhost:${APP_PORT}`);
    process.exit(0);
  }
  throw e;
});

server.listen(APP_PORT, "127.0.0.1", async () => {
  const url = `http://localhost:${APP_PORT}`;
  console.log(`\n  RouteDeck is running at ${url}\n  Keep this window open. Close it to quit RouteDeck.\n`);
  log("routedeck", `RouteDeck started at ${url}`);
  sampleHistory();
  setInterval(sampleHistory, 5 * 60 * 1000).unref();
  refreshPonytail();
  const isSilent = background || config.app.silentBackground;
  if (config.app.startServicesOnLaunch || background) {
    routes["POST /api/start"]({ body: { service: "all" } }).catch((e) =>
      log("routedeck", `✖ auto-start: ${e.message}`)
    );
  }
  if (config.app.openBrowser && !isSilent && !process.argv.includes("--no-browser")) {
    openBrowser(url);
  }
});

async function shutdown() {
  // Services RouteDeck started stop with it; ones you started yourself keep running.
  for (const name of Object.keys(children)) {
    if (children[name]?.pid) await killTree(children[name].pid);
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
