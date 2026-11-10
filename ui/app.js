// RouteDeck UI. Talks only to the local RouteDeck server (/api/*).

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  status: null,
  config: null,
  catalog: [],
  providers: [],
  providersError: "",
  filter: "all",
  logService: "headroom",
  logSince: 0,
  busy: false,
};

// ---------------------------------------------------------------- utils

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function toast(msg, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), kind === "bad" ? 7000 : 3500);
}

function fmtNum(n) {
  if (!n) return "0";
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(Math.round(n));
}

const COLORS = ["#6d4aff", "#0fb5d4", "#f97316", "#12b76a", "#e11d48", "#2563eb", "#a855f7", "#ca8a04", "#0d9488"];
function colorFor(id) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}
function initials(name) {
  return String(name).replace(/[^A-Za-z0-9 ]/g, " ").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
}

function getPath(obj, key) {
  return key.split(".").reduce((o, k) => o?.[k], obj);
}
function setPath(obj, key, value) {
  const parts = key.split(".");
  let o = obj;
  for (const p of parts.slice(0, -1)) o = o[p] ??= {};
  o[parts.at(-1)] = value;
}

async function withBusy(btn, fn) {
  if (btn) btn.disabled = true;
  try {
    return await fn();
  } catch (e) {
    toast(e.message, "bad");
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---------------------------------------------------------------- navigation

function show(view) {
  $$("#nav button").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
  if (view === "providers") loadProviders();
  if (view === "claude") refreshClaudeCommand();
  if (view === "logs") { state.logSince = 0; $("#logbox").textContent = ""; pollLogs(); }
  try { localStorage.setItem("rd-view", view); } catch {}
}

$("#nav").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-view]");
  if (b) show(b.dataset.view);
});
document.addEventListener("click", (e) => {
  const a = e.target.closest("[data-goto]");
  if (a) { e.preventDefault(); show(a.dataset.goto); }
  const c = e.target.closest("[data-copy]");
  if (c) {
    const text = $("#" + c.dataset.copy).textContent;
    navigator.clipboard.writeText(text).then(() => toast("Copied", "ok"));
  }
});

// theme
function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
try { applyTheme(localStorage.getItem("rd-theme")); } catch {}
$("#theme-toggle").addEventListener("click", () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === "dark"
    : matchMedia("(prefers-color-scheme: dark)").matches;
  const next = dark ? "light" : "dark";
  applyTheme(next);
  try { localStorage.setItem("rd-theme", next); } catch {}
});

// ---------------------------------------------------------------- status / home

async function refreshStatus() {
  try {
    state.status = await api("/api/status");
  } catch {
    return;
  }
  renderStatus();
}

function renderStatus() {
  const s = state.status;
  if (!s) return;
  const label = { running: "running", starting: "starting…", stopped: "stopped", off: "turned off" };
  for (const name of ["headroom", "omniroute"]) {
    const node = $(`#node-${name}`);
    node.className = `node ${s[name].state}`;
    $(".node-state", node).textContent = label[s[name].state] || s[name].state;
  }
  const h = s.headroom.state, o = s.omniroute.state;
  const providersOn = state.providers.filter((p) => p.isActive).length;
  $("#node-client").className = "node" + (h === "running" || o === "running" ? " running" : "");
  $("#node-providers").className = "node" + (providersOn && o === "running" ? " running" : "");
  $("#link-1").classList.toggle("live", h === "running" || (h === "off" && o === "running"));
  $("#link-2").classList.toggle("live", h === "running" && o === "running");
  $("#link-3").classList.toggle("live", o === "running" && providersOn > 0);

  const anyRunning = [h, o].includes("running") || [h, o].includes("starting");
  const btn = $("#power-btn");
  if (!state.busy) {
    btn.classList.toggle("on", anyRunning);
    $("#power-label").textContent = anyRunning ? "Stop everything" : "Start everything";
  }

  // getting-started checklist
  const allUp = [h, o].every((x) => x === "running" || x === "off");
  setStep("engines", allUp && (h === "running" || o === "running"));
  setStep("login", s.omniroute.loggedIn || state.providers.length > 0);
  setStep("provider", state.providers.length > 0);
  setStep("claude", localStorage.getItem("rd-launched") === "1");

  const hPort = s.headroom.port, oPort = s.omniroute.port;
  const front = h !== "off" ? hPort : oPort;
  $("#ep-anthropic").textContent = `http://localhost:${front}`;
  $("#ep-openai").textContent = `http://localhost:${front}/v1`;
}

