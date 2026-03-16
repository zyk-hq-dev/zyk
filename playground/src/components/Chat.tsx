"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type Anthropic from "@anthropic-ai/sdk";
import Message, { type MessageType } from "./Message";
import WorkflowCard, { type WorkflowInfo } from "./WorkflowCard";
import { track } from "@/lib/analytics";

interface Props {
  sessionId: string;
}

// Examples to seed the chat input on click
const EXAMPLES = [
  "Fetch all Star Wars films from the SWAPI API, ask me if I like each George Lucas film, log my answers, and summarize all my decisions at the end",
  "Fetch the top 5 AI news headlines and log the title and source for each",
  "Get the weather in Berlin and London — log which city is warmer and by how much",
  "Fetch the latest SpaceX launch, log the mission name, date, and whether it succeeded",
  "Ask me which city to check the weather for, then fetch and log a full weather report",
];

export default function Chat({ sessionId }: Props) {
  const [messages, setMessages] = useState<MessageType[]>([]);
  // History for the Anthropic API (role/content pairs)
  const [apiMessages, setApiMessages] = useState<Anthropic.MessageParam[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [workflowLogs, setWorkflowLogs] = useState<Map<string, string[]>>(new Map());
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [showExamples, setShowExamples] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputAreaRef = useRef<HTMLDivElement>(null);

  // Close examples popover when clicking outside the input area
  useEffect(() => {
    if (!showExamples) return;
    const handler = (e: MouseEvent) => {
      if (inputAreaRef.current && !inputAreaRef.current.contains(e.target as Node)) {
        setShowExamples(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showExamples]);

  // SSE connection for real-time workflow events
  useEffect(() => {
    const es = new EventSource(`/api/events?sessionId=${sessionId}`);

    // Workflow question from a running workflow — show InteractionPrompt in chat
    es.addEventListener("interaction_request", (e) => {
      const data = JSON.parse(e.data) as {
        correlationId: string;
        message: string;
        options?: string[];
      };
      setMessages((prev) => [
        ...prev,
        {
          role: "interaction",
          correlationId: data.correlationId,
          message: data.message,
          options: data.options,
        },
      ]);
    });

    // Live update: workflow registered while another chat branch added it —
    // or update_workflow changed the diagram. Update any matching WorkflowCard
    // already shown in the chat without duplicating it.
    const handleWorkflowEvent = (e: MessageEvent) => {
      const data = JSON.parse(e.data) as { workflow: WorkflowInfo };
      setSelectedWorkflowId(data.workflow.id);
      setMessages((prev) => {
        let found = false;
        const next = prev.map((m) => {
          if (m.role === "workflow" && m.workflow.id === data.workflow.id) {
            found = true;
            return { role: "workflow" as const, workflow: data.workflow };
          }
          return m;
        });
        if (!found) {
          next.push({ role: "workflow", workflow: data.workflow });
        }
        return next;
      });
    };

    es.addEventListener("workflow_registered", handleWorkflowEvent);
    es.addEventListener("workflow_updated", handleWorkflowEvent);

    // Workflow deleted — remove its card, select the previous one
    es.addEventListener("workflow_deleted", (e) => {
      const data = JSON.parse(e.data) as { workflowId: string };
      setMessages((prev) => {
        const next = prev.filter(
          (m) => !(m.role === "workflow" && m.workflow.id === data.workflowId)
        );
        setSelectedWorkflowId((sel) => {
          if (sel !== data.workflowId) return sel;
          const remaining = next.filter((m) => m.role === "workflow") as Extract<typeof next[0], { role: "workflow" }>[];
          return remaining.length > 0 ? remaining[remaining.length - 1].workflow.id : null;
        });
        return next;
      });
    });

    // Worker logs — route to the workflow card, not the chat
    es.addEventListener("worker_log", (e) => {
      const data = JSON.parse(e.data) as { workflowId: string; line: string };
      setWorkflowLogs((prev) => {
        const next = new Map(prev);
        const existing = next.get(data.workflowId) ?? [];
        next.set(data.workflowId, [...existing, data.line]);
        return next;
      });
    });

    return () => es.close();
  }, [sessionId]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }, [input]);

  const handleInteractionRespond = useCallback(
    (correlationId: string, action: string) => {
      // The InteractionPrompt component handles the actual HTTP call;
      // here we just add a visual acknowledgment to the chat
      setMessages((prev) =>
        prev.map((m) => {
          if (m.role === "interaction" && m.correlationId === correlationId) {
            // Keep the prompt visible but mark it as answered
            return m;
          }
          return m;
        })
      );
    },
    []
  );

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;

    setInput("");
    setLoading(true);
    track("message_sent");

    // Add user message to UI
    const userMsg: MessageType = { role: "user", content: text };
    setMessages((prev) => [...prev, userMsg]);

    // Build new API history
    const newApiMessages: Anthropic.MessageParam[] = [
      ...apiMessages,
      { role: "user", content: text },
    ];

    // Add placeholder for streaming assistant message
    const assistantMsgIdx = messages.length + 1; // after user message
    setMessages((prev) => [
      ...prev,
      { role: "assistant", content: "", streaming: true },
    ]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: newApiMessages,
          sessionId,
        }),
      });

      if (!res.ok || !res.body) {
        // Parse the NDJSON error body for a user-friendly message
        let errorMsg = `Request failed (${res.status})`;
        try {
          const text = await res.text();
          const parsed = JSON.parse(text.trim().split("\n")[0]);
          if (parsed?.error) errorMsg = parsed.error;
        } catch { /* ignore parse errors */ }
        throw new Error(errorMsg);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let assistantText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          let event: {
            type: string;
            text?: string;
            name?: string;
            id?: string;
            toolName?: string;
            toolUseId?: string;
            result?: unknown;
            error?: string;
          };
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }

          if (event.type === "text") {
            assistantText += event.text ?? "";
            setMessages((prev) => {
              const next = [...prev];
              // Find the streaming assistant message
              for (let i = next.length - 1; i >= 0; i--) {
                if (next[i].role === "assistant" && (next[i] as { streaming?: boolean }).streaming) {
                  next[i] = { role: "assistant", content: assistantText, streaming: true };
                  break;
                }
              }
              return next;
            });
          } else if (event.type === "tool_use") {
            // Show spinning indicator
            setMessages((prev) => [
              ...prev,
              { role: "tool_use", toolName: event.name ?? "tool" },
            ]);
          } else if (event.type === "tool_result") {
            // Remove spinning indicator
            setMessages((prev) =>
              prev.filter((m) => m.role !== "tool_use")
            );
            // Ensure the next text round starts on a new paragraph
            if (assistantText) assistantText += "\n\n";

            // If the tool created a workflow, show a WorkflowCard
            if (
              event.toolName === "create_workflow" ||
              event.toolName === "update_workflow"
            ) {
              const result = event.result as {
                success?: boolean;
                workflow_id?: string;
                name?: string;
                description?: string;
                trigger?: "on-demand" | "schedule";
                schedule?: string;
                diagram?: string;
                created_at?: string;
              };
              if (result?.success && result.workflow_id) {
                track("workflow_created", { name: result.name, trigger: result.trigger });
                setRightPanel("workflows");
                const wf: WorkflowInfo = {
                  id: result.workflow_id,
                  name: result.name ?? "",
                  description: result.description,
                  trigger: result.trigger ?? "on-demand",
                  schedule: result.schedule,
                  diagram: result.diagram,
                  createdAt: result.created_at ?? new Date().toISOString(),
                };
                setSelectedWorkflowId(wf.id);
                setMessages((prev) => {
                  // SSE workflow_registered may have already added this card
                  const exists = prev.some(
                    (m) => m.role === "workflow" && m.workflow.id === wf.id
                  );
                  return exists ? prev : [...prev, { role: "workflow", workflow: wf }];
                });
              }
            }
          } else if (event.type === "error") {
            setMessages((prev) => [
              ...prev,
              { role: "error", content: event.error ?? "An error occurred" },
            ]);
          } else if (event.type === "done") {
            // Finalize assistant message (stop streaming cursor)
            setMessages((prev) => {
              const next = [...prev];
              for (let i = next.length - 1; i >= 0; i--) {
                if (next[i].role === "assistant" && (next[i] as { streaming?: boolean }).streaming) {
                  next[i] = { role: "assistant", content: assistantText, streaming: false };
                  break;
                }
              }
              return next;
            });
          }
        }
      }

      // Update API history with the assistant's response
      const finalContent: Anthropic.ContentBlockParam[] = assistantText
        ? [{ type: "text", text: assistantText }]
        : [];

      setApiMessages([
        ...newApiMessages,
        { role: "assistant", content: finalContent },
      ]);
    } catch (err) {
      setMessages((prev) => {
        // Remove streaming placeholder
        const filtered = prev.filter(
          (m) => !(m.role === "assistant" && (m as { streaming?: boolean }).streaming)
        );
        return [
          ...filtered,
          {
            role: "error",
            content: `Failed to send message: ${err instanceof Error ? err.message : String(err)}`,
          },
        ];
      });
    } finally {
      setLoading(false);
      // Use requestAnimationFrame to avoid the linter warning about refs in effects
      requestAnimationFrame(() => textareaRef.current?.focus());
    }

    // Suppress warning — assistantMsgIdx used only for reference tracking
    void assistantMsgIdx;
  }, [input, loading, apiMessages, messages.length, sessionId]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const [rightPanel, setRightPanel] = useState<"workflows" | "resources">("workflows");
  const [resourcesSeen, setResourcesSeen] = useState(false);

  const chatMessages = messages.filter((m) => m.role !== "workflow");
  const workflowMessages = messages.filter(
    (m): m is Extract<MessageType, { role: "workflow" }> => m.role === "workflow"
  );
  const isEmpty = chatMessages.length === 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "var(--bg)" }}>
      {/* Header — full width */}
      <header
        style={{
          height: "48px",
          background: "var(--bg-secondary)",
          borderBottom: "1px solid var(--border)",
          padding: "0 20px",
          display: "flex",
          alignItems: "center",
          gap: "10px",
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: "16px", fontWeight: 700, color: "#FFB6D9", letterSpacing: "-0.02em" }}>
          Zyk
        </span>
        <span style={{ width: "1px", height: "16px", background: "var(--border)" }} />
        <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>Workflow Playground</span>
      </header>

      {/* Body — two panes */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>

        {/* ── Left: Chat ── */}
        <div style={{ display: "flex", flexDirection: "column", width: "42%", minWidth: "320px", borderRight: "1px solid var(--border)" }}>
          {/* Messages */}
          <div
            style={{
              flex: 1,
              overflowY: "auto",
              padding: isEmpty ? "0" : "20px 20px 8px",
              display: "flex",
              flexDirection: "column",
            }}
          >
            {isEmpty ? (
              <div
                style={{
                  flex: 1,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "16px",
                  padding: "40px 20px",
                }}
              >
                <div
                  style={{
                    width: "56px",
                    height: "56px",
                    borderRadius: "50%",
                    background: "linear-gradient(135deg, #FFB6D9 0%, #6366f1 100%)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "28px",
                    fontWeight: 700,
                    color: "#0a0a0b",
                  }}
                >
                  Z
                </div>
                <div style={{ textAlign: "center" }}>
                  <h1 style={{ margin: "0 0 8px", fontSize: "22px", fontWeight: 700, color: "var(--text)", letterSpacing: "-0.02em" }}>
                    Describe a workflow
                  </h1>
                  <p style={{ margin: 0, fontSize: "14px", color: "var(--text-muted)", maxWidth: "360px", lineHeight: 1.6 }}>
                    Real automation — not a chat session. Workflows run on{" "}
                    <a href="https://hatchet.run" target="_blank" rel="noopener noreferrer" style={{ color: "#818cf8", textDecoration: "none", borderBottom: "1px solid rgba(129,140,248,0.4)" }}>Hatchet</a>
                    , a durable workflow engine: persistent, scheduled, webhook-triggered, and retry-safe.
                  </p>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", justifyContent: "center", maxWidth: "420px" }}>
                  {EXAMPLES.map((ex) => (
                    <button
                      key={ex}
                      onClick={() => { setInput(ex); track("example_loaded", { example: ex }); }}
                      style={{
                        padding: "6px 14px",
                        borderRadius: "20px",
                        fontSize: "12px",
                        background: "var(--bg-secondary)",
                        color: "var(--text-secondary)",
                        border: "1px solid var(--border)",
                        cursor: "pointer",
                        fontFamily: "var(--font-sans)",
                      }}
                      onMouseEnter={(e) => {
                        (e.target as HTMLButtonElement).style.borderColor = "var(--accent)";
                        (e.target as HTMLButtonElement).style.color = "var(--accent-hover)";
                      }}
                      onMouseLeave={(e) => {
                        (e.target as HTMLButtonElement).style.borderColor = "var(--border)";
                        (e.target as HTMLButtonElement).style.color = "var(--text-secondary)";
                      }}
                    >
                      {ex}
                    </button>
                  ))}
                </div>

                {/* Human-in-the-loop hint */}
                <div style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: "8px",
                  padding: "10px 14px",
                  background: "rgba(99,102,241,0.06)",
                  border: "1px solid rgba(99,102,241,0.2)",
                  borderRadius: "8px",
                  maxWidth: "420px",
                  width: "100%",
                }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#818cf8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: "2px" }}>
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                    <circle cx="9" cy="7" r="4"/>
                    <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
                    <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
                  </svg>
                  <p style={{ margin: 0, fontSize: "12px", color: "var(--text-muted)", lineHeight: 1.6 }}>
                    <strong style={{ color: "#818cf8" }}>Human-in-the-loop:</strong> workflows can pause mid-run and ask you a question — approvals, choices, or free-text input. Your answer is passed directly into the next step.
                  </p>
                </div>

                {/* Available APIs */}
                <div style={{ width: "100%", maxWidth: "420px", borderTop: "1px solid var(--border)", paddingTop: "20px", display: "flex", flexDirection: "column", gap: "10px" }}>
                  <div style={{ fontSize: "11px", color: "var(--text-muted)", textAlign: "center", letterSpacing: "0.06em", textTransform: "uppercase" }}>
                    Pre-configured in this playground
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", justifyContent: "center" }}>
                    {[
                      "Tavily Search",
                      "OpenWeatherMap",
                      "NewsAPI",
                      "Any public API",
                    ].map((api) => (
                      <span
                        key={api}
                        style={{
                          padding: "3px 10px",
                          borderRadius: "4px",
                          fontSize: "11px",
                          fontFamily: "var(--font-mono)",
                          background: "rgba(99,102,241,0.08)",
                          color: "var(--text-muted)",
                          border: "1px solid rgba(99,102,241,0.15)",
                        }}
                      >
                        {api}
                      </span>
                    ))}
                  </div>
                  <p style={{ margin: 0, fontSize: "11px", color: "var(--text-muted)", textAlign: "center", lineHeight: 1.6, opacity: 0.6 }}>
                    In production, connect your own Slack, CRMs, databases, GitHub, and any other API your team uses.
                  </p>
                </div>
              </div>
            ) : (
              <>
                {chatMessages.map((msg, i) => (
                  <Message
                    key={i}
                    message={msg}
                    sessionId={sessionId}
                    onInteractionRespond={handleInteractionRespond}
                  />
                ))}
              </>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input area */}
          <div
            style={{
              padding: "12px 16px 16px",
              borderTop: isEmpty ? "none" : "1px solid var(--border)",
              flexShrink: 0,
              position: "relative",
            }}
            ref={inputAreaRef}
          >
          {/* Examples popover — shown when not in empty state and showExamples is true */}
          {!isEmpty && showExamples && (
            <div
              style={{
                position: "absolute",
                bottom: "calc(100% - 8px)",
                left: "16px",
                right: "16px",
                background: "var(--bg-secondary)",
                border: "1px solid var(--border)",
                borderRadius: "10px",
                padding: "12px",
                display: "flex",
                flexDirection: "column",
                gap: "6px",
                zIndex: 10,
                boxShadow: "0 -4px 16px rgba(0,0,0,0.3)",
              }}
            >
              <div style={{ fontSize: "11px", color: "var(--text-muted)", marginBottom: "2px", letterSpacing: "0.04em", textTransform: "uppercase" }}>
                Examples
              </div>
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  onClick={() => { setInput(ex); setShowExamples(false); textareaRef.current?.focus(); track("example_loaded", { example: ex }); }}
                  style={{
                    padding: "7px 10px",
                    borderRadius: "6px",
                    fontSize: "12px",
                    background: "var(--bg)",
                    color: "var(--text-secondary)",
                    border: "1px solid var(--border)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontFamily: "var(--font-sans)",
                    transition: "border-color 0.15s",
                  }}
                  onMouseEnter={(e) => { (e.currentTarget.style.borderColor = "var(--accent)"); (e.currentTarget.style.color = "var(--text)"); }}
                  onMouseLeave={(e) => { (e.currentTarget.style.borderColor = "var(--border)"); (e.currentTarget.style.color = "var(--text-secondary)"); }}
                >
                  {ex}
                </button>
              ))}
            </div>
          )}
        <div
          style={{
            display: "flex",
            gap: "10px",
            alignItems: "flex-end",
            background: "var(--bg-secondary)",
            border: "1px solid var(--border-light)",
            borderRadius: "12px",
            padding: "10px 12px",
          }}
        >
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Describe a workflow..."
            disabled={loading}
            rows={1}
            style={{
              flex: 1,
              background: "transparent",
              border: "none",
              outline: "none",
              resize: "none",
              color: "var(--text)",
              fontSize: "13px",
              fontFamily: "var(--font-sans)",
              lineHeight: 1.5,
              padding: "2px 0",
              maxHeight: "160px",
              overflow: "auto",
            }}
          />
          {!isEmpty && (
            <button
              onClick={() => setShowExamples((v) => !v)}
              title="Show examples"
              style={{
                height: "32px",
                padding: "0 10px",
                borderRadius: "8px",
                background: showExamples ? "var(--accent)" : "var(--bg-tertiary)",
                color: showExamples ? "#fff" : "var(--text-muted)",
                border: "none",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: "5px",
                flexShrink: 0,
                fontSize: "12px",
                fontFamily: "var(--font-sans)",
                transition: "background 0.15s, color 0.15s",
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              Examples
            </button>
          )}
          <button
            onClick={sendMessage}
            disabled={loading || !input.trim()}
            style={{
              width: "32px",
              height: "32px",
              borderRadius: "8px",
              background:
                loading || !input.trim() ? "var(--bg-tertiary)" : "var(--accent)",
              color: loading || !input.trim() ? "var(--text-muted)" : "#fff",
              border: "none",
              cursor: loading || !input.trim() ? "not-allowed" : "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              transition: "background 0.15s",
            }}
            aria-label="Send"
          >
            {loading ? (
              <div
                style={{
                  width: "14px",
                  height: "14px",
                  border: "2px solid var(--text-muted)",
                  borderTopColor: "transparent",
                  borderRadius: "50%",
                  animation: "spin 0.8s linear infinite",
                }}
              />
            ) : (
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            )}
          </button>
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: "6px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "5px", fontSize: "11px", color: "rgba(234,179,8,0.6)" }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/>
              <line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
            Don&apos;t include API keys, passwords, or other secrets
          </div>
          <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>
            Enter to send · Shift+Enter for new line
          </div>
        </div>
        </div>{/* end input area */}
        </div>{/* end left pane */}

        {/* ── Right: Workflows / Resources ── */}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            background: "var(--bg)",
          }}
        >
          {/* Top tab bar — always visible */}
          <div
            style={{
              display: "flex",
              borderBottom: "1px solid var(--border)",
              background: "var(--bg-secondary)",
              flexShrink: 0,
            }}
          >
            {/* Panel tabs */}
            {(["workflows", "resources"] as const).map((panel) => {
              const active = rightPanel === panel;
              return (
                <button
                  key={panel}
                  onClick={() => { setRightPanel(panel); track("tab_switched", { tab: panel }); if (panel === "resources") setResourcesSeen(true); }}
                  style={{
                    padding: "10px 18px",
                    fontSize: "12px",
                    fontWeight: active ? 600 : 400,
                    color: active ? "var(--text)" : "var(--text-muted)",
                    background: "transparent",
                    border: "none",
                    borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
                    cursor: "pointer",
                    fontFamily: "var(--font-sans)",
                    marginBottom: "-1px",
                    textTransform: "capitalize",
                  }}
                >
                  <span style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    {panel}
                    {panel === "resources" && !resourcesSeen && (
                      <span style={{
                        width: "6px", height: "6px", borderRadius: "50%",
                        background: "var(--accent)",
                        display: "inline-block",
                        animation: "pulse 1.5s ease-in-out infinite",
                      }} />
                    )}
                  </span>
                </button>
              );
            })}

            {/* Workflow tabs (inside "Workflows" panel, when multiple) */}
            {rightPanel === "workflows" && workflowMessages.length > 1 && (
              <>
                <div style={{ width: "1px", background: "var(--border)", margin: "8px 4px" }} />
                <div style={{ display: "flex", overflowX: "auto", flex: 1 }}>
                  {workflowMessages.map((msg) => {
                    const active = (selectedWorkflowId ?? workflowMessages[workflowMessages.length - 1].workflow.id) === msg.workflow.id;
                    return (
                      <button
                        key={msg.workflow.id}
                        onClick={() => setSelectedWorkflowId(msg.workflow.id)}
                        style={{
                          padding: "10px 14px",
                          fontSize: "11px",
                          fontWeight: active ? 600 : 400,
                          color: active ? "var(--text)" : "var(--text-muted)",
                          background: "transparent",
                          border: "none",
                          borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
                          cursor: "pointer",
                          whiteSpace: "nowrap",
                          fontFamily: "var(--font-mono)",
                          marginBottom: "-1px",
                        }}
                      >
                        {msg.workflow.name}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          {/* Panel content */}
          {rightPanel === "workflows" ? (
            workflowMessages.length === 0 ? (
              <div
                style={{
                  flex: 1,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "10px",
                  color: "var(--text-muted)",
                }}
              >
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.3 }}>
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <path d="M3 9h18M9 21V9" />
                </svg>
                <span style={{ fontSize: "12px", opacity: 0.5 }}>Workflows appear here</span>
              </div>
            ) : (
              (() => {
                const activeId = selectedWorkflowId ?? workflowMessages[workflowMessages.length - 1].workflow.id;
                const active = workflowMessages.find((m) => m.workflow.id === activeId) ?? workflowMessages[workflowMessages.length - 1];
                return (
                  <WorkflowCard
                    key={active.workflow.id}
                    workflow={active.workflow}
                    sessionId={sessionId}
                    logs={workflowLogs.get(active.workflow.id) ?? []}
                    fullHeight
                  />
                );
              })()
            )
          ) : (
            /* Resources panel */
            <div style={{ flex: 1, overflowY: "auto", padding: "20px" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: "24px", maxWidth: "560px" }}>

                {/* Commands */}
                <section>
                  <h2 style={{ margin: "0 0 12px", fontSize: "12px", fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                    Commands
                  </h2>
                  <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                    {[
                      { cmd: "List my workflows", desc: "Show all workflows in this session" },
                      { cmd: "List my runs", desc: "Show recent workflow executions" },
                      { cmd: "Delete all my workflows", desc: "Remove everything and start fresh" },
                      { cmd: "Delete workflow [name]", desc: "Remove a specific workflow by name" },
                      { cmd: "Run workflow [name]", desc: "Trigger a workflow manually" },
                    ].map(({ cmd, desc }) => (
                      <button
                        key={cmd}
                        onClick={() => setInput(cmd)}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "12px",
                          padding: "9px 12px",
                          background: "var(--bg-secondary)",
                          border: "1px solid var(--border)",
                          borderRadius: "6px",
                          cursor: "pointer",
                          textAlign: "left",
                          transition: "border-color 0.15s",
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--accent)")}
                        onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--border)")}
                      >
                        <span style={{ fontSize: "12px", fontFamily: "var(--font-mono)", color: "var(--text)", whiteSpace: "nowrap" }}>{cmd}</span>
                        <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>{desc}</span>
                      </button>
                    ))}
                  </div>
                </section>

                {/* Why this is different */}
                <section>
                  <h2 style={{ margin: "0 0 12px", fontSize: "12px", fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                    This isn&apos;t a chat session
                  </h2>
                  <div style={{
                    padding: "14px 16px",
                    background: "rgba(99,102,241,0.06)",
                    border: "1px solid rgba(99,102,241,0.2)",
                    borderRadius: "8px",
                    display: "flex",
                    flexDirection: "column",
                    gap: "10px",
                  }}>
                    {[
                      { icon: "⏱", text: "Keeps running after you close this tab — even for days" },
                      { icon: "📅", text: "Scheduled workflows fire on cron forever (e.g. every morning at 8am)" },
                      { icon: "🔁", text: "Tasks retry automatically on failure — no lost work" },
                      { icon: "🔗", text: "Trigger any workflow via webhook from external systems" },
                      { icon: "⚡", text: "Multi-step tasks run in parallel or in sequence, with state passed between them" },
                    ].map(({ icon, text }) => (
                      <div key={text} style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}>
                        <span style={{ fontSize: "13px", flexShrink: 0, marginTop: "1px" }}>{icon}</span>
                        <span style={{ fontSize: "12px", color: "var(--text-secondary)", lineHeight: 1.55 }}>{text}</span>
                      </div>
                    ))}
                  </div>
                </section>

                {/* Available APIs */}
                <section>
                  <h2 style={{ margin: "0 0 12px", fontSize: "12px", fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                    Pre-configured APIs
                  </h2>
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    {[
                      {
                        name: "Tavily Search",
                        env: "TAVILY_API_KEY",
                        desc: "Real-time web search optimized for LLMs. Great for research workflows.",
                        url: "https://docs.tavily.com",
                      },
                      {
                        name: "OpenWeatherMap",
                        env: "OPENWEATHERMAP_API_KEY",
                        desc: "Current weather, forecasts, and historical data by city or coordinates.",
                        url: "https://openweathermap.org/api",
                      },
                      {
                        name: "NewsAPI",
                        env: "NEWSAPI_API_KEY",
                        desc: "Search and filter news articles from thousands of sources.",
                        url: "https://newsapi.org/docs",
                      },

                    ].map((api) => (
                      <a
                        key={api.name}
                        href={api.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: "4px",
                          padding: "12px 14px",
                          background: "var(--bg-secondary)",
                          border: "1px solid var(--border)",
                          borderRadius: "8px",
                          textDecoration: "none",
                          color: "inherit",
                          transition: "border-color 0.15s",
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--accent)")}
                        onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--border)")}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--text)" }}>{api.name}</span>
                          <span style={{ fontSize: "10px", fontFamily: "var(--font-mono)", color: "var(--text-muted)", background: "rgba(99,102,241,0.08)", border: "1px solid rgba(99,102,241,0.15)", borderRadius: "3px", padding: "1px 5px" }}>
                            {api.env}
                          </span>
                          <svg style={{ marginLeft: "auto", opacity: 0.4 }} width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                            <polyline points="15 3 21 3 21 9" />
                            <line x1="10" y1="14" x2="21" y2="3" />
                          </svg>
                        </div>
                        <span style={{ fontSize: "12px", color: "var(--text-muted)", lineHeight: 1.5 }}>{api.desc}</span>
                      </a>
                    ))}
                  </div>
                </section>

                {/* Demo / public APIs */}
                <section>
                  <h2 style={{ margin: "0 0 12px", fontSize: "12px", fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                    Public APIs (no key needed)
                  </h2>
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    {[
                      {
                        name: "SWAPI",
                        desc: "Star Wars universe data — planets, starships, people. Great for demos.",
                        url: "https://swapi.info",
                      },
                      {
                        name: "Open Meteo",
                        desc: "Free weather API, no key required. Accurate forecasts worldwide.",
                        url: "https://open-meteo.com/en/docs",
                      },
                      {
                        name: "REST Countries",
                        desc: "Country data — population, capitals, currencies, flags.",
                        url: "https://restcountries.com",
                      },
                      {
                        name: "JSONPlaceholder",
                        desc: "Fake REST API for testing — posts, users, todos.",
                        url: "https://jsonplaceholder.typicode.com",
                      },
                    ].map((api) => (
                      <a
                        key={api.name}
                        href={api.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: "4px",
                          padding: "12px 14px",
                          background: "var(--bg-secondary)",
                          border: "1px solid var(--border)",
                          borderRadius: "8px",
                          textDecoration: "none",
                          color: "inherit",
                          transition: "border-color 0.15s",
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--accent)")}
                        onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--border)")}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--text)" }}>{api.name}</span>
                          <svg style={{ marginLeft: "auto", opacity: 0.4 }} width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                            <polyline points="15 3 21 3 21 9" />
                            <line x1="10" y1="14" x2="21" y2="3" />
                          </svg>
                        </div>
                        <span style={{ fontSize: "12px", color: "var(--text-muted)", lineHeight: 1.5 }}>{api.desc}</span>
                      </a>
                    ))}
                  </div>
                </section>

                {/* How to use */}
                <section>
                  <h2 style={{ margin: "0 0 12px", fontSize: "12px", fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                    How it works
                  </h2>
                  <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                    {[
                      { step: "1", text: "Describe a workflow in the chat — Claude writes the TypeScript code." },
                      { step: "2", text: "The workflow is deployed to Hatchet automatically. A live diagram appears on the left." },
                      { step: "3", text: "Click Run to execute it. Logs stream in real time below the diagram." },
                      { step: "4", text: "Claude can ask you questions mid-run — answer them directly in chat." },
                    ].map(({ step, text }) => (
                      <div key={step} style={{ display: "flex", gap: "12px", alignItems: "flex-start" }}>
                        <div style={{
                          width: "20px", height: "20px", borderRadius: "50%",
                          background: "rgba(99,102,241,0.12)", border: "1px solid rgba(99,102,241,0.25)",
                          display: "flex", alignItems: "center", justifyContent: "center",
                          fontSize: "10px", fontWeight: 700, color: "var(--accent)", flexShrink: 0,
                        }}>
                          {step}
                        </div>
                        <span style={{ fontSize: "13px", color: "var(--text-secondary)", lineHeight: 1.55 }}>{text}</span>
                      </div>
                    ))}
                  </div>
                </section>

                {/* Production callout */}
                <div style={{
                  padding: "14px 16px",
                  background: "rgba(99,102,241,0.06)",
                  border: "1px solid rgba(99,102,241,0.2)",
                  borderRadius: "8px",
                  fontSize: "12px",
                  color: "var(--text-muted)",
                  lineHeight: 1.6,
                }}>
                  <strong style={{ color: "var(--text)", display: "block", marginBottom: "4px" }}>Going to production?</strong>
                  Connect your own Slack, CRMs, databases, GitHub, and any other API — Zyk uses real TypeScript so if Claude knows the API, it works.
                </div>

                {/* Feedback */}
                <div style={{ textAlign: "center", paddingTop: "4px", paddingBottom: "8px" }}>
                  <a
                    href="mailto:hello@zyk.dev"
                    style={{ fontSize: "12px", color: "var(--text-muted)", textDecoration: "none" }}
                  >
                    Feedback? <span style={{ textDecoration: "underline", textUnderlineOffset: "2px" }}>hello@zyk.dev</span>
                  </a>
                </div>

              </div>
            </div>
          )}
        </div>

      </div>{/* end body */}
    </div>
  );
}
