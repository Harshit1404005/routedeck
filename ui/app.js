// RouteDeck UI. Talks only to the local RouteDeck server (/api/*).
import { columnChart, barList, lineChart, tableView, fmt } from "./charts.js?v=4";

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
  if (view === "claude") { refreshClaudeCommand(); loadPonytail(); }
  if (view === "analytics") loadAnalytics();
  if (view === "home") loadHomeActivity();
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

// ---------------------------------------------------------------- ponytail

async function loadPonytail(refresh) {
  const pill = $("#pt-pill"), btn = $("#pt-install");
  try {
    const p = await api(`/api/ponytail${refresh ? "?refresh=1" : ""}`);
    $("#pt-mode").value = p.mode || "full";
    if (!p.claudeFound) {
      pill.className = "pill"; pill.textContent = "needs Claude Code";
      btn.disabled = true;
    } else if (p.installed) {
      pill.className = "pill ok"; pill.textContent = `installed${p.version ? " v" + p.version : ""}`;
      btn.textContent = "Remove"; btn.className = "btn small"; btn.disabled = false;
    } else {
      pill.className = "pill"; pill.textContent = "not installed";
      btn.textContent = "Install"; btn.className = "btn small primary"; btn.disabled = false;
    }
    btn.dataset.installed = p.installed ? "1" : "";
  } catch (e) {
    pill.textContent = "unknown";
  }
}

$("#pt-install").addEventListener("click", (e) => {
  const btn = e.currentTarget;
  const removing = btn.dataset.installed === "1";
  if (removing && !confirm("Remove the Ponytail plugin from Claude Code?")) return;
  withBusy(btn, async () => {
    btn.textContent = removing ? "Removing…" : "Installing…";
    await api(removing ? "/api/ponytail/uninstall" : "/api/ponytail/install", {});
    toast(removing ? "Ponytail removed" : "Ponytail installed. It's active in new Claude Code sessions.", "ok");
    await loadPonytail(true);
    refreshClaudeCommand();
  }).finally(() => loadPonytail());
});
$("#pt-mode").addEventListener("change", (e) =>
  saveConfig({ claude: { ponytailMode: e.target.value } }, true).then(refreshClaudeCommand)
);

// ---------------------------------------------------------------- analytics

let analyticsRange = "7d";
let lastAnalytics = null;

$("#range-chips").addEventListener("click", (e) => {
  const c = e.target.closest("[data-range]");
  if (!c) return;
  analyticsRange = c.dataset.range;
  $$("#range-chips .chip").forEach((x) => x.classList.toggle("active", x === c));
  loadAnalytics();
});

// Table toggle on every chart card.
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-table-toggle]");
  if (!b) return;
  const card = b.closest("[data-chart]");
  card.classList.toggle("as-table");
  b.textContent = card.classList.contains("as-table") ? "Chart" : "Table";
  renderAnalytics();
});

