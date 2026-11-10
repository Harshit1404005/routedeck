// Tiny dependency-free SVG charts: vertical bars (optionally stacked), horizontal bars,
// and a line/area chart. Every chart gets a hover tooltip and a table view.

const NS = "http://www.w3.org/2000/svg";

function el(tag, attrs = {}, parent) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.append(n);
  return n;
}

export function fmt(n) {
  n = Number(n) || 0;
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
  if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (a >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return String(Math.round(n * 10) / 10);
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

// Rect with only the top corners rounded (data end), anchored on the baseline.
function topRoundedBar(x, y, w, h, r = 4) {
  if (h <= 0) return "";
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}
function rightRoundedBar(x, y, w, h, r = 4) {
  if (w <= 0) return "";
  r = Math.min(r, h / 2, w);
  return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
}

function tooltip(host) {
  let tip = host.querySelector(".viz-tip");
  if (!tip) {
    tip = document.createElement("div");
    tip.className = "viz-tip";
    tip.hidden = true;
    host.append(tip);
  }
  return {
    show(html, clientX, clientY) {
      tip.innerHTML = html;
      tip.hidden = false;
      const box = host.getBoundingClientRect();
      let x = clientX - box.left + 12;
      const y = clientY - box.top - 10;
      if (x + tip.offsetWidth > box.width) x = clientX - box.left - tip.offsetWidth - 12;
      tip.style.transform = `translate(${Math.max(0, x)}px, ${Math.max(0, y - tip.offsetHeight)}px)`;
    },
    hide() {
      tip.hidden = true;
    },
  };
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function prepare(host, data, emptyText) {
  host.classList.add("viz");
  host.replaceChildren(); // clears a previous chart, table view, legend or empty state
  if (!data.length) {
    const e = document.createElement("div");
    e.className = "viz-empty";
    e.textContent = emptyText || "No data yet.";
    host.append(e);
    return null;
  }
  return host.clientWidth || 600;
}

function legend(host, series) {
  if (series.length < 2) return;
  const lg = document.createElement("div");
  lg.className = "viz-legend";
  lg.innerHTML = series
    .map((s, i) => `<span><i style="background:var(--series-${i + 1})"></i>${esc(s.label)}</span>`)
    .join("");
  host.prepend(lg);
}

/**
 * Vertical bars over a category axis (e.g. days). `series` with 2+ entries are stacked.
 * data: [{ label, values: { key: number } }], series: [{ key, label }]
 */
export function columnChart(host, data, { series, height = 220, emptyText, valueFmt = fmt } = {}) {
  const W = prepare(host, data, emptyText);
  if (!W) return;
  legend(host, series);
  const H = height, m = { t: 12, r: 8, b: 26, l: 40 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const totals = data.map((d) => series.reduce((s, k) => s + (Number(d.values[k.key]) || 0), 0));
  const max = niceMax(Math.max(...totals));
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img" });
  host.append(svg);

  for (let i = 0; i <= 4; i++) {
    const y = m.t + ih - (ih * i) / 4;
    el("line", { x1: m.l, x2: W - m.r, y1: y, y2: y, class: i ? "viz-grid" : "viz-axis" }, svg);
    el("text", { x: m.l - 6, y: y + 4, class: "viz-tick", "text-anchor": "end" }, svg).textContent = valueFmt((max * i) / 4);
  }

  const step = iw / data.length;
  const bw = Math.max(3, Math.min(36, step * 0.62));
  const labelEvery = Math.ceil(data.length / Math.max(1, Math.floor(iw / 56)));
  const tip = tooltip(host);

  data.forEach((d, i) => {
    const cx = m.l + step * i + step / 2;
    let acc = 0;
    series.forEach((s, si) => {
      const v = Number(d.values[s.key]) || 0;
      const h = (v / max) * ih;
      const y = m.t + ih - acc - h;
      const isTop = si === series.length - 1 || series.slice(si + 1).every((n) => !(Number(d.values[n.key]) > 0));
      // 2px surface gap between stacked segments
      const gap = acc > 0 ? 2 : 0;
      if (h - gap > 0) {
        el("path", {
          d: isTop ? topRoundedBar(cx - bw / 2, y, bw, h - gap) : `M${cx - bw / 2},${y}h${bw}v${h - gap}h${-bw}Z`,
          class: "viz-bar",
          fill: `var(--series-${si + 1})`,
        }, svg);
      }
      acc += h;
    });
    if (i % labelEvery === 0) {
      el("text", { x: cx, y: H - 8, class: "viz-tick", "text-anchor": "middle" }, svg).textContent = d.label;
    }
    const hit = el("rect", { x: cx - step / 2, y: m.t, width: step, height: ih, class: "viz-hit" }, svg);
    const rows = series.map((s, si) => `<div><i style="background:var(--series-${si + 1})"></i>${esc(s.label)} <b>${valueFmt(d.values[s.key] || 0)}</b></div>`).join("");
    hit.addEventListener("pointermove", (e) => tip.show(`<div class="viz-tip-head">${esc(d.full || d.label)}</div>${rows}`, e.clientX, e.clientY));
    hit.addEventListener("pointerleave", () => tip.hide());
  });
}

/** Horizontal ranked bars. data: [{ label, value, sub? }] */
export function barList(host, data, { emptyText, valueFmt = fmt, unit = "" } = {}) {
  const W = prepare(host, data, emptyText);
  if (!W) return;
  const rowH = 30, labelW = Math.min(180, W * 0.38), valW = 64;
  const H = data.length * rowH + 4;
  const iw = W - labelW - valW - 8;
  const max = Math.max(...data.map((d) => d.value), 1);
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img" });
  host.append(svg);
  const tip = tooltip(host);
  data.forEach((d, i) => {
    const y = i * rowH + 4;
    const t = el("text", { x: 0, y: y + 15, class: "viz-label" }, svg);
    t.textContent = d.label.length > 26 ? d.label.slice(0, 25) + "…" : d.label;
    el("rect", { x: labelW, y: y + 4, width: iw, height: 14, rx: 4, class: "viz-track" }, svg);
    el("path", { d: rightRoundedBar(labelW, y + 4, Math.max(2, (d.value / max) * iw), 14), class: "viz-bar", fill: "var(--series-1)" }, svg);
    el("text", { x: W, y: y + 15, class: "viz-value", "text-anchor": "end" }, svg).textContent = valueFmt(d.value);
    const hit = el("rect", { x: 0, y, width: W, height: rowH, class: "viz-hit" }, svg);
    hit.addEventListener("pointermove", (e) =>
      tip.show(`<div class="viz-tip-head">${esc(d.label)}</div><div><b>${valueFmt(d.value)}</b> ${esc(unit)}</div>${d.sub ? `<div class="viz-tip-sub">${esc(d.sub)}</div>` : ""}`, e.clientX, e.clientY)
    );
    hit.addEventListener("pointerleave", () => tip.hide());
  });
}

/** Line + soft area over time. points: [{ t: ms, v: number }] */
export function lineChart(host, points, { height = 200, emptyText, valueFmt = fmt, label = "" } = {}) {
  const W = prepare(host, points.length > 1 ? points : [], emptyText);
  if (!W) return;
  const H = height, m = { t: 12, r: 10, b: 26, l: 40 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const t0 = points[0].t, t1 = points.at(-1).t || t0 + 1;
  const max = niceMax(Math.max(...points.map((p) => p.v)));
  const x = (t) => m.l + ((t - t0) / Math.max(1, t1 - t0)) * iw;
  const y = (v) => m.t + ih - (v / max) * ih;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img" });
  host.append(svg);
  for (let i = 0; i <= 4; i++) {
    const yy = m.t + ih - (ih * i) / 4;
    el("line", { x1: m.l, x2: W - m.r, y1: yy, y2: yy, class: i ? "viz-grid" : "viz-axis" }, svg);
    el("text", { x: m.l - 6, y: yy + 4, class: "viz-tick", "text-anchor": "end" }, svg).textContent = valueFmt((max * i) / 4);
  }
  const spanH = (t1 - t0) / 3600e3;
  const tfmt = (t) => {
    const d = new Date(t);
    return spanH > 36 ? d.toLocaleDateString([], { month: "short", day: "numeric" }) : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };
  for (let i = 0; i <= 4; i++) {
    const t = t0 + ((t1 - t0) * i) / 4;
    el("text", { x: x(t), y: H - 8, class: "viz-tick", "text-anchor": i === 0 ? "start" : i === 4 ? "end" : "middle" }, svg).textContent = tfmt(t);
  }
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  el("path", { d: `${line}L${x(t1)},${m.t + ih}L${x(t0)},${m.t + ih}Z`, class: "viz-area" }, svg);
  el("path", { d: line, class: "viz-line" }, svg);
  const cross = el("line", { y1: m.t, y2: m.t + ih, class: "viz-cross", visibility: "hidden" }, svg);
  const dot = el("circle", { r: 4.5, class: "viz-dot", visibility: "hidden" }, svg);
  const hit = el("rect", { x: m.l, y: m.t, width: iw, height: ih, class: "viz-hit" }, svg);
  const tip = tooltip(host);
  hit.addEventListener("pointermove", (e) => {
    const box = svg.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    let best = points[0];
    for (const p of points) if (Math.abs(x(p.t) - px) < Math.abs(x(best.t) - px)) best = p;
    cross.setAttribute("x1", x(best.t));
    cross.setAttribute("x2", x(best.t));
    cross.setAttribute("visibility", "visible");
    dot.setAttribute("cx", x(best.t));
    dot.setAttribute("cy", y(best.v));
    dot.setAttribute("visibility", "visible");
    tip.show(`<div class="viz-tip-head">${esc(new Date(best.t).toLocaleString())}</div><div>${esc(label)} <b>${valueFmt(best.v)}</b></div>`, e.clientX, e.clientY);
  });
  hit.addEventListener("pointerleave", () => {
    cross.setAttribute("visibility", "hidden");
    dot.setAttribute("visibility", "hidden");
    tip.hide();
  });
}

/** Render rows as an HTML table (the accessible alternative to every chart). */
export function tableView(host, headers, rows) {
  host.innerHTML = rows.length
    ? `<table class="viz-table"><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows
        .map((r) => `<tr>${r.map((c, i) => `<td${i ? ' class="num"' : ""}>${esc(c)}</td>`).join("")}</tr>`)
        .join("")}</tbody></table>`
    : `<div class="viz-empty">No data yet.</div>`;
}