function setStep(name, done) {
  $(`#steps li[data-step="${name}"]`)?.classList.toggle("done", Boolean(done));
}

async function refreshSavings() {
  try {
    const v = await api("/api/savings");
    if (!v.running) {
      for (const id of ["s-saved", "s-req", "s-avg", "s-usd"]) $("#" + id).textContent = "–";
      $("#s-best").textContent = "Headroom is not running";
      return;
    }
    $("#s-saved").textContent = fmtNum(v.tokensSaved);
    $("#s-req").textContent = fmtNum(v.requests);
    $("#s-avg").textContent = v.avgPct ? `${v.avgPct.toFixed(1)}%` : "0%";
    $("#s-best").textContent = v.bestPct ? `best: ${v.bestPct.toFixed(1)}%` : "no compression yet";
    $("#s-usd").textContent = `$${(v.usdSaved || 0).toFixed(2)}`;
  } catch {}
}

$("#power-btn").addEventListener("click", async () => {
  if (state.busy) return;
  const s = state.status;
  const running = s && ["running", "starting"].some((x) => [s.headroom.state, s.omniroute.state].includes(x));
  const btn = $("#power-btn");
  state.busy = true;
  btn.classList.add("busy");
  $("#power-label").textContent = running ? "Stopping…" : "Starting…";
  try {
    const out = await api(running ? "/api/stop" : "/api/start", { service: "all" });
    if (!running) {
      const notes = Object.entries(out).map(([k, v]) => v.alreadyRunning ? `${k} was already running` : v.skipped ? `${k} is turned off` : `${k} starting`);
      toast(notes.join(" · "), "ok");
    } else {
      toast("Everything stopped", "ok");
    }
  } catch (e) {
    toast(e.message, "bad");
  } finally {
    state.busy = false;
    btn.classList.remove("busy");
    refreshStatus();
  }
});

$("#qa-claude").addEventListener("click", () => show("claude"));
$("#qa-omni").addEventListener("click", () => api("/api/open", { target: "omniroute" }).catch((e) => toast(e.message, "bad")));
$("#qa-head").addEventListener("click", () => api("/api/open", { target: "headroom" }).catch((e) => toast(e.message, "bad")));
$("#prov-open-omni").addEventListener("click", (e) => { e.preventDefault(); api("/api/open", { target: "omniroute" }); });

// ---------------------------------------------------------------- providers

async function loadProviders() {
  if (!state.catalog.length) state.catalog = await api("/api/catalog").catch(() => []);
  try {
    state.providers = await api("/api/providers");
    state.providersError = "";
  } catch (e) {
    state.providers = [];
    state.providersError = e.message;
  }
  renderProviders();
  renderStatus();
}

