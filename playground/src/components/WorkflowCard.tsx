"use client";

import { useEffect, useRef, useState } from "react";


export interface WorkflowInfo {
  id: string;
  name: string;
  description?: string;
  trigger: "on-demand" | "schedule";
  schedule?: string;
  diagram?: string;
  createdAt: string;
}

interface Props {
  workflow: WorkflowInfo;
  sessionId: string;
  logs?: string[];
  fullHeight?: boolean;
}

export default function WorkflowCard({ workflow, sessionId, logs = [], fullHeight = false }: Props) {
  const diagramWrapRef = useRef<HTMLDivElement>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<string | null>(null);

  // Render mermaid diagram + attach zoom/pan (mirrors existing dashboard)
  useEffect(() => {
    if (!workflow.diagram || !diagramWrapRef.current) return;
    const wrap = diagramWrapRef.current;

    const render = async () => {
      try {
        // @ts-expect-error mermaid loaded via CDN script tag in layout
        const mermaid = window.mermaid;
        if (!mermaid) return;

        mermaid.initialize({
          startOnLoad: false,
          theme: "dark",
          themeVariables: {
            background: "#0a0a0b",
            primaryColor: "#1e1b4b",
            primaryTextColor: "#e4e4e7",
            primaryBorderColor: "#6366f1",
            lineColor: "#52525b",
            secondaryColor: "#1a1a1d",
            tertiaryColor: "#111113",
            edgeLabelBackground: "#111113",
            fontFamily: '"Inter", system-ui, sans-serif',
            fontSize: "13px",
          },
          flowchart: { curve: "basis", padding: 20, useMaxWidth: true },
        });

        const id = `mermaid-${workflow.id}-${Date.now()}`;
        const { svg } = await mermaid.render(id, workflow.diagram);

        // Clear previous content (controls + old svg)
        wrap.innerHTML = svg;

        initDiagramZoom(wrap);
      } catch {
        wrap.innerHTML =
          '<span style="color:var(--text-muted);font-size:12px;">⚠ Could not render diagram</span>';
      }
    };

    render();
  }, [workflow.diagram, workflow.id]);

  // Auto-scroll logs to bottom when new lines arrive
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const handleRun = async () => {
    setRunning(true);
    setRunResult(null);
    try {
      const res = await fetch("/api/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow_id: workflow.id, session_id: sessionId }),
      });
      if (res.ok) {
        const data = (await res.json()) as { run_id?: string };
        setRunResult(`Started: ${data.run_id ?? "ok"}`);
      } else {
        setRunResult("Failed to start run");
      }
    } catch {
      setRunResult("Error starting run");
    } finally {
      setRunning(false);
      setTimeout(() => setRunResult(null), 5000);
    }
  };

  const triggerBadgeColor =
    workflow.trigger === "schedule" ? "rgba(34,197,94,.1)" : "rgba(99,102,241,.1)";
  const triggerTextColor = workflow.trigger === "schedule" ? "#22c55e" : "#818cf8";

  return (
    <div
      style={{
        background: "var(--bg-secondary)",
        border: fullHeight ? "none" : "1px solid var(--border)",
        borderRadius: fullHeight ? "0" : "8px",
        overflow: "hidden",
        marginTop: fullHeight ? "0" : "8px",
        flexShrink: fullHeight ? undefined : 0,
        display: fullHeight ? "flex" : undefined,
        flexDirection: fullHeight ? "column" : undefined,
        flex: fullHeight ? 1 : undefined,
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "12px 14px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "flex-start",
          gap: "10px",
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontWeight: 600,
              color: "var(--text)",
              fontSize: "14px",
              marginBottom: "2px",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {workflow.name}
          </div>
          <div
            style={{
              fontSize: "11px",
              color: "var(--text-muted)",
              fontFamily: "var(--font-mono)",
            }}
          >
            {workflow.id}
          </div>
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: "4px",
          }}
        >
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "2px 8px",
              borderRadius: "9999px",
              fontSize: "11px",
              fontWeight: 500,
              background: triggerBadgeColor,
              color: triggerTextColor,
            }}
          >
            {workflow.trigger}
            {workflow.schedule ? ` · ${workflow.schedule}` : ""}
          </span>
          {workflow.trigger === "on-demand" && (
            <button
              onClick={handleRun}
              disabled={running}
              style={{
                padding: "3px 10px",
                borderRadius: "5px",
                fontSize: "11px",
                fontWeight: 500,
                background: running ? "var(--bg-tertiary)" : "var(--accent)",
                color: running ? "var(--text-muted)" : "#fff",
                border: "none",
                cursor: running ? "not-allowed" : "pointer",
                fontFamily: "var(--font-sans)",
              }}
            >
              {running ? "Running..." : "Run"}
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      <div style={{ padding: fullHeight ? "0" : "12px 14px", display: fullHeight ? "flex" : undefined, flexDirection: fullHeight ? "column" : undefined, flex: fullHeight ? 1 : undefined, overflow: fullHeight ? "hidden" : undefined }}>
        {workflow.description && (
          <p
            style={{
              fontSize: "12px",
              color: "var(--text-muted)",
              margin: fullHeight ? "0" : "0 0 10px",
              lineHeight: 1.5,
              padding: fullHeight ? "8px 14px 0" : "0",
              flexShrink: 0,
            }}
          >
            {workflow.description}
          </p>
        )}

        {/* Diagram with zoom/pan wrapper — matches existing dashboard */}
        {workflow.diagram ? (
          <div
            ref={diagramWrapRef}
            style={{
              background: "var(--bg)",
              border: fullHeight ? "none" : "1px solid var(--border)",
              borderTop: fullHeight && workflow.description ? "none" : undefined,
              borderRadius: fullHeight ? "0" : "6px",
              overflow: "hidden",
              position: "relative",
              height: fullHeight ? undefined : "380px",
              flex: fullHeight ? 1 : undefined,
              marginTop: fullHeight ? "8px" : undefined,
              cursor: "grab",
            }}
          />
        ) : (
          <div
            style={{
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: "6px",
              minHeight: "60px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "12px",
              color: "var(--border-light)",
            }}
          >
            No diagram
          </div>
        )}

        {runResult && (
          <div
            style={{
              marginTop: "8px",
              fontSize: "12px",
              color: runResult.startsWith("Started") ? "var(--success)" : "var(--error)",
            }}
          >
            {runResult}
          </div>
        )}
      </div>

      {/* Logs panel — always visible */}
      <div
        style={{
          borderTop: "1px solid var(--border)",
          background: "var(--bg)",
          height: "260px",
          overflowY: "auto",
          padding: "8px 14px",
        }}
      >
        {logs.length === 0 ? (
          <div style={{ fontFamily: "var(--font-mono)", fontSize: "13px", color: "var(--text-muted)", opacity: 0.4, paddingTop: "2px" }}>
            Waiting for logs...
          </div>
        ) : (
          logs.map((line, i) => {
            const isTask = /^\[.+\]$/.test(line);
            const isError = line.startsWith("FAILED:");
            return (
              <div
                key={i}
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "13px",
                  lineHeight: 1.5,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                  color: isError ? "var(--error)" : isTask ? "var(--text)" : "var(--text-muted)",
                  fontWeight: isTask ? 600 : 400,
                  paddingTop: isTask ? "6px" : "0",
                }}
              >
                {line}
              </div>
            );
          })
        )}
        <div ref={logsEndRef} />
      </div>
    </div>
  );
}

