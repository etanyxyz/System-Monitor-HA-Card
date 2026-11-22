/*
 * Resource Monitor Card
 * =====================
 * A self-contained Home Assistant Lovelace plugin that polls the Resource
 * Monitor REST API (http://host:1010) and renders live host CPU, memory,
 * swap and Docker container statistics.
 *
 * - Zero dependencies: plain DOM + shadow DOM, no imports, no build step.
 * - Auth: when MONITOR_TOKEN is set on the monitor, put it in the card
 *   config ("token") and it is sent as a ?token= query parameter, the same
 *   scheme the standalone dashboard uses (works through reverse proxies
 *   that strip Authorization headers; CORS on the monitor allows it).
 * - Data: GET /api/system and GET /api/containers, polled at a
 *   configurable interval (default 5 s, min 2 s).
 *
 * Card config:
 *   type: resource-monitor-card
 *   url: http://192.168.1.50:1010   # required
 *   token: secret-token             # optional (MONITOR_TOKEN)
 *   interval: 5                     # optional, seconds (2-60)
 *   title: Host                     # optional display title
 *   max_containers: 12              # optional, rows shown (default 12)
 *
 * Install via the Marketplace/HACS (dashboard category, repo
 * etanyxyz/System-Monitor-HA-Card) or by downloading this file to config/www
 * and adding it under Settings > Dashboards > Resources.
 */