function shortDate(s) {
  const d = new Date(s + (String(s).length === 10 ? "T00:00:00" : ""));
  return isNaN(d) ? String(s) : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

async function loadAnalytics() {
  try {
    const [a, hist] = await Promise.all([
      api(`/api/analytics?range=${analyticsRange}`),
      api(`/api/history?hours=168`),
    ]);
    lastAnalytics = { a, hist };
  } catch (e) {
    toast(e.message, "bad");
    return;
  }
  renderAnalytics();
}

function asTable(id) {
  return $("#" + id).closest("[data-chart]")?.classList.contains("as-table");
}

function renderAnalytics() {
  if (!lastAnalytics) return;
  const { a, hist } = lastAnalytics;
  const o = a.omniroute, h = a.headroom, s = o?.summary || {};

  const notice = $("#an-notice");
  if (a.omnirouteError) {
    notice.hidden = false;
    notice.innerHTML = `<b>OmniRoute charts need a connection.</b> <span class="muted">${esc(a.omnirouteError)}</span> Connect in <a href="#" data-goto="settings">Settings</a>. Headroom charts still work.`;
  } else notice.hidden = true;

  $("#k-req").textContent = o ? fmt(s.totalRequests) : "–";
  $("#k-tok").textContent = o ? fmt(s.totalTokens) : "–";
  $("#k-tok-foot").textContent = o ? `${fmt(s.promptTokens)} in · ${fmt(s.completionTokens)} out` : "";
  $("#k-ok").textContent = o && s.totalRequests ? `${Number(s.successRatePct).toFixed(1)}%` : "–";
  $("#k-ok-foot").textContent = o ? `${fmt(s.successfulRequests)} of ${fmt(s.totalRequests)} succeeded` : "";
  $("#k-lat").textContent = o && s.avgLatencyMs ? (s.avgLatencyMs >= 1000 ? `${(s.avgLatencyMs / 1000).toFixed(1)}s` : `${s.avgLatencyMs}ms`) : "–";
  $("#k-fb").textContent = o ? `${fmt(s.fallbackCount || 0)} fallbacks to another provider` : "";
  $("#k-saved").textContent = h ? fmt(h.tokensSaved) : "–";
  $("#k-saved-foot").textContent = h ? `${h.avgPct ? h.avgPct.toFixed(1) + "% avg" : "no compression yet"} · since Headroom started` : "Headroom is not running";
  $("#k-prov").textContent = o ? String(o.byProvider.length) : "–";
  $("#k-models").textContent = o ? `${s.uniqueModels || o.byModel.length} models` : "";

  // Requests per day
  const days = (o?.dailyTrend || []).map((d) => ({ label: shortDate(d.date), full: d.date, values: d }));
  if (asTable("c-req")) tableView($("#c-req"), ["Day", "Requests"], days.map((d) => [d.full, d.values.requests]));
  else columnChart($("#c-req"), days, { series: [{ key: "requests", label: "Requests" }], emptyText: o ? "No requests in this range yet." : "Connect to OmniRoute to see this." });

  // Tokens per day (stacked input / output)
  if (asTable("c-tok")) tableView($("#c-tok"), ["Day", "Input tokens", "Output tokens"], days.map((d) => [d.full, d.values.promptTokens, d.values.completionTokens]));
  else columnChart($("#c-tok"), days, { series: [{ key: "promptTokens", label: "Input" }, { key: "completionTokens", label: "Output" }], emptyText: o ? "No tokens in this range yet." : "Connect to OmniRoute to see this." });

  // By provider / model
  const prov = (o?.byProvider || []).map((p) => ({ label: p.name, value: p.requests, sub: `${fmt(p.tokens)} tokens${p.successRatePct != null ? ` · ${Number(p.successRatePct).toFixed(0)}% success` : ""}` }));
  if (asTable("c-prov")) tableView($("#c-prov"), ["Provider", "Requests", "Tokens"], (o?.byProvider || []).map((p) => [p.name, p.requests, p.tokens]));
  else barList($("#c-prov"), prov, { unit: "requests", emptyText: o ? "No traffic yet." : "Connect to OmniRoute to see this." });

  const models = (o?.byModel || []).map((m) => ({ label: m.name, value: m.requests, sub: `${m.provider ? m.provider + " · " : ""}${fmt(m.tokens)} tokens${m.avgLatencyMs ? ` · ${m.avgLatencyMs}ms avg` : ""}` }));
  if (asTable("c-model")) tableView($("#c-model"), ["Model", "Requests", "Tokens"], (o?.byModel || []).map((m) => [m.name, m.requests, m.tokens]));
  else barList($("#c-model"), models, { unit: "requests", emptyText: o ? "No traffic yet." : "Connect to OmniRoute to see this." });

  // Headroom layers
  const layers = h ? Object.entries(h.layers).map(([label, value]) => ({ label, value })).filter((x) => x.value > 0) : [];
  if (asTable("c-layers")) tableView($("#c-layers"), ["Method", "Tokens saved"], layers.map((l) => [l.label, l.value]));
  else barList($("#c-layers"), layers.sort((x, y) => y.value - x.value), { unit: "tokens saved", emptyText: h ? "Nothing saved yet. Savings show up once longer prompts, logs or tool output go through Headroom." : "Headroom is not running." });

  // Errors
  const errs = (o?.errors || []).filter((e) => e.count > 0);
  $("#c-errors").innerHTML = !o
    ? `<div class="viz-empty">Connect to OmniRoute to see this.</div>`
    : errs.length
      ? `<div class="err-list">${errs.map((e) => `<div class="err-row"><span>⚠ ${esc(e.type || "unknown")}</span><b>${fmt(e.count)}</b></div>`).join("")}</div>`
      : `<div class="ok-big">✓ <span>No errors in this range.</span></div>`;

  // History line: tokens per 5-minute interval through Headroom
  const iv = intervals(hist || []);
  if (asTable("c-history")) tableView($("#c-history"), ["Time", "Input tokens", "Tokens saved", "Requests"], iv.slice(-200).reverse().map((p) => [new Date(p.t).toLocaleString(), p.tokensIn, p.tokensSaved, p.requests]));
  else lineChart($("#c-history"), iv.map((p) => ({ t: p.t, v: p.tokensIn })), { label: "Input tokens", emptyText: "Collecting… RouteDeck records a point every 5 minutes while Headroom runs." });
}

// Samples are running totals; turn them into per-interval amounts. A drop means Headroom restarted.
function intervals(hist) {
  const out = [];
  for (let i = 1; i < hist.length; i++) {
    const a = hist[i - 1], b = hist[i];
    const d = (k) => (b[k] >= a[k] ? b[k] - a[k] : b[k]);
    out.push({ t: b.t, tokensIn: d("tokensIn"), tokensSaved: d("tokensSaved"), requests: d("requests") });
  }
  return out;
}

async function loadHomeActivity() {
  try {
    const hist = await api("/api/history?hours=24");
    lineChart($("#home-activity"), intervals(hist).map((p) => ({ t: p.t, v: p.tokensIn })), {
      height: 160,
      label: "Input tokens in 5 min",
      emptyText: "Collecting… a point is recorded every 5 minutes while Headroom runs.",
    });
  } catch {}
}

let resizeTimer;
addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if ($("#view-analytics").classList.contains("active")) renderAnalytics();
    if ($("#view-home").classList.contains("active")) loadHomeActivity();
  }, 200);
});

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
