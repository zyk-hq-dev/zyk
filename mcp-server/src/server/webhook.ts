import { createServer, IncomingMessage, ServerResponse } from "http";

type McpHandler = (req: IncomingMessage, res: ServerResponse, body?: unknown) => Promise<void>;
import { createHmac, timingSafeEqual } from "crypto";
import { getWorkflow, listWorkflows } from "../hatchet/register.js";
import { getHatchetClient } from "../hatchet/client.js";
import { isProTier } from "../lib/zyk-api.js";
import { storePendingQuestion, hasPendingQuestion, consumePendingQuestion, getPendingQuestions } from "./interactions.js";

const DEFAULT_PORT = 3100;

// ── Slack interaction store ───────────────────────────────────────────────────
// Workflows poll GET /slack/pending/:correlationId to retrieve button clicks.
// The correlation ID is the block_id set on the Slack actions block.

interface SlackInteraction {
  action: string;
  userId: string;
  username?: string;
  timestamp: string;
}

const pendingInteractions = new Map<string, SlackInteraction>();

// Evict entries older than 2 hours to avoid unbounded growth
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [key, val] of pendingInteractions) {
    if (new Date(val.timestamp).getTime() < cutoff) pendingInteractions.delete(key);
  }
}, 30 * 60 * 1000).unref();


function verifySlackSignature(
  signingSecret: string,
  signature: string,
  timestamp: string,
  rawBody: string
): boolean {
  const baseString = `v0:${timestamp}:${rawBody}`;
  const hmac = createHmac("sha256", signingSecret);
  hmac.update(baseString);
  const computed = `v0=${hmac.digest("hex")}`;
  try {
    return timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
  } catch {
    return false;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>
) {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

function sendHtml(res: ServerResponse, status: number, html: string) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
  });
  res.end(html);
}

// ── HTML pages ────────────────────────────────────────────────────────────────