(() => {
  "use strict";

  if (customElements.get("resource-monitor-card")) return;

  // ---------------------------------------------------------------------------
  // constants
  // ---------------------------------------------------------------------------

  const CARD_TAG = "resource-monitor-card";
  const CONFIG_TAG = "resource-monitor-card-config";
  const DEFAULT_INTERVAL = 5;
  const MIN_INTERVAL = 2;
  const MAX_INTERVAL = 60;
  const DEFAULT_MAX_CONTAINERS = 12;

  // ---------------------------------------------------------------------------
  // formatting helpers (same conventions as the standalone dashboard)
  // ---------------------------------------------------------------------------

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[ch]));
  }

  function humanBytes(n) {
    if (n == null) return "—";
    const units = ["B", "KB", "MB", "GB", "TB", "PB"];
    let v = Number(n);
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
  }

  function humanDuration(sec) {
    if (sec == null) return "—";
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m ${sec % 60}s`;
    return `${sec}s`;
  }

  function usageColor(p) {
    if (p == null) return "var(--rm-muted)";
    if (p < 50) return "var(--rm-ok)";
    if (p < 80) return "var(--rm-warn)";
    return "var(--rm-bad)";
  }

  function trunc(s, n) {
    s = String(s ?? "");
    return s.length > n ? s.slice(0, n) + "…" : s;
  }

  function clampInterval(v) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return DEFAULT_INTERVAL;
    return Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, n));
  }

  function normalizeUrl(raw) {
    const u = String(raw ?? "").trim();
    if (!u) return null;
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(u) ? u : `http://${u}`;
    try {
      const parsed = new URL(withScheme);
      if (!parsed.host) return null;
      return parsed.toString().replace(/\/+$/, "");
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // card styles (dark GitHub palette, theme-aware with dark fallbacks)
  // ---------------------------------------------------------------------------

  const CARD_STYLE = /* css */ `
    :host {
      display: block;
      container-type: inline-size;
      --rm-bg: var(--card-background-color, var(--ha-card-background-color, #161b22));
      --rm-border: var(--divider-color, #30363d);
      --rm-text: var(--primary-text-color, var(--ha-primary-color, #e6edf3));
      --rm-muted: var(--secondary-text-color, #8b949e);
      --rm-accent: var(--accent-color, #58a6ff);
      --rm-ok: #3fb950;
      --rm-warn: #d29922;
      --rm-bad: #f85149;
      --rm-track: rgba(139, 148, 158, .15);
      color: var(--rm-text);
      font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }

    .card {
      background: var(--rm-bg);
      border: 1px solid var(--rm-border);
      border-radius: 10px;
      padding: 12px 14px;
      min-width: 0;
    }

    /* header */
    .head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .dot {
      width: 9px; height: 9px; border-radius: 50%;
      background: var(--rm-ok); flex: none;
    }
    .dot.off { background: var(--rm-warn); }
    .title { font-weight: 600; font-size: 15px; }
    .head-meta {
      color: var(--rm-muted); font-size: 12px;
      margin-left: auto; white-space: nowrap;
    }

    /* loading / error banner */
    .loading {
      color: var(--rm-muted);
      background: rgba(139, 148, 158, .08);
      border: 1px solid var(--rm-border);
      border-radius: 6px;
      padding: 8px 10px;
      margin-top: 10px;
      font-size: 12.5px;
    }
    .error {
      color: var(--rm-bad);
      background: rgba(248, 81, 73, .1);
      border: 1px solid rgba(248, 81, 73, .4);
      border-radius: 6px;
      padding: 8px 10px;
      margin-top: 10px;
      font-size: 12.5px;
      line-height: 1.4;
      word-break: break-word;
    }

    /* main grid: CPU ring | RAM panel */
    .main {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 16px;
      align-items: center;
      margin-top: 12px;
    }

    /* CPU ring */
    .cpu { display: flex; flex-direction: column; align-items: center; gap: 6px; }
    .ring-wrap { position: relative; width: 92px; height: 92px; }
    svg.ring { width: 100%; height: 100%; transform: rotate(-90deg); display: block; }
    .ring-bg { fill: none; stroke: var(--rm-track); stroke-width: 8; }
    .ring-fg {
      fill: none; stroke-width: 8; stroke-linecap: round;
      transition: stroke-dashoffset .4s ease, stroke .4s ease;
    }
    .ring-label {
      position: absolute; inset: 0;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
    }
    .big { font-size: 19px; font-weight: 600; line-height: 1.1; }
    .ring-sub { font-size: 11px; color: var(--rm-muted); }

    /* per-core bars */
    .cores-row { margin-top: 12px; }
    .cores-head {
      display: flex; justify-content: space-between;
      font-size: 11px; color: var(--rm-muted); margin-bottom: 4px;
    }
    .cores {
      display: flex; align-items: flex-end; gap: 4px;
      height: 22px; width: 100%;
    }
    .core {
      flex: 1; min-width: 3px; height: 100%;
      background: var(--rm-track); border-radius: 3px;
      position: relative; overflow: hidden;
    }
    .core .fill {
      position: absolute; bottom: 0; left: 0; right: 0;
      border-radius: 3px;
      transition: height .4s ease;
    }
    .cores-label { display: none; }

    /* RAM panel */
    .mem { min-width: 0; }
    .row {
      display: flex; align-items: baseline; gap: 8px;
      flex-wrap: wrap; margin-bottom: 5px;
    }
    .label { color: var(--rm-muted); font-size: 12.5px; font-weight: 500; }
    .sub { color: var(--rm-muted); font-size: 12px; }
    .bar {
      height: 10px; border-radius: 5px;
      background: var(--rm-track); overflow: hidden;
    }
    .bar .fill {
      height: 100%; border-radius: 5px;
      transition: width .4s ease, background .4s ease;
    }
    .swap-row { margin-top: 7px; display: flex; gap: 8px; align-items: baseline; }
    .swap-row .bar { flex: 1; height: 6px; }

    /* containers */
    .conts { margin-top: 14px; }
    .conts-head {
      display: flex; align-items: center; gap: 8px;
      color: var(--rm-muted); font-size: 12.5px; font-weight: 500;
      margin-bottom: 7px;
    }
    .conts-count {
      color: var(--rm-muted); background: var(--rm-track);
      border-radius: 9px; padding: 0 8px; font-size: 11px;
    }
    .cont-list { display: flex; flex-direction: column; gap: 4px; }
    .cont {
      display: flex; align-items: center; gap: 8px;
      font-size: 12.5px; min-width: 0;
      padding: 5px 8px;
      border: 1px solid var(--rm-border);
      border-radius: 7px;
      background: rgba(139, 148, 158, .05);
    }
    .cont .dot { width: 7px; height: 7px; }
    .cont .name {
      font-weight: 500; min-width: 0;
      flex: 0 1 auto;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .badge {
      font-size: 10.5px; padding: 1px 8px; border-radius: 9px;
      border: 1px solid; white-space: nowrap; flex: none;
    }
    .badge.ok { color: var(--rm-ok); border-color: rgba(63, 185, 80, .4); background: rgba(63, 185, 80, .1); }
    .badge.warn { color: var(--rm-warn); border-color: rgba(210, 153, 34, .4); background: rgba(210, 153, 34, .1); }
    .badge.bad { color: var(--rm-bad); border-color: rgba(248, 81, 73, .4); background: rgba(248, 81, 73, .1); }
    .badge.muted { color: var(--rm-muted); border-color: var(--rm-border); background: rgba(139, 148, 158, .08); }
    .stat {
      color: var(--rm-muted); margin-left: auto;
      white-space: nowrap; font-variant-numeric: tabular-nums;
    }
    .stat + .stat { margin-left: 0; padding-left: 8px; }
    .cont .stat:first-of-type { margin-left: auto; }

    /* keep container names readable in narrow cards by shedding the units
       and then the memory figure */
    @container (max-width: 330px) {
      .cu { display: none; }
    }
    @container (max-width: 285px) {
      .stat-mem { display: none !important; }
    }

    /* footer */
    .foot {
      margin-top: 12px; color: var(--rm-muted); font-size: 11px;
      display: flex; justify-content: space-between; gap: 8px;
      flex-wrap: wrap;
    }

    /* container queries key off the card's own width, not the viewport */
    @container (max-width: 340px) {
      .main { grid-template-columns: auto 1fr; gap: 12px; }
      .head-meta { font-size: 11px; }
    }
    @container (max-width: 260px) {
      .main { grid-template-columns: 1fr; justify-items: center; }
      .mem { width: 100%; }
    }
  `;

  const RING_CIRCUMFERENCE = 2 * Math.PI * 44;

  // ---------------------------------------------------------------------------
  // the card
  // ---------------------------------------------------------------------------

  class ResourceMonitorCard extends HTMLElement {
    constructor() {
      super();
      const root = this.attachShadow({ mode: "open" });
      root.innerHTML = `<style>${CARD_STYLE}</style><div class="card"></div>`;
      this._shell = root.querySelector(".card");
      this._config = null;
      this._state = null;
      this._polling = false;
      this._timer = null;
      this._gen = 0;
    }

    /** Lovelace card constructor contract. */
    setConfig(config) {
      if (!config || !config.url) {
        throw new Error("Missing required config key: url");
      }
      const url = normalizeUrl(config.url);
      if (!url) {
        throw new Error(`Invalid monitor URL: ${config.url}`);
      }
      this._config = {
        url,
        token: String(config.token ?? "").trim(),
        interval: clampInterval(config.interval ?? DEFAULT_INTERVAL),
        title: String(config.title ?? "").trim(),
        max_containers: clampCount(config.max_containers),
      };
      this._restartPolling();
      this._render();
    }

    getCardSize() {
      return 6;
    }

    connectedCallback() {
      // setConfig may have started polling before the element was connected;
      // only resume it if it was stopped by a disconnect.
      if (this._config && !this._polling) this._restartPolling();
    }

    disconnectedCallback() {
      this._stopPolling();
    }

    // ----- polling -----------------------------------------------------------

    _restartPolling() {
      this._stopPolling();
      this._gen++;
      this._polling = true;
      this._tick();
    }

    _stopPolling() {
      this._polling = false;
      if (this._timer) {
        clearTimeout(this._timer);
        this._timer = null;
      }
    }

    _fetchOptions() {
      // Query-param token: mirrors the standalone dashboard and survives
      // reverse proxies that strip the Authorization header. The monitor's
      // CORS allows cross-origin GETs with this parameter.
      const headers = {};
      if (this._config.token) {
        headers.Authorization = `Bearer ${this._config.token}`;
      }
      return Object.keys(headers).length ? { headers } : undefined;
    }

    _reqUrl(path) {
      let url = `${this._config.url}/${path}`;
      if (this._config.token) {
        url += `?token=${encodeURIComponent(this._config.token)}`;
      }
      return url;
    }

    async _tick() {
      if (!this._polling) return;
      const gen = this._gen;
      this._timer = setTimeout(() => this._tick(), this._config.interval * 1000);
      const snapshot = await this._fetchSnapshot().catch((e) => ({ error: e.message }));
      // Drop the result if polling was restarted (config change /
      // disconnect) while this fetch was in flight.
      if (!this._polling || this._gen !== gen) return;
      this._state = { ...snapshot, updated: Date.now() };
      this._render();
    }

    async _fetchSnapshot() {
      const [sysRes, contRes] = await Promise.all([
        fetch(this._reqUrl("api/system"), this._fetchOptions()),
        fetch(this._reqUrl("api/containers"), this._fetchOptions()),
      ]);

      if (sysRes.status === 401 || sysRes.status === 403) {
        return { error: "Unauthorized — check the monitor token in the card config." };
      }
      if (!sysRes.ok) {
        return { error: `Monitor error: HTTP ${sysRes.status} on /api/system` };
      }
      const system = await sysRes.json();

      let containers = null;
      let containerError = null;
      if (contRes.ok) {
        const payload = await contRes.json().catch(() => null);
        if (payload && payload.error) containerError = String(payload.error);
        else if (payload && Array.isArray(payload.containers)) containers = payload.containers;
        else containerError = "unexpected /api/containers payload";
      } else if (contRes.status === 401 || contRes.status === 403) {
        containerError = "Unauthorized — check the monitor token in the card config.";
      } else {
        // The monitor reports daemon problems as {"error": "..."} with a 5xx.
        const payload = await contRes.json().catch(() => null);
        containerError =
          (payload && payload.error) || `Docker stats: HTTP ${contRes.status}`;
      }

      return { system, containers, containerError };
    }

    // ----- rendering ----------------------------------------------------------

    _render() {
      if (!this._config) return;
      const s = this._state;
      let html = "";

      const title = esc(this._config.title || "System Monitor");
      let dotCls = "dot";
      let headMeta = "";
      if (!s) {
        dotCls = "dot off";
        headMeta = "connecting…";
      } else if (s.error) {
        dotCls = "dot off";
        headMeta = "unreachable";
      } else if (s.system) {
        const load = (s.system.cpu.load_avg || []).map((v) => (v ?? 0).toFixed(2)).join(" / ");
        headMeta = `up ${humanDuration(s.system.uptime_seconds)} · load ${load}`;
      }

      html += `<div class="head">
        <span class="${dotCls}"></span>
        <span class="title">${title}</span>
        <span class="head-meta">${esc(headMeta)}</span>
      </div>`;

      if (!s) {
        html += `<div class="loading">Waiting for the first data…</div>`;
      } else if (s.error) {
        html += `<div class="error">${esc(s.error)}</div>`;
      } else {
        html += this._renderMain(s.system);
        html += this._renderContainers(s.containers, s.containerError);
      }

      const updated = s && s.updated
        ? new Date(s.updated).toLocaleTimeString([], { hour12: false })
        : null;
      html += `<div class="foot">
        <span>${updated ? `updated ${updated}` : "no data yet"}</span>
        <span>every ${this._config.interval}s</span>
      </div>`;

      this._shell.innerHTML = html;
    }

    _renderMain(system) {
      if (!system) {
        return `<div class="main"><div></div><div class="mem"><div class="error">No system data</div></div></div>`;
      }
      const cpu = system.cpu?.overall_percent ?? null;
      const offset = RING_CIRCUMFERENCE * (1 - Math.min(100, Math.max(0, cpu ?? 0)) / 100);
      const color = usageColor(cpu);

      const cores = (system.cpu?.per_core_percent || []).map((v, i) => {
        const pct = v == null ? 0 : Math.min(100, Math.max(0, v));
        return `<div class="core" title="core ${i}: ${v == null ? "—" : v.toFixed(1) + "%"}">
          <div class="fill" style="height:${pct}%; background:${usageColor(v)}"></div>
        </div>`;
      }).join("");

      const m = system.memory || {};
      const memPct = m.percent ?? null;
      const memColor = usageColor(memPct);
      const swapPct = m.swap_percent != null ? Math.min(100, Math.max(0, m.swap_percent)) : 0;
      const swapLabel = (m.swap_total_bytes ?? 0) > 0
        ? `swap ${humanBytes(m.swap_used_bytes)} / ${humanBytes(m.swap_total_bytes)}`
        : "swap disabled";

      return `<div class="main">
        <div class="cpu">
          <div class="ring-wrap">
            <svg class="ring" viewBox="0 0 100 100" aria-hidden="true">
              <circle class="ring-bg" cx="50" cy="50" r="44"></circle>
              <circle class="ring-fg" cx="50" cy="50" r="44"
                style="stroke:${color}; stroke-dasharray:${RING_CIRCUMFERENCE}; stroke-dashoffset:${offset}"></circle>
            </svg>
            <div class="ring-label">
              <div class="big" style="color:${color}">${cpu == null ? "—" : cpu.toFixed(1) + "%"}</div>
              <div class="ring-sub">CPU</div>
            </div>
          </div>
        </div>
        <div class="mem">
          <div class="row">
            <span class="label">Memory</span>
            <span class="big" style="color:${memColor}; font-size: 15px">${memPct == null ? "—" : memPct.toFixed(1) + "%"}</span>
            <span class="sub">${humanBytes(m.used_bytes)} / ${humanBytes(m.total_bytes)}</span>
          </div>
          <div class="bar">
            <div class="fill" style="width:${memPct == null ? 0 : Math.min(100, memPct)}%; background:${memColor}"></div>
          </div>
          <div class="swap-row">
            <span class="sub">${swapLabel}</span>
            <div class="bar">
              <div class="fill" style="width:${swapPct}%; background:var(--rm-accent)"></div>
            </div>
          </div>
        </div>
      </div>
      <div class="cores-row">
        <div class="cores-head">
          <span>Per-core</span>
          <span>${system.cpu?.cores ?? "—"} cores</span>
        </div>
        <div class="cores">${cores}</div>
      </div>`;
    }

    _renderContainers(containers, containerError) {
      let html = `<div class="conts">`;
      if (containerError) {
        html += `<div class="conts-head">Containers</div>
          <div class="error">${esc(containerError)}</div>`;
      } else if (!containers) {
        html += `<div class="conts-head">Containers</div>
          <div class="sub">no data</div>`;
      } else {
        const shown = containers.slice(0, this._config.max_containers);
        html += `<div class="conts-head">
          <span>Containers</span>
          <span class="conts-count">${containers.length}</span>
        </div><div class="cont-list">`;
        for (const c of shown) {
          const cpuTxt = c.cpu_percent != null ? c.cpu_percent.toFixed(1) + "%" : "—";
          const memTxt =
            c.memory_percent != null
              ? c.memory_percent.toFixed(1) + "%"
              : humanBytes(c.memory_usage_bytes) + " mem";
          const tip = `${c.name || c.id || "unknown"}${c.status ? " — " + c.status : ""}`;
          html += `<div class="cont" title="${esc(tip)}">
            ${this._contBadge(c)}
            <span class="name">${esc(trunc(c.name || c.id || "unknown", 22))}</span>
            <span class="stat">${esc(cpuTxt)}<span class="cu"> CPU</span></span>
            <span class="stat stat-mem">${esc(memTxt)}</span>
          </div>`;
        }
        if (containers.length > shown.length) {
          html += `<div class="sub" style="text-align:center">+${containers.length - shown.length} more (set max_containers)</div>`;
        }
        html += `</div>`;
      }
      html += `</div>`;
      return html;
    }

    _contBadge(c) {
      let stateCls = {
        running: "ok",
        paused: "warn",
        restarting: "warn",
        created: "muted",
        dead: "bad",
      }[c.state] || "muted";
      let label = c.state || "unknown";
      if (c.state === "exited") {
        stateCls = c.exit_code === 0 ? "muted" : "bad";
        label = `exited ${c.exit_code}`;
      }
      if (c.health === "unhealthy") {
        stateCls = "bad";
        label = c.state === "running" ? "unhealthy" : label;
      } else if (c.health === "starting") {
        stateCls = "warn";
      }
      return `<span class="dot ${stateCls === "ok" ? "" : "off"}" style="background:var(--rm-${stateCls === "ok" ? "ok" : stateCls === "warn" ? "warn" : stateCls === "bad" ? "bad" : "muted"})"></span>
        <span class="badge ${stateCls}">${esc(label)}</span>`;
    }
  }

  function clampCount(v) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_CONTAINERS;
    return Math.min(50, n);
  }

  // ---------------------------------------------------------------------------
  // the config dialog element
  //
  // Implements LovelaceGenericElementEditor: the card editor assigns .hass,
  // calls setConfig(config), and listens for a "config-changed" CustomEvent
  // on this element whose detail.config is the new card config.
  // ---------------------------------------------------------------------------

  const CONFIG_STYLE = /* css */ `
    :host {
      --rm-cfg-text: var(--primary-text-color, var(--ha-primary-color, #e6edf3));
      --rm-cfg-muted: var(--secondary-text-color, #8b949e);
      --rm-cfg-border: var(--divider-color, #30363d);
      --rm-cfg-bg: var(--card-background-color, var(--ha-card-background-color, #161b22));
      --rm-cfg-input-bg: var(--input-background-color, #0d1117);
      color: var(--rm-cfg-text);
      font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
      font-size: 13px;
      display: block;
    }
    .wrap { display: flex; flex-direction: column; gap: 12px; padding: 4px 0; }
    .field { display: flex; flex-direction: column; gap: 4px; }
    .field label { color: var(--rm-cfg-muted); font-size: 12px; font-weight: 500; }
    .field input {
      background: var(--rm-cfg-input-bg);
      border: 1px solid var(--rm-cfg-border);
      border-radius: 6px;
      color: var(--rm-cfg-text);
      padding: 7px 9px;
      font: inherit;
      width: 100%;
      min-width: 0;
    }
    .field input:focus { outline: 1px solid var(--rm-accent, var(--accent-color, #58a6ff)); }
    .hint { color: var(--rm-cfg-muted); font-size: 11px; }
  `;

  class ResourceMonitorCardConfig extends HTMLElement {
    constructor() {
      super();
      const root = this.attachShadow({ mode: "open" });
      root.innerHTML = `<style>${CONFIG_STYLE}</style>
        <div class="wrap">
          <div class="field">
            <label for="url">Monitor URL *</label>
            <input id="url" type="url" placeholder="http://192.168.1.50:1010"
              spellcheck="false" autocomplete="off">
            <div class="hint">Base URL of the Resource Monitor (port 1010 by default).</div>
          </div>
          <div class="field">
            <label for="token">Token</label>
            <input id="token" type="password" placeholder="(only if MONITOR_TOKEN is set)"
              spellcheck="false" autocomplete="off">
            <div class="hint">Sent as ?token= — matches MONITOR_TOKEN on the monitor.</div>
          </div>
          <div class="field">
            <label for="interval">Poll interval (seconds)</label>
            <input id="interval" type="number" min="2" max="60" step="1" placeholder="5">
            <div class="hint">2–60, default 5.</div>
          </div>
          <div class="field">
            <label for="title">Title</label>
            <input id="title" type="text" placeholder="System Monitor">
          </div>
          <div class="field">
            <label for="max_containers">Max containers shown</label>
            <input id="max_containers" type="number" min="1" max="50" step="1" placeholder="12">
          </div>
        </div>`;
      this._config = null;
      this._root = root;
      this._fields = ["url", "token", "interval", "title", "max_containers"];
      for (const id of this._fields) {
        const el = this._field(id);
        el.addEventListener("input", () => this._emit());
        el.addEventListener("change", () => this._emit());
      }
    }

    set hass(value) {
      this._hass = value;
    }
    get hass() {
      return this._hass;
    }

    _field(id) {
      return this._root.getElementById(id);
    }

    setConfig(config) {
      this._config = config || {};
      for (const id of this._fields) {
        const v = this._config[id];
        // <input>.value is always a string; coerce so numbers round-trip.
        this._field(id).value = v == null ? "" : String(v);
      }
    }

    _readConfig() {
      const cfg = { ...this._config, type: "resource-monitor-card" };
      for (const id of this._fields) {
        const raw = String(this._field(id).value ?? "").trim();
        if (raw === "") delete cfg[id];
        else cfg[id] = id === "interval" || id === "max_containers" ? Number(raw) : raw;
      }
      if (!cfg.url) delete cfg.url;
      return cfg;
    }

    _emit() {
      this.dispatchEvent(
        new CustomEvent("config-changed", {
          detail: { config: this._readConfig() },
          bubbles: true,
          composed: true,
        })
      );
    }
  }

  customElements.define(CARD_TAG, ResourceMonitorCard);
  customElements.define(CONFIG_TAG, ResourceMonitorCardConfig);

  // ---------------------------------------------------------------------------
  // Lovelace registration
  // ---------------------------------------------------------------------------

  // Give the element a static config element so the "Edit card" dialog uses
  // the form above instead of the YAML editor.
  ResourceMonitorCard.getConfigElement = () =>
    document.createElement(CONFIG_TAG);

  window.customCards = window.customCards || [];
  window.customCards.push({
    type: CARD_TAG,
    name: "Resource Monitor Card",
    description: "Live host CPU, memory and Docker container stats from the Resource Monitor service.",
    url: "https://github.com/etanyxyz/System-Monitor-HA-Card",
    preview: true,
  });
})();