function renderProviders() {
  const notice = $("#prov-notice");
  const st = state.status;
  if (st && st.omniroute.state !== "running") {
    notice.hidden = false;
    notice.innerHTML = `<b>OmniRoute isn't running.</b> Start it from <a href="#" data-goto="home">Home</a> to manage providers.`;
  } else if (state.providersError) {
    notice.hidden = false;
    notice.innerHTML = `<b>Connect to OmniRoute.</b> <span class="muted">${esc(state.providersError)}</span>
      <div class="row"><input type="password" id="inline-pw" placeholder="OmniRoute dashboard password" /><button class="btn small primary" id="inline-login">Connect</button></div>
      <div class="muted small" style="margin-top:6px">First time? The default password is <code>CHANGEME</code>. Change it in the OmniRoute dashboard afterwards.</div>`;
    $("#inline-login").addEventListener("click", (e) => doLogin($("#inline-pw").value, e.target));
    $("#inline-pw").addEventListener("keydown", (e) => e.key === "Enter" && doLogin(e.target.value, $("#inline-login")));
  } else {
    notice.hidden = true;
  }

  const list = $("#connected-list");
  $("#nav-prov-count").textContent = state.providers.length || "";
  const active = state.providers.filter((p) => p.isActive).length;
  $("#prov-summary").textContent = state.providers.length ? `${active} active` : "none yet";
  if (!state.providers.length) {
    list.innerHTML = `<div class="empty muted">${state.providersError ? "Connect to OmniRoute to see your providers." : "Nothing connected yet. Pick one below."}</div>`;
  } else {
    list.innerHTML = state.providers.map((p) => {
      const ok = /active|ok|success/i.test(p.testStatus);
      const bad = /error|fail|invalid|expired|banned/i.test(p.testStatus);
      return `<div class="conn" data-id="${esc(p.id)}">
        <div class="avatar" style="background:${colorFor(p.provider)}">${esc(initials(p.provider))}</div>
        <div class="meta"><b>${esc(p.name)}</b><span>${esc(p.provider)}${p.apiKey ? " · " + esc(p.apiKey) : ""}</span></div>
        <span class="pill ${ok ? "ok" : bad ? "bad" : ""}">${esc(p.testStatus || "untested")}</span>
        <button class="btn small" data-act="test">Test</button>
        <input type="checkbox" class="switch" data-act="toggle" ${p.isActive ? "checked" : ""} title="On / off" />
        <button class="icon-btn" data-act="delete" title="Remove">✕</button>
      </div>`;
    }).join("");
  }

  const connectedIds = new Set(state.providers.map((p) => p.provider));
  const items = state.catalog.filter((p) => state.filter === "all" || p.tags.includes(state.filter));
  $("#catalog").innerHTML = items.map((p) => {
    const has = connectedIds.has(p.id);
    const tag = p.tags.includes("recommended") ? `<span class="tag">Top pick</span>` : p.keyless ? `<span class="tag">No key</span>` : "";
    return `<div class="card pcard ${has ? "connected" : ""}" data-pid="${esc(p.id)}">
      <div class="pcard-top">
        <div class="avatar" style="background:${colorFor(p.id)}">${esc(initials(p.name))}</div>
        <div><b>${esc(p.name)}</b><div class="free">${esc(p.free)}</div></div>${tag}
      </div>
      <p>${esc(p.blurb)}</p>
      ${p.note ? `<div class="note">${esc(p.note)}</div>` : ""}
      ${p.keyless
        ? `<div class="row"><button class="btn small primary" data-act="add">${has ? "Add another" : "Connect, no key needed"}</button></div>`
        : `<a class="small" href="${esc(p.keyUrl)}" target="_blank" rel="noopener noreferrer">Get a free key ↗</a>
           <div class="row"><input type="password" placeholder="Paste API key" autocomplete="off" /><button class="btn small primary" data-act="add">${has ? "Add" : "Connect"}</button></div>`}
    </div>`;
  }).join("");
}

async function doLogin(password, btn) {
  await withBusy(btn, async () => {
    await api("/api/omniroute/login", { password, remember: true });
    toast("Connected to OmniRoute", "ok");
    await loadConfig();
    await loadProviders();
  });
}

$("#filter-chips").addEventListener("click", (e) => {
  const c = e.target.closest("[data-filter]");
  if (!c) return;
  state.filter = c.dataset.filter;
  $$("#filter-chips .chip").forEach((x) => x.classList.toggle("active", x === c));
  renderProviders();
});