function landingPage(_port: number, hatchetUrl: string, apiKey?: string): string {
  // Inject a fetch interceptor so the dashboard can call authenticated API endpoints.
  // The key is embedded in the HTML only when ZYK_API_KEY is set — the browser
  // then sends it as an Authorization header on all same-origin requests.
  const authScript = apiKey
    ? `<script>
  (function() {
    var _key = ${JSON.stringify(apiKey)};
    var _orig = window.fetch.bind(window);
    window.fetch = function(url, opts) {
      opts = opts || {};
      if (typeof url === 'string' && (url.startsWith('/') || url.startsWith(location.origin))) {
        opts.headers = Object.assign({ 'Authorization': 'Bearer ' + _key }, opts.headers || {});
      }
      return _orig(url, opts);
    };
  })();
<\/script>`
    : "";
  return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Zyk — Dashboard</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  ${authScript}
  <script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
  <style>
    :root {
      --bg:            #0a0a0b;
      --bg-secondary:  #111113;
      --bg-tertiary:   #1a1a1d;
      --border:        #27272a;
      --border-light:  #3f3f46;
      --text:          #fafafa;
      --text-secondary:#a1a1aa;
      --text-muted:    #71717a;
      --accent:        #6366f1;
      --accent-hover:  #818cf8;
      --success:       #22c55e;
      --error:         #ef4444;
      --warning:       #f59e0b;
      --font-sans: "Inter", system-ui, -apple-system, sans-serif;
      --font-mono: "JetBrains Mono", ui-monospace, monospace;
    }
    *, *::before, *::after { box-sizing: border-box; }
    html { font-size: 20px; }
    html, body { height: 100%; overflow: hidden; }
    body {
      font-family: var(--font-sans);
      background: var(--bg);
      color: var(--text-secondary);
      margin: 0;
      padding: 0;
      line-height: 1.5;
      font-size: 1rem;
      -webkit-font-smoothing: antialiased;
      display: flex;
      flex-direction: column;
    }

    /* ── Scrollbars ── */
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: var(--border-light); }

    /* ── Focus ── */
    *:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

    /* ── Header ── */
    header {
      height: 48px;
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border);
      padding: 0 1.25rem;
      display: flex;
      align-items: center;
      gap: .75rem;
      flex-shrink: 0;
      z-index: 10;
    }
    .logo {
      font-size: 1rem;
      font-weight: 700;
      color: #FFB6D9;
      letter-spacing: -.02em;
      flex-shrink: 0;
    }
    .header-sep {
      width: 1px;
      height: 16px;
      background: var(--border);
    }
    .header-subtitle {
      font-size: 13px;
      color: var(--text-muted);
    }
    .header-actions {
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: .5rem;
    }

    /* ── Buttons ── */
    .btn {
      display: inline-flex;
      align-items: center;
      gap: .35rem;
      padding: .3rem .75rem;
      border-radius: 6px;
      font-size: .8rem;
      font-weight: 500;
      font-family: var(--font-sans);
      cursor: pointer;
      border: 1px solid transparent;
      text-decoration: none;
      transition: background-color .15s, color .15s, border-color .15s;
      white-space: nowrap;
    }
    .btn-ghost {
      background: transparent;
      color: var(--text-muted);
      border-color: transparent;
    }
    .btn-ghost:hover { background: var(--bg-tertiary); color: var(--text-secondary); }

    /* ── Badges ── */
    .badge {
      display: inline-flex;
      align-items: center;
      padding: 1px 8px;
      border-radius: 9999px;
      font-size: .7rem;
      font-weight: 500;
      letter-spacing: .02em;
    }
    .badge-gray     { background: var(--bg-tertiary); color: var(--text-secondary); }
    .badge-indigo   { background: rgba(99,102,241,.12); color: var(--accent-hover); }
    .badge-green    { background: rgba(34,197,94,.1);   color: var(--success); }
    .badge-yellow   { background: rgba(245,158,11,.1);  color: var(--warning); }

    /* ── App body ── */
    .app {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* ── Tab bar ── */
    .tab-bar {
      display: flex;
      align-items: stretch;
      border-bottom: 1px solid var(--border);
      background: var(--bg-secondary);
      flex-shrink: 0;
      overflow-x: auto;
    }
    .tab-btn {
      padding: .5rem 1rem;
      font-size: .8rem;
      font-weight: 500;
      color: var(--text-muted);
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      cursor: pointer;
      font-family: var(--font-sans);
      margin-bottom: -1px;
      white-space: nowrap;
      transition: color .15s, border-color .15s;
    }
    .tab-btn:hover { color: var(--text-secondary); }
    .tab-btn.active { color: var(--text); border-bottom-color: var(--accent); }
    .tab-count {
      display: inline-block;
      background: var(--bg-tertiary);
      color: var(--text-muted);
      border-radius: 9999px;
      font-size: .65rem;
      padding: 1px 5px;
      margin-left: .3rem;
      vertical-align: middle;
    }
    .tab-sep {
      width: 1px;
      background: var(--border);
      margin: 8px 4px;
      flex-shrink: 0;
    }
    .wf-subtabs {
      display: flex;
      overflow-x: auto;
      flex: 1;
    }

    /* ── Panel layout ── */
    .panel { display: none; flex: 1; flex-direction: column; overflow: hidden; }
    .panel.active { display: flex; }

    /* ── Workflow view ── */
    .wf-info-bar {
      padding: .6rem 1rem;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      gap: .75rem;
      flex-shrink: 0;
      min-height: 42px;
    }
    .wf-info-name {
      font-size: .9rem;
      font-weight: 600;
      color: var(--text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .wf-info-id {
      font-size: .7rem;
      color: var(--text-muted);
      font-family: var(--font-mono);
      white-space: nowrap;
    }
    .wf-info-desc {
      font-size: .78rem;
      color: var(--text-muted);
      line-height: 1.4;
    }

    /* ── Diagram — full bleed ── */
    .diagram-wrap {
      flex: 1;
      background: var(--bg);
      overflow: hidden;
      position: relative;
      display: flex;
      justify-content: center;
      align-items: center;
      cursor: grab;
    }
    .diagram-wrap svg { display: block; user-select: none; }
    .diagram-none { font-size: .75rem; color: var(--border-light); cursor: default; }

    /* ── Diagram zoom controls ── */
    .diagram-controls {
      position: absolute;
      top: 6px;
      right: 6px;
      display: flex;
      gap: 2px;
      opacity: 0;
      transition: opacity .15s;
      z-index: 2;
    }
    .diagram-wrap:hover .diagram-controls { opacity: 1; }
    .diagram-controls button {
      width: 22px;
      height: 22px;
      border: 1px solid var(--border-light);
      background: var(--bg-secondary);
      color: var(--text-muted);
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
      padding: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: var(--font-sans);
    }
    .diagram-controls button:hover { background: var(--border); color: var(--text); }

    /* ── Workflow footer ── */
    .wf-footer {
      padding: .4rem 1rem;
      border-top: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: .72rem;
      flex-shrink: 0;
    }
    .last-run { color: var(--text-muted); }
    .last-run.s-completed { color: var(--success); }
    .last-run.s-failed { color: var(--error); }
    .last-run.s-running { color: var(--warning); }
    .hatchet-link { color: var(--text-muted); text-decoration: none; }
    .hatchet-link:hover { color: var(--accent-hover); }

    /* ── Empty state ── */
    .empty {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: .5rem;
      text-align: center;
    }
    .empty-icon { font-size: 1.75rem; margin-bottom: .25rem; }
    .empty-title { font-size: .95rem; font-weight: 500; color: var(--text-secondary); }
    .empty-hint  { font-size: .8rem; color: var(--text-muted); }
    .empty code  {
      background: var(--bg-tertiary);
      padding: .1em .4em;
      border-radius: 4px;
      color: var(--text-muted);
      font-family: var(--font-mono);
      font-size: .8em;
    }

    /* ── Tasks panel ── */
    .tasks-scroll {
      flex: 1;
      overflow-y: auto;
      padding: 1.5rem 1.25rem;
    }
    .tasks-inner { max-width: 640px; margin: 0 auto; }

    /* ── Task cards ── */
    .task-card {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1rem 1.25rem;
      display: flex;
      flex-direction: column;
      gap: .75rem;
    }
    .task-card + .task-card { margin-top: .75rem; }
    .task-workflow {
      font-size: .7rem;
      font-family: var(--font-mono);
      color: var(--text-muted);
      letter-spacing: .04em;
    }
    .task-question {
      font-size: .9rem;
      color: var(--text);
      font-weight: 500;
    }
    .task-options {
      display: flex;
      flex-wrap: wrap;
      gap: .5rem;
    }
    .task-opt-btn {
      padding: .35rem .9rem;
      border-radius: 6px;
      font-size: .8rem;
      font-weight: 500;
      font-family: var(--font-sans);
      cursor: pointer;
      border: 1px solid var(--border-light);
      background: var(--bg-tertiary);
      color: var(--text-secondary);
      transition: background .15s, color .15s, border-color .15s;
    }
    .task-opt-btn:hover { background: var(--accent); color: #fff; border-color: var(--accent); }
    .task-opt-btn:disabled { opacity: .45; cursor: not-allowed; }
    .task-text-row { display: flex; gap: .5rem; }
    .task-text-input {
      flex: 1;
      background: var(--bg-tertiary);
      border: 1px solid var(--border-light);
      border-radius: 6px;
      color: var(--text);
      font-size: .82rem;
      font-family: var(--font-sans);
      padding: .35rem .7rem;
      outline: none;
    }
    .task-text-input:focus { border-color: var(--accent); }
    .task-submit-btn {
      padding: .35rem .9rem;
      border-radius: 6px;
      font-size: .8rem;
      font-weight: 500;
      font-family: var(--font-sans);
      cursor: pointer;
      border: none;
      background: var(--accent);
      color: #fff;
      transition: background .15s;
    }
    .task-submit-btn:hover { background: var(--accent-hover); }
    .task-submit-btn:disabled { opacity: .45; cursor: not-allowed; }
    .task-done-msg { font-size: .8rem; color: var(--success); }

    /* ── Live indicator ── */
    .live-dot {
      position: fixed;
      bottom: 2.5rem;
      right: 1rem;
      display: flex;
      align-items: center;
      gap: .4rem;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: .35rem .7rem;
      font-size: .72rem;
      color: var(--text-muted);
      z-index: 20;
    }
    .live-dot::before {
      content: '';
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--success);
      animation: pulse 2s ease-in-out infinite;
    }
    @keyframes pulse {
      0%,100% { opacity: 1; }
      50%      { opacity: .25; }
    }

    /* ── Misc ── */
    a { color: var(--accent-hover); text-decoration: none; }
    a:hover { text-decoration: underline; }
    code {
      background: var(--bg-tertiary);
      padding: .1em .4em;
      border-radius: 4px;
      font-size: .85em;
      color: var(--text-secondary);
      font-family: var(--font-mono);
    }
  </style>
</head>
<body>
  <header>
    <span class="logo">Zyk</span>
    <span class="header-sep"></span>
    <span class="header-subtitle">Dashboard</span>
    <div class="header-actions">
      <a class="btn btn-ghost" href="${hatchetUrl}" target="_blank">Hatchet UI ↗</a>
    </div>
  </header>

  <div class="app">
    <!-- Combined tab bar: main tabs + workflow sub-tabs -->
    <div class="tab-bar">
      <button class="tab-btn active" data-tab="workflows">
        Workflows<span class="tab-count" id="wf-count-badge"></span>
      </button>
      <button class="tab-btn" data-tab="tasks" id="tasks-tab-btn">
        Tasks<span class="tab-count" id="tasks-count-badge"></span>
      </button>
      <span class="tab-sep" id="wf-subtabs-sep" style="display:none"></span>
      <div class="wf-subtabs" id="wf-subtabs"></div>
    </div>

    <!-- Workflows panel -->
    <div id="panel-workflows" class="panel active">
      <!-- Empty state -->
      <div id="wf-empty" class="empty" style="display:none">
        <div class="empty-icon">🤖</div>
        <div class="empty-title">No workflows yet</div>
        <div class="empty-hint">Ask Claude to create one — <code>create a daily Slack summary</code></div>
      </div>
      <!-- Workflow detail view -->
      <div id="wf-view" style="display:none;flex:1;flex-direction:column;overflow:hidden">
        <div class="wf-info-bar" id="wf-info-bar"></div>
        <div class="diagram-wrap" id="wf-diagram"></div>
        <div class="wf-footer">
          <span class="last-run" id="wf-last-run"></span>
          <a class="hatchet-link" id="wf-hatchet-link" href="${hatchetUrl}" target="_blank">Hatchet UI ↗</a>
        </div>
      </div>
    </div>

    <!-- Tasks panel -->
    <div id="panel-tasks" class="panel">
      <div class="tasks-scroll">
        <div class="tasks-inner" id="tasks-root"></div>
      </div>
    </div>
  </div>

  <div class="live-dot">Live</div>

  <script>
    mermaid.initialize({
      startOnLoad: false,
      theme: 'dark',
      themeVariables: {
        background:          '#0a0a0b',
        primaryColor:        '#1e1b4b',
        primaryTextColor:    '#e4e4e7',
        primaryBorderColor:  '#6366f1',
        lineColor:           '#52525b',
        secondaryColor:      '#1a1a1d',
        tertiaryColor:       '#111113',
        edgeLabelBackground: '#111113',
        fontFamily:          '"Inter", system-ui, sans-serif',
        fontSize:            '13px',
      },
      flowchart: { curve: 'basis', padding: 20, useMaxWidth: true },
    });

    let renderSeq = 0;
    const svgCache = new Map(); // wfId -> rendered SVG string
    let selectedWfId = null;
    let allWorkflows = [];
    let lastRenderedFingerprint = null; // tracks what was last rendered to avoid unnecessary redraws
    let latestRuns = [];

    function escHtml(str) {
      return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    const hatchetUrl = ${JSON.stringify(hatchetUrl)};

    // ── Diagram zoom / pan ────────────────────────────────────────────────────
    function initDiagramZoom(wrap) {
      const svg = wrap.querySelector('svg');
      if (!svg) return;

      wrap.style.display = 'block';
      svg.style.transformOrigin = '0 0';
      svg.style.display = 'block';
      svg.style.userSelect = 'none';

      let s = 1, x = 0, y = 0;
      let defaultX = 0, defaultY = 0;

      function apply() {
        svg.style.transform = \`translate(\${x}px,\${y}px) scale(\${s})\`;
      }

      requestAnimationFrame(() => {
        const wr = wrap.getBoundingClientRect();
        const sr = svg.getBoundingClientRect();
        if (wr.width > 0 && sr.width > 0) {
          defaultX = Math.max(0, (wr.width - sr.width) / 2);
          defaultY = Math.max(0, (wr.height - sr.height) / 2);
          x = defaultX; y = defaultY;
          apply();
        }
      });

      function zoomAt(cx, cy, factor) {
        const ns = Math.max(0.15, Math.min(6, s * factor));
        x = cx - (cx - x) * (ns / s);
        y = cy - (cy - y) * (ns / s);
        s = ns;
        apply();
      }

      wrap.addEventListener('wheel', e => {
        e.preventDefault();
        const r = wrap.getBoundingClientRect();
        zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.15 : 0.87);
      }, { passive: false });

      wrap.addEventListener('mousedown', e => {
        if (e.target.closest('.diagram-controls')) return;
        const sx = e.clientX, sy = e.clientY, tx0 = x, ty0 = y;
        wrap.style.cursor = 'grabbing';
        e.preventDefault();
        function onMove(e) { x = tx0 + e.clientX - sx; y = ty0 + e.clientY - sy; apply(); }
        function onUp()    { wrap.style.cursor = 'grab'; document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });

      wrap.addEventListener('dblclick', e => {
        if (e.target.closest('.diagram-controls')) return;
        s = 1; x = defaultX; y = defaultY; apply();
      });

      const ctrl = document.createElement('div');
      ctrl.className = 'diagram-controls';
      ctrl.innerHTML = '<button title="Zoom in">+</button><button title="Zoom out">−</button><button title="Reset (or double-click)">↺</button>';
      wrap.appendChild(ctrl);
      const center = () => { const r = wrap.getBoundingClientRect(); return [r.width / 2, r.height / 2]; };
      const [btnIn, btnOut, btnReset] = ctrl.querySelectorAll('button');
      btnIn.addEventListener('click',    () => { const [cx,cy] = center(); zoomAt(cx, cy, 1.3); });
      btnOut.addEventListener('click',   () => { const [cx,cy] = center(); zoomAt(cx, cy, 0.77); });
      btnReset.addEventListener('click', () => { s=1; x=defaultX; y=defaultY; apply(); });
    }

    // ── Render the selected workflow's diagram + info bar ─────────────────────
    async function renderSelectedWorkflow() {
      const wf = allWorkflows.find(w => w.id === selectedWfId);
      if (!wf) return;

      // Info bar
      const badgeClass = { 'on-demand': 'badge-gray', schedule: 'badge-green' }[wf.trigger] ?? 'badge-gray';
      const scheduleHint = wf.schedule ? \` · \${wf.schedule}\` : '';
      const infoBar = document.getElementById('wf-info-bar');
      infoBar.innerHTML =
        '<div style="flex:1;min-width:0">' +
          '<div style="display:flex;align-items:center;gap:.5rem">' +
            '<span class="wf-info-name">' + escHtml(wf.name) + '</span>' +
            '<span class="wf-info-id">' + escHtml(wf.id) + '</span>' +
          '</div>' +
          (wf.description ? '<div class="wf-info-desc" style="margin-top:2px">' + escHtml(wf.description) + '</div>' : '') +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:.5rem;flex-shrink:0">' +
          '<span class="badge ' + badgeClass + '">' + escHtml(wf.trigger) + escHtml(scheduleHint) + '</span>' +
        '</div>';

      // Diagram
      const diagramWrap = document.getElementById('wf-diagram');
      // Remove old zoom controls but keep if same wf (cache hit reattaches them)
      diagramWrap.querySelectorAll('.diagram-controls').forEach(el => el.remove());

      if (wf.diagram) {
        if (svgCache.has(wf.id)) {
          diagramWrap.innerHTML = svgCache.get(wf.id);
          initDiagramZoom(diagramWrap);
        } else {
          diagramWrap.innerHTML = '<span class="diagram-none" style="color:var(--text-muted);font-size:12px">Rendering…</span>';
          try {
            const { svg } = await mermaid.render('mermaid-' + (++renderSeq), wf.diagram);
            svgCache.set(wf.id, svg);
            diagramWrap.innerHTML = svg;
            initDiagramZoom(diagramWrap);
          } catch {
            diagramWrap.innerHTML = '<span class="diagram-none">⚠ Could not render diagram</span>';
          }
        }
      } else {
        diagramWrap.innerHTML = '<span class="diagram-none">No diagram</span>';
      }

      // Footer last-run
      updateLastRun(wf);
    }

    function updateLastRun(wf) {
      const el = document.getElementById('wf-last-run');
      if (!el) return;
      const kebab = wf.name.toLowerCase().replace(/\\s+/g, '-');
      const lastRun = latestRuns.find(r => r.workflow_name === wf.name || r.workflow_name === kebab);
      if (!lastRun) {
        el.textContent = 'No runs yet';
        el.className = 'last-run';
      } else {
        const diff = Date.now() - new Date(lastRun.started_at).getTime();
        const ago = diff < 60000 ? Math.round(diff/1000) + 's ago'
          : diff < 3600000 ? Math.round(diff/60000) + 'm ago'
          : Math.round(diff/3600000) + 'h ago';
        const s = (lastRun.status ?? '').toLowerCase();
        el.textContent = '● ' + s + ' ' + ago;
        el.className = 'last-run s-' + s;
      }
    }

    // ── Workflow sub-tabs ─────────────────────────────────────────────────────
    function renderSubtabs() {
      const container = document.getElementById('wf-subtabs');
      const sep = document.getElementById('wf-subtabs-sep');
      if (allWorkflows.length <= 1) {
        container.innerHTML = '';
        sep.style.display = 'none';
        return;
      }
      sep.style.display = '';
      // Rebuild only if set of ids changed
      const existing = [...container.querySelectorAll('[data-wfid]')].map(b => b.dataset.wfid);
      const newIds = allWorkflows.map(w => w.id);
      if (JSON.stringify(existing) !== JSON.stringify(newIds)) {
        container.innerHTML = '';
        for (const wf of allWorkflows) {
          const btn = document.createElement('button');
          btn.className = 'tab-btn' + (wf.id === selectedWfId ? ' active' : '');
          btn.dataset.wfid = wf.id;
          btn.textContent = wf.name;
          btn.style.fontFamily = 'var(--font-mono)';
          btn.style.fontSize = '.72rem';
          btn.addEventListener('click', () => {
            selectedWfId = wf.id;
            lastRenderedFingerprint = null; // force re-render on tab switch
            container.querySelectorAll('[data-wfid]').forEach(b => b.classList.toggle('active', b.dataset.wfid === wf.id));
            renderSelectedWorkflow();
          });
          container.appendChild(btn);
        }
      } else {
        // Just update active state
        container.querySelectorAll('[data-wfid]').forEach(b => b.classList.toggle('active', b.dataset.wfid === selectedWfId));
      }
    }

    // ── Poll loop ─────────────────────────────────────────────────────────────
    async function loadAndRender() {
      let workflows, runsData;
      try {
        const [wfRes, runsRes] = await Promise.all([
          fetch('/api/workflows'),
          fetch('/api/runs?limit=100&since_hours=72'),
        ]);
        workflows = await wfRes.json();
        runsData = await runsRes.json();
      } catch { return; }

      latestRuns = runsData?.runs ?? [];
      allWorkflows = workflows;

      const badge = document.getElementById('wf-count-badge');
      if (badge) badge.textContent = workflows.length ? String(workflows.length) : '';

      const emptyEl  = document.getElementById('wf-empty');
      const viewEl   = document.getElementById('wf-view');

      if (!workflows.length) {
        emptyEl.style.display = '';
        viewEl.style.display = 'none';
        selectedWfId = null;
        renderSubtabs();
        // Remove stale cache entries
        for (const id of svgCache.keys()) svgCache.delete(id);
        return;
      }

      // Ensure selected id is still valid; default to last workflow
      if (!selectedWfId || !workflows.find(w => w.id === selectedWfId)) {
        selectedWfId = workflows[workflows.length - 1].id;
      }

      // Invalidate SVG cache for workflows whose diagram text changed
      for (const wf of workflows) {
        const cached = svgCache.get(wf.id + '_src');
        if (cached !== wf.diagram) {
          svgCache.delete(wf.id);
          svgCache.set(wf.id + '_src', wf.diagram);
        }
      }
      // Remove stale entries for deleted workflows
      const currentIds = new Set(workflows.map(w => w.id));
      for (const key of svgCache.keys()) {
        const id = key.replace('_src', '');
        if (!currentIds.has(id)) { svgCache.delete(key); }
      }

      emptyEl.style.display = 'none';
      viewEl.style.display = 'flex';

      // Only re-render when something meaningful changed — avoids resetting pan/zoom on every poll
      const selectedWf = workflows.find(w => w.id === selectedWfId);
      const fingerprint = JSON.stringify({
        ids: workflows.map(w => w.id),
        names: workflows.map(w => w.name),
        selected: selectedWfId,
        diagram: selectedWf?.diagram,
        description: selectedWf?.description,
        trigger: selectedWf?.trigger,
        schedule: selectedWf?.schedule,
      });

      if (fingerprint !== lastRenderedFingerprint) {
        lastRenderedFingerprint = fingerprint;
        renderSubtabs();
        renderSelectedWorkflow();
      }
    }

    loadAndRender();
    setInterval(loadAndRender, 5000);

    // ── Main tab switching ────────────────────────────────────────────────────
    document.querySelectorAll('.tab-btn[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        const activeTab = btn.dataset.tab;
        document.querySelectorAll('.tab-btn[data-tab]').forEach(b => b.classList.toggle('active', b === btn));
        document.getElementById('panel-workflows').classList.toggle('active', activeTab === 'workflows');
        document.getElementById('panel-tasks').classList.toggle('active', activeTab === 'tasks');
        if (activeTab === 'tasks') loadTasks();
      });
    });

    if (location.hash === '#tasks') {
      document.getElementById('tasks-tab-btn').click();
    }

    // ── Tasks ─────────────────────────────────────────────────────────────────
    async function submitTaskAnswer(correlationId, action, cardEl) {
      const btns = cardEl.querySelectorAll('button');
      btns.forEach(b => b.disabled = true);
      try {
        await fetch('/interact/respond/' + encodeURIComponent(correlationId), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        });
        cardEl.innerHTML = '<div class="task-done-msg">✓ Answered: ' + escHtml(action) + '</div>';
        setTimeout(loadTasks, 800);
      } catch {
        btns.forEach(b => b.disabled = false);
      }
    }

    function buildTaskCard(task) {
      const card = document.createElement('div');
      card.className = 'task-card';

      const workflowEl = document.createElement('div');
      workflowEl.className = 'task-workflow';
      workflowEl.textContent = task.workflowName ?? task.workflow ?? 'unknown workflow';
      card.appendChild(workflowEl);

      const questionEl = document.createElement('div');
      questionEl.className = 'task-question';
      // Strip basic markdown (bold, italic, backticks) before displaying
      const rawMsg = task.message ?? task.question ?? '';
      questionEl.textContent = rawMsg.replace(/\\*\\*(.+?)\\*\\*/g, '$1').replace(/\\*(.+?)\\*/g, '$1').replace(/\`(.+?)\`/g, '$1').replace(/\`/g, '');
      card.appendChild(questionEl);

      const options = task.options ?? [];
      if (options.length > 0) {
        const optsEl = document.createElement('div');
        optsEl.className = 'task-options';
        options.forEach(opt => {
          const btn = document.createElement('button');
          btn.className = 'task-opt-btn';
          btn.textContent = opt.charAt(0).toUpperCase() + opt.slice(1);
          btn.addEventListener('click', () => submitTaskAnswer(task.correlationId, opt, card));
          optsEl.appendChild(btn);
        });
        card.appendChild(optsEl);
      } else {
        const row = document.createElement('div');
        row.className = 'task-text-row';
        const input = document.createElement('input');
        input.className = 'task-text-input';
        input.type = 'text';
        input.placeholder = 'Type your answer…';
        const submitBtn = document.createElement('button');
        submitBtn.className = 'task-submit-btn';
        submitBtn.textContent = 'Send';
        submitBtn.addEventListener('click', () => {
          if (input.value.trim()) submitTaskAnswer(task.correlationId, input.value.trim(), card);
        });
        input.addEventListener('keydown', e => {
          if (e.key === 'Enter' && input.value.trim()) submitTaskAnswer(task.correlationId, input.value.trim(), card);
        });
        row.appendChild(input);
        row.appendChild(submitBtn);
        card.appendChild(row);
      }

      return card;
    }

    async function loadTasks() {
      const tasksRoot = document.getElementById('tasks-root');
      const badge = document.getElementById('tasks-count-badge');

      let tasks;
      try {
        const res = await fetch('/api/tasks');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        tasks = await res.json();
        if (!Array.isArray(tasks)) throw new Error('Unexpected response');
      } catch (err) {
        // Only show error state if the panel is currently blank/loading
        if (tasksRoot && !tasksRoot.querySelector('.task-card')) {
          tasksRoot.innerHTML = \`<div class="empty" style="padding:6rem 0">
            <div class="empty-icon" style="font-size:2rem">⚠</div>
            <div class="empty-title" style="color:var(--error)">Could not load tasks</div>
            <div class="empty-hint">\${String(err)}</div>
          </div>\`;
        }
        return;
      }

      if (badge) badge.textContent = tasks.length ? String(tasks.length) : '';

      if (!tasks.length) {
        tasksRoot.innerHTML = \`
          <div class="empty" style="padding:6rem 0">
            <div class="empty-icon">✓</div>
            <div class="empty-title">No pending tasks</div>
            <div class="empty-hint">Workflows will post questions here when they need your input</div>
          </div>\`;
        return;
      }

      tasksRoot.innerHTML = '';
      for (const task of tasks) {
        try {
          tasksRoot.appendChild(buildTaskCard(task));
        } catch (err) {
          const errEl = document.createElement('div');
          errEl.style.cssText = 'color:var(--error);padding:8px;font-size:12px';
          errEl.textContent = 'Error rendering task: ' + String(err);
          tasksRoot.appendChild(errEl);
        }
      }
    }

    loadTasks();
    setInterval(loadTasks, 4000);
  </script>
</body>
</html>`;
}

// ── Request handler ───────────────────────────────────────────────────────────

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  port: number,
  mcpHandler?: McpHandler
): Promise<void> {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  // ── API key auth ─────────────────────────────────────────────────────────────
  // If ZYK_API_KEY is set, every request must carry "Authorization: Bearer <key>"
  // EXCEPT: Slack interaction callbacks (Slack can't send our key — they're
  // verified separately by HMAC signature) and the /api/workflows healthcheck
  // (Railway probes this path before the user can configure a header).
  const apiKey = process.env.ZYK_API_KEY;
  const isSlackCallback = url === "/slack/interactions" || url.startsWith("/slack/pending/");
  // Webhook triggers are unauthenticated — external services (GitHub, etc.) call these
  // without an Authorization header. The workflow ID in the URL acts as the implicit secret.
  const isWebhookTrigger = url.startsWith("/webhook/");
  const isHealthcheck = url === "/api/workflows" && method === "GET";
  // The dashboard HTML and favicon must load in a browser without auth headers.
  // The HTML embeds the API key as a fetch interceptor, so subsequent API calls are authenticated.
  const isDashboardPage = method === "GET" && (url === "/" || url === "/favicon.svg");
  // Worker subprocesses call these endpoints from localhost without auth headers.
  const isWorkerEndpoint = url === "/interact/ask" || url.startsWith("/interact/respond/") || url.startsWith("/interact/answer/");
  if (apiKey && !isSlackCallback && !isWebhookTrigger && !isHealthcheck && !isDashboardPage && !isWorkerEndpoint) {
    const authHeader = req.headers["authorization"] ?? "";
    const provided = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    let valid = false;
    try {
      valid = provided.length > 0 &&
        timingSafeEqual(Buffer.from(provided), Buffer.from(apiKey));
    } catch { /* length mismatch — invalid */ }
    if (!valid) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized: invalid or missing API key" }));
      return;
    }
  }
  // ─────────────────────────────────────────────────────────────────────────────

  // /mcp — delegate to MCP HTTP transport
  if (url === "/mcp" || url.startsWith("/mcp?")) {
    if (!mcpHandler) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "MCP handler not configured" }));
      return;
    }
    let body: unknown;
    if (method === "POST") {
      const raw = await readBody(req);
      if (raw.trim()) {
        try { body = JSON.parse(raw); } catch { /* ignore */ }
      }
    }
    await mcpHandler(req, res, body);
    return;
  }

  // GET /favicon.svg
  if (method === "GET" && url === "/favicon.svg") {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="7" fill="#111113"/>
  <rect x="1.5" y="1.5" width="29" height="29" rx="5.5" fill="none" stroke="#6366f1" stroke-width="1" opacity="0.5"/>
  <text x="16" y="23" font-family="Inter, system-ui, sans-serif" font-size="19" font-weight="700" text-anchor="middle" fill="#FFB6D9" letter-spacing="-1">Z</text>
</svg>`;
    res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" });
    res.end(svg);
    return;
  }

  // GET / — landing page
  if (method === "GET" && url === "/") {
    sendHtml(res, 200, landingPage(port, process.env.HATCHET_UI_URL ?? "http://localhost:8888", process.env.ZYK_API_KEY));
    return;
  }

  // GET /api/workflows — JSON list of registered workflows (used by dashboard)
  if (method === "GET" && url === "/api/workflows") {
    const workflows = listWorkflows().map((wf) => ({
      id: wf.id,
      name: wf.name,
      description: wf.description,
      trigger: wf.trigger,
      schedule: wf.schedule ?? null,
      diagram: wf.diagram ?? null,
      createdAt: wf.createdAt,
    }));
    const json = JSON.stringify(workflows, null, 2);
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(json),
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(json);
    return;
  }

  // GET /api/runs — recent workflow run executions (used by dashboard)
  if (method === "GET" && url.startsWith("/api/runs")) {
    const params = new URLSearchParams(url.includes("?") ? url.split("?")[1] : "");
    const limit = Math.min(parseInt(params.get("limit") ?? "50", 10), 100);
    const status = params.get("status") ?? undefined;
    const sinceHours = parseInt(params.get("since_hours") ?? "24", 10);
    const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString();

    // Build name→zykId map for linking runs to our workflows.
    // Key by hatchetName (kebab-case) preferred, fallback to human-readable name.
    const nameMap: Record<string, string> = {};
    for (const wf of listWorkflows()) {
      if (wf.hatchetName) nameMap[wf.hatchetName] = wf.id;
      nameMap[wf.name] = wf.id;
    }

    try {
      const hatchet = getHatchetClient();
      const tenantId = hatchet.tenantId;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resp = await hatchet.api.v1WorkflowRunList(tenantId, {
        since,
        limit,
        only_tasks: false,
        ...(status ? { statuses: [status as any] } : {}),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows: any[] = (resp.data as any)?.rows ?? [];
      const runs = rows.map((r) => {
        const rawName: string = r.displayName?.split("/")?.[0] ?? r.workflowName ?? "unknown";
        const workflowName = rawName.replace(/-\d{10,}$/, "");
        return {
          run_id: r.metadata?.id ?? r.id,
          workflow_name: workflowName,
          workflow_id: nameMap[workflowName] ?? null,
          status: r.status,
          started_at: r.metadata?.createdAt ?? r.createdAt,
          finished_at: r.finishedAt ?? null,
          duration_ms: r.duration ?? null,
        };
      });
      const json = JSON.stringify({ runs, since }, null, 2);
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(json),
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(json);
    } catch (err) {
      sendJson(res, 500, { error: `Failed to fetch runs: ${err instanceof Error ? err.message : String(err)}` });
    }
    return;
  }

  // POST /webhook/:workflow_id — trigger a workflow
  const webhookMatch = url.match(/^\/webhook\/([^/]+)$/);
  if (method === "POST" && webhookMatch) {
    const workflowId = webhookMatch[1];
    const entry = getWorkflow(workflowId);
    if (!entry) {
      sendJson(res, 404, {
        error: `Workflow "${workflowId}" not found.`,
        hint: "Use list_workflows to see registered workflows.",
      });
      return;
    }

    let params: Record<string, unknown> = {};
    const rawBody = await readBody(req);
    if (rawBody.trim()) {
      try {
        params = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        sendJson(res, 400, { error: "Request body must be valid JSON." });
        return;
      }
    }

    try {
      const hatchet = getHatchetClient();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const runRef = await hatchet.runNoWait(entry.name.toLowerCase(), params as any, {});
      const runId = await runRef.workflowRunId;

      sendJson(res, 200, {
        success: true,
        workflow_id: entry.id,
        workflow_name: entry.name,
        run_id: runId,
      });
    } catch (err) {
      sendJson(res, 500, {
        error: `Failed to trigger workflow: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    return;
  }

  // POST /slack/interactions — receives Slack button clicks
  if (method === "POST" && url === "/slack/interactions") {
    const rawBody = await readBody(req);

    // Verify Slack signature if signing secret is configured
    const signingSecret = process.env.SLACK_SIGNING_SECRET;
    if (signingSecret) {
      const timestamp = req.headers["x-slack-request-timestamp"] as string ?? "";
      const signature = req.headers["x-slack-signature"] as string ?? "";
      // Reject replays older than 5 minutes
      if (Math.abs(Date.now() / 1000 - parseInt(timestamp, 10)) > 300) {
        sendJson(res, 400, { error: "Request too old" });
        return;
      }
      if (!verifySlackSignature(signingSecret, signature, timestamp, rawBody)) {
        sendJson(res, 401, { error: "Invalid signature" });
        return;
      }
    }

    let payload: Record<string, unknown>;
    try {
      // Slack sends application/x-www-form-urlencoded with a "payload" field
      const decoded = decodeURIComponent(rawBody.replace(/^payload=/, ""));
      payload = JSON.parse(decoded) as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { error: "Invalid payload" });
      return;
    }

    const interactionType = payload.type as string;

    if (interactionType === "block_actions") {
      const actions = payload.actions as Array<Record<string, unknown>>;
      const user = payload.user as Record<string, string>;
      for (const action of actions) {
        const correlationId = action.block_id as string;
        const actionId = action.action_id as string;
        if (correlationId) {
          const payload = {
            action: actionId,
            userId: user?.id ?? "unknown",
            username: user?.username ?? "unknown",
            timestamp: new Date().toISOString(),
          };
          // Keep in-memory store for legacy polling workflows
          pendingInteractions.set(correlationId, payload);
          // Push Hatchet event for durable-task workflows using ctx.waitForEvent()
          pushHatchetEvent(correlationId, payload).catch(() => {});
        }
      }
    }

    // Acknowledge to Slack immediately (must respond within 3s)
    sendJson(res, 200, {});
    return;
  }

  // GET /slack/pending/:correlationId — workflow polling endpoint
  const slackPendingMatch = url.match(/^\/slack\/pending\/([^/]+)$/);
  if (method === "GET" && slackPendingMatch) {
    const correlationId = decodeURIComponent(slackPendingMatch[1]);
    const interaction = pendingInteractions.get(correlationId);
    if (interaction) {
      pendingInteractions.delete(correlationId); // consume once
      sendJson(res, 200, { pending: false, ...interaction });
    } else {
      sendJson(res, 200, { pending: true });
    }
    return;
  }

  // POST /interact/ask — workflow registers a question for the user
  if (method === "POST" && url === "/interact/ask") {
    const rawBody = await readBody(req);
    let body: { correlationId?: string; message?: string; options?: string[]; workflowName?: string; timeoutSeconds?: number };
    try {
      body = JSON.parse(rawBody) as typeof body;
    } catch {
      sendJson(res, 400, { error: "Invalid JSON" });
      return;
    }
    const { correlationId, workflowName, timeoutSeconds } = body;
    let { message, options } = body;
    if (!correlationId || !message) {
      sendJson(res, 400, { error: "correlationId and message are required" });
      return;
    }
    // Strip emojis/icons — keep task text clean
    const stripEmoji = (s: string) =>
      s.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FEFF}☀-⛿✀-➿🀄-🧿]/gu, "").replace(/\s{2,}/g, " ").trim();
    message = stripEmoji(message);
    if (options) options = options.map(stripEmoji);
    const expiresAt = timeoutSeconds
      ? new Date(Date.now() + timeoutSeconds * 1000).toISOString()
      : undefined;
    storePendingQuestion({
      correlationId,
      message,
      options,
      workflowName,
      askedAt: new Date().toISOString(),
      expiresAt,
    });
    sendJson(res, 200, { ok: true });
    return;
  }

  // POST /interact/respond/:correlationId — user submits answer from the dashboard
  const interactRespondMatch = url.match(/^\/interact\/respond\/([^/]+)$/);
  if (method === "POST" && interactRespondMatch) {
    const correlationId = decodeURIComponent(interactRespondMatch[1]);
    const rawBody = await readBody(req);
    let body: { action?: string };
    try {
      body = JSON.parse(rawBody) as typeof body;
    } catch {
      sendJson(res, 400, { error: "Invalid JSON" });
      return;
    }
    const { action } = body;
    if (!action) {
      sendJson(res, 400, { error: "action is required" });
      return;
    }
    const questionExists = hasPendingQuestion(correlationId);
    if (!questionExists) {
      sendJson(res, 404, { error: "Question not found or already answered" });
      return;
    }
    consumePendingQuestion(correlationId);
    const payload = { action: action.toLowerCase(), userId: "dashboard-user", timestamp: new Date().toISOString() };
    // Keep in-memory store for legacy polling workflows
    pendingInteractions.set(correlationId, payload);
    // Push Hatchet event for durable-task workflows using ctx.waitForEvent()
    pushHatchetEvent(correlationId, payload).catch((err) => {
      console.error(`[Interact] respond: pushHatchetEvent FAILED for ${correlationId}:`, err);
    });
    sendJson(res, 200, { ok: true });
    return;
  }

  // GET /interact/answer/:correlationId — workflow fetches stored answer after waitForEvent resolves
  const interactAnswerMatch = url.match(/^\/interact\/answer\/([^/]+)$/);
  if (method === "GET" && interactAnswerMatch) {
    const correlationId = decodeURIComponent(interactAnswerMatch[1]);
    const answer = pendingInteractions.get(correlationId);
    if (!answer) {
      sendJson(res, 404, { error: "Answer not found" });
      return;
    }
    pendingInteractions.delete(correlationId);
    sendJson(res, 200, answer as unknown as Record<string, unknown>);
    return;
  }

  // GET /api/tasks — list pending questions for the dashboard
  if (method === "GET" && url === "/api/tasks") {
    const tasks = getPendingQuestions().map((t) => ({
      ...t,
      workflowName: t.workflowName ?? "unknown workflow",
    }));
    const json = JSON.stringify(tasks, null, 2);
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(json),
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(json);
    return;
  }

  // Anything else
  sendJson(res, 404, {
    error: "Not found.",
    routes: [
      "POST /mcp                          — MCP HTTP transport (Claude Desktop)",
      "GET  /                             — dashboard",
      "GET  /api/workflows                — workflow list (JSON)",
      "GET  /api/runs                     — recent run executions (JSON)",
      "POST /webhook/:workflow_id         — trigger a workflow",
      "POST /slack/interactions           — Slack button callback (set as Interactivity URL)",
      "GET  /slack/pending/:correlationId — poll for a button click result",
      "POST /interact/ask                      — post a question for the user",
      "POST /interact/respond/:correlationId   — submit answer to a pending question",
      "GET  /api/tasks                         — list pending questions (JSON)",
    ],
  });
}