// ── Zoom / pan — ported directly from the existing dashboard (webhook.ts) ──────

function initDiagramZoom(wrap: HTMLDivElement) {
  const svg = wrap.querySelector("svg") as SVGElement | null;
  if (!svg) return;

  wrap.style.display = "block";
  svg.style.transformOrigin = "0 0";
  svg.style.display = "block";
  svg.style.userSelect = "none";

  let s = 1, x = 0, y = 0;
  let defaultX = 0, defaultY = 0;

  function apply() {
    svg!.style.transform = `translate(${x}px,${y}px) scale(${s})`;
  }

  // Center the diagram once it's been painted
  requestAnimationFrame(() => {
    const wr = wrap.getBoundingClientRect();
    const sr = svg!.getBoundingClientRect();
    if (wr.width > 0 && sr.width > 0) {
      defaultX = Math.max(0, (wr.width - sr.width) / 2);
      defaultY = Math.max(0, (wr.height - sr.height) / 2);
      x = defaultX;
      y = defaultY;
      apply();
    }
  });

  function zoomAt(cx: number, cy: number, factor: number) {
    const ns = Math.max(0.15, Math.min(6, s * factor));
    x = cx - (cx - x) * (ns / s);
    y = cy - (cy - y) * (ns / s);
    s = ns;
    apply();
  }

  // Scroll to zoom (toward cursor)
  wrap.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const r = wrap.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.15 : 0.87);
    },
    { passive: false }
  );

  // Drag to pan
  wrap.addEventListener("mousedown", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest(".diagram-controls")) return;
    const sx = e.clientX, sy = e.clientY, tx0 = x, ty0 = y;
    wrap.style.cursor = "grabbing";
    e.preventDefault();
    const onMove = (e: MouseEvent) => {
      x = tx0 + e.clientX - sx;
      y = ty0 + e.clientY - sy;
      apply();
    };
    const onUp = () => {
      wrap.style.cursor = "grab";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  // Double-click to reset
  wrap.addEventListener("dblclick", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest(".diagram-controls")) return;
    s = 1; x = defaultX; y = defaultY; apply();
  });

  // +/−/↺ control buttons
  const ctrl = document.createElement("div");
  ctrl.className = "diagram-controls";
  ctrl.style.cssText =
    "position:absolute;top:6px;right:6px;display:flex;gap:2px;opacity:0;transition:opacity .15s;z-index:2;";
  ctrl.innerHTML =
    '<button title="Zoom in">+</button>' +
    '<button title="Zoom out">−</button>' +
    '<button title="Reset (or double-click)">↺</button>';
  wrap.appendChild(ctrl);

  // Show controls on hover
  wrap.addEventListener("mouseenter", () => (ctrl.style.opacity = "1"));
  wrap.addEventListener("mouseleave", () => (ctrl.style.opacity = "0"));

  // Style each button
  ctrl.querySelectorAll("button").forEach((btn) => {
    Object.assign((btn as HTMLButtonElement).style, {
      width: "22px",
      height: "22px",
      border: "1px solid var(--border-light)",
      background: "var(--bg-secondary)",
      color: "var(--text-muted)",
      borderRadius: "4px",
      cursor: "pointer",
      fontSize: "13px",
      padding: "0",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontFamily: "var(--font-sans)",
    });
    btn.addEventListener("mouseenter", () => {
      (btn as HTMLButtonElement).style.background = "var(--border)";
      (btn as HTMLButtonElement).style.color = "var(--text)";
    });
    btn.addEventListener("mouseleave", () => {
      (btn as HTMLButtonElement).style.background = "var(--bg-secondary)";
      (btn as HTMLButtonElement).style.color = "var(--text-muted)";
    });
  });

  const [btnIn, btnOut, btnReset] = ctrl.querySelectorAll("button");
  const center = () => {
    const r = wrap.getBoundingClientRect();
    return [r.width / 2, r.height / 2] as [number, number];
  };
  btnIn.addEventListener("click", () => { const [cx, cy] = center(); zoomAt(cx, cy, 1.3); });
  btnOut.addEventListener("click", () => { const [cx, cy] = center(); zoomAt(cx, cy, 0.77); });
  btnReset.addEventListener("click", () => { s = 1; x = defaultX; y = defaultY; apply(); });
}