$("#catalog").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act=add]");
  if (!b) return;
  const card = b.closest("[data-pid]");
  const input = $("input", card);
  const apiKey = input?.value.trim() || "";
  if (input && !apiKey) { input.focus(); toast("Paste the API key first", "bad"); return; }
  await withBusy(b, async () => {
    await api("/api/providers", { provider: card.dataset.pid, apiKey });
    if (input) input.value = "";
    toast("Provider connected", "ok");
    await loadProviders();
  });
});
$("#catalog").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.matches("input")) $("[data-act=add]", e.target.closest("[data-pid]")).click();
});

$("#connected-list").addEventListener("click", async (e) => {
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const id = el.closest("[data-id]").dataset.id;
  const act = el.dataset.act;
  if (act === "test") {
    await withBusy(el, async () => {
      el.textContent = "Testing…";
      try {
        const r = await api("/api/providers/test", { id });
        toast(r?.valid === false ? `Test failed: ${r.error || "invalid"}` : "Test passed", r?.valid === false ? "bad" : "ok");
      } finally {
        el.textContent = "Test";
      }
      await loadProviders();
    });
  } else if (act === "toggle") {
    await withBusy(el, async () => {
      await api("/api/providers/toggle", { id, isActive: el.checked });
      toast(el.checked ? "Turned on" : "Turned off", "ok");
      await loadProviders();
    });
  } else if (act === "delete") {
    if (!confirm("Remove this provider from OmniRoute? You'll need to paste its key again to re-add it.")) return;
    await withBusy(el, async () => {
      await api("/api/providers/delete", { id });
      toast("Removed", "ok");
      await loadProviders();
    });
  }
});
$("#prov-refresh").addEventListener("click", (e) => withBusy(e.target, loadProviders));

// ---------------------------------------------------------------- settings

async function loadConfig() {
  state.config = await api("/api/config");
  const c = state.config;
  $$("[data-key]").forEach((el) => {
    const v = getPath(c, el.dataset.key);
    if (el.type === "checkbox") el.checked = Boolean(v);
    else el.value = v ?? "";
  });
  $(`#route-cards input[value="${c.claude.route}"]`).checked = true;
  $("#workdir").value = c.claude.workDir || "";
  $("#model-custom").value = c.claude.model || "";
  $("#pw-state").textContent = c.omniroute.hasPassword
    ? "Saved on this computer. Enter a new one to replace it."
    : "Lets RouteDeck manage your providers. Saved only on this computer.";
  $("#key-state").textContent = c.omniroute.hasApiKey
    ? "Saved. Enter a new one to replace it."
    : 'Optional. Only if you turned on "require API key" in OmniRoute.';
}

let saveTimer;
async function saveConfig(patch, quiet) {
  try {
    state.config = await api("/api/config", patch);
    if (!quiet) toast("Saved", "ok");
    refreshStatus();
  } catch (e) {
    toast(e.message, "bad");
  }
}

$$("[data-key]").forEach((el) => {
  el.addEventListener("change", () => {
    let v = el.type === "checkbox" ? el.checked : el.type === "number" ? Number(el.value) : el.value.trim();
    const patch = {};
    setPath(patch, el.dataset.key, v);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveConfig(patch), 150);
  });
});

$("#omni-login").addEventListener("click", (e) => doLogin($("#omni-password").value, e.target).then(() => ($("#omni-password").value = "")));
$("#omni-password").addEventListener("keydown", (e) => e.key === "Enter" && $("#omni-login").click());
$("#omni-apikey-save").addEventListener("click", async () => {
  const v = $("#omni-apikey").value.trim();
  if (!v) return toast("Paste the key first", "bad");
  await saveConfig({ omniroute: { apiKey: v } });
  $("#omni-apikey").value = "";
  loadConfig();
});
$$("[data-restart]").forEach((b) =>
  b.addEventListener("click", () =>
    withBusy(b, async () => {
      await api("/api/restart", { service: b.dataset.restart });
      toast(`Restarting ${b.dataset.restart}…`, "ok");
      refreshStatus();
    })
  )
);