// ── Hatchet event push ────────────────────────────────────────────────────────
// Push a durable event so workflow.durableTask() steps using ctx.waitForEvent()
// can resume. Fire-and-forget — errors are logged but never thrown.

async function pushHatchetEvent(correlationId: string, payload: Record<string, unknown>): Promise<void> {
  try {
    const hatchet = getHatchetClient();
    await hatchet.events.push(correlationId, payload);
  } catch (err) {
    console.error(`[Events] Could not push Hatchet event for ${correlationId}:`, err instanceof Error ? err.message : err);
  }
}

// ── Exported helpers ──────────────────────────────────────────────────────────

export function storeInteractionAnswer(correlationId: string, action: string): void {
  // Keep in-memory store for legacy polling workflows and dashboard UI
  const normalizedAction = action.toLowerCase();
  pendingInteractions.set(correlationId, {
    action: normalizedAction,
    userId: "claude-user",
    timestamp: new Date().toISOString(),
  });
  // Also push a Hatchet event for durable-task workflows using ctx.waitForEvent()
  pushHatchetEvent(correlationId, { action: normalizedAction, userId: "claude-user" }).catch(() => {});
}

// ── Server startup ────────────────────────────────────────────────────────────

export function startWebhookServer(port = DEFAULT_PORT, mcpHandler?: McpHandler): void {
  const server = createServer((req, res) => {
    handleRequest(req, res, port, mcpHandler).catch((err) => {
      console.error("Webhook handler error:", err);
      if (!res.headersSent) {
        sendJson(res, 500, { error: "Internal server error" });
      }
    });
  });

  server.listen(port, () => {
    console.error(`Webhook server listening on http://localhost:${port}`);
    console.error(`  Landing page:    http://localhost:${port}/`);
    console.error(`  Trigger webhook: POST http://localhost:${port}/webhook/<workflow_id>`);
  });

  server.on("error", (err) => {
    console.error("Webhook server error:", err);
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
      console.error(`\nPort ${port} is already in use. Kill the existing process first:\n  powershell -Command "Stop-Process -Id (Get-NetTCPConnection -LocalPort ${port} -State Listen).OwningProcess -Force"\n`);
      process.exit(1);
    }
  });
}