// ---------------------------------------------------------------- claude

$("#route-cards").addEventListener("change", (e) => saveConfig({ claude: { route: e.target.value } }, true).then(refreshClaudeCommand));
$("#workdir").addEventListener("change", (e) => saveConfig({ claude: { workDir: e.target.value.trim() } }, true).then(refreshClaudeCommand));
$("#model-select").addEventListener("change", (e) => {
  $("#model-custom").value = e.target.value;
  saveConfig({ claude: { model: e.target.value } }, true).then(refreshClaudeCommand);
});
$("#model-custom").addEventListener("change", (e) => saveConfig({ claude: { model: e.target.value.trim() } }, true).then(refreshClaudeCommand));
$("#model-reload").addEventListener("click", (e) => withBusy(e.target, loadModels));

async function loadModels() {
  const models = await api("/api/models");
  const sel = $("#model-select");
  const current = state.config?.claude.model || "";
  sel.innerHTML = `<option value="">Default (Claude's own model names)</option>` +
    models.map((m) => `<option value="${esc(m)}" ${m === current ? "selected" : ""}>${esc(m)}</option>`).join("");
  toast(`${models.length} models available`, "ok");
}

async function refreshClaudeCommand() {
  try {
    const r = await api("/api/claude/command");
    $("#claude-cmd").textContent = r.command;
  } catch {}
}

$("#claude-launch").addEventListener("click", (e) =>
  withBusy(e.currentTarget, async () => {
    await api("/api/claude/launch", {});
    try { localStorage.setItem("rd-launched", "1"); } catch {}
    toast("Claude Code is opening in a new window", "ok");
    renderStatus();
  })
);

// ---------------------------------------------------------------- logs

$("#log-tabs").addEventListener("click", (e) => {
  const c = e.target.closest("[data-log]");
  if (!c) return;
  state.logService = c.dataset.log;
  state.logSince = 0;
  $("#logbox").textContent = "";
  $$("#log-tabs .chip").forEach((x) => x.classList.toggle("active", x === c));
  pollLogs();
});

async function pollLogs() {
  if (!$("#view-logs").classList.contains("active")) return;
  try {
    const { lines } = await api(`/api/logs?service=${state.logService}&since=${state.logSince}`);
    if (lines.length) {
      const box = $("#logbox");
      const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
      const frag = document.createDocumentFragment();
      for (const l of lines) {
        const ts = document.createElement("span");
        ts.className = "ts";
        ts.textContent = new Date(l.t).toLocaleTimeString() + "  ";
        frag.append(ts, l.line + "\n");
      }
      box.append(frag);
      state.logSince = lines.at(-1).t;
      if (atBottom) box.scrollTop = box.scrollHeight;
    } else if (!state.logSince) {
      $("#logbox").textContent = "No output yet.";
    }
  } catch {}
}

// ---------------------------------------------------------------- boot

(async function boot() {
  await Promise.all([loadConfig().catch(() => {}), refreshStatus()]);
  api("/api/detect").then((d) => {
    $("#det-headroom").textContent = d.headroom ? `Found: ${d.headroom}` : 'Not found. Install with: pip install "headroom-ai[proxy]"';
    $("#det-omniroute").textContent = d.omniroute ? `Using: ${d.omniroute}` : "Not found. Install with: npm install -g omniroute";
    if (d.platform !== "win32") $("#row-login").hidden = true;
  }).catch(() => {});
  if (state.status?.omniroute.state === "running") loadProviders();
  refreshSavings();
  let start = "home";
  try { start = localStorage.getItem("rd-view") || "home"; } catch {}
  show(start);
  setInterval(refreshStatus, 2500);
  setInterval(refreshSavings, 6000);
  setInterval(pollLogs, 1500);
  setInterval(() => state.status?.omniroute.state === "running" && !state.providersError && loadProviders(), 30000);
})();
