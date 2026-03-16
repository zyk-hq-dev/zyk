"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import WorkflowCard, { type WorkflowInfo } from "./WorkflowCard";
import InteractionPrompt from "./InteractionPrompt";

export type MessageType =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; streaming?: boolean }
  | { role: "workflow"; workflow: WorkflowInfo }
  | {
      role: "interaction";
      correlationId: string;
      message: string;
      options?: string[];
    }
  | { role: "tool_use"; toolName: string }
  | { role: "error"; content: string };

interface Props {
  message: MessageType;
  sessionId: string;
  onInteractionRespond: (correlationId: string, action: string) => void;
}

export default function Message({ message, sessionId, onInteractionRespond }: Props) {
  if (message.role === "user") {
    return (
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          marginBottom: "12px",
        }}
      >
        <div
          style={{
            maxWidth: "72%",
            padding: "10px 14px",
            borderRadius: "12px 12px 2px 12px",
            background: "var(--accent)",
            color: "#fff",
            fontSize: "13px",
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {message.content}
        </div>
      </div>
    );
  }

  if (message.role === "assistant") {
    return (
      <div style={{ marginBottom: "12px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: "10px",
          }}
        >
          {/* Avatar */}
          <div
            style={{
              width: "26px",
              height: "26px",
              borderRadius: "50%",
              background: "linear-gradient(135deg, #FFB6D9 0%, #6366f1 100%)",
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "13px",
              fontWeight: 700,
              color: "#0a0a0b",
              marginTop: "1px",
            }}
          >
            Z
          </div>
          <div
            style={{
              flex: 1,
              fontSize: "13px",
              color: "var(--text-secondary)",
              lineHeight: 1.6,
              wordBreak: "break-word",
            }}
          >
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                p: ({ children }) => <p style={{ margin: "0 0 6px" }}>{children}</p>,
                strong: ({ children }) => <strong style={{ color: "var(--text)", fontWeight: 600 }}>{children}</strong>,
                em: ({ children }) => <em>{children}</em>,
                code: ({ children, className }) =>
                  className ? (
                    <pre style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "6px", padding: "10px 12px", overflowX: "auto", margin: "6px 0", fontSize: "12px", fontFamily: "var(--font-mono)" }}>
                      <code>{children}</code>
                    </pre>
                  ) : (
                    <code style={{ fontFamily: "var(--font-mono)", fontSize: "0.85em", background: "rgba(99,102,241,0.12)", borderRadius: "3px", padding: "1px 4px" }}>{children}</code>
                  ),
                ul: ({ children }) => <ul style={{ margin: "4px 0", paddingLeft: "18px" }}>{children}</ul>,
                ol: ({ children }) => <ol style={{ margin: "4px 0", paddingLeft: "18px" }}>{children}</ol>,
                li: ({ children }) => <li style={{ margin: "2px 0" }}>{children}</li>,
                table: ({ children }) => (
                  <div style={{ overflowX: "auto", margin: "8px 0" }}>
                    <table style={{ borderCollapse: "collapse", fontSize: "12px", width: "100%" }}>{children}</table>
                  </div>
                ),
                th: ({ children }) => <th style={{ border: "1px solid var(--border)", padding: "5px 10px", background: "var(--bg)", color: "var(--text)", fontWeight: 600, textAlign: "left" }}>{children}</th>,
                td: ({ children }) => <td style={{ border: "1px solid var(--border)", padding: "5px 10px", color: "var(--text-secondary)" }}>{children}</td>,
                h1: ({ children }) => <h1 style={{ fontSize: "16px", fontWeight: 700, margin: "8px 0 4px", color: "var(--text)" }}>{children}</h1>,
                h2: ({ children }) => <h2 style={{ fontSize: "14px", fontWeight: 600, margin: "8px 0 4px", color: "var(--text)" }}>{children}</h2>,
                h3: ({ children }) => <h3 style={{ fontSize: "13px", fontWeight: 600, margin: "6px 0 3px", color: "var(--text)" }}>{children}</h3>,
              }}
            >
              {message.content}
            </ReactMarkdown>
            {message.streaming && (
              <span
                style={{
                  display: "inline-block",
                  width: "2px",
                  height: "14px",
                  background: "var(--accent)",
                  marginLeft: "2px",
                  verticalAlign: "text-bottom",
                  animation: "blink 1s step-end infinite",
                }}
              />
            )}
          </div>
        </div>
        <style>{`@keyframes blink { 0%,100% { opacity:1 } 50% { opacity:0 } }`}</style>
      </div>
    );
  }

  if (message.role === "workflow") {
    return (
      <div style={{ marginBottom: "12px" }}>
        <WorkflowCard workflow={message.workflow} sessionId={sessionId} />
      </div>
    );
  }

  if (message.role === "interaction") {
    return (
      <div style={{ marginBottom: "12px" }}>
        <InteractionPrompt
          correlationId={message.correlationId}
          message={message.message}
          options={message.options}
          onRespond={onInteractionRespond}
        />
      </div>
    );
  }

  if (message.role === "tool_use") {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          padding: "6px 0",
          marginBottom: "6px",
        }}
      >
        <div
          style={{
            width: "14px",
            height: "14px",
            border: "2px solid var(--accent)",
            borderTopColor: "transparent",
            borderRadius: "50%",
            animation: "spin 0.8s linear infinite",
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontSize: "11px",
            color: "var(--text-muted)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {message.toolName}...
        </span>
        <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
      </div>
    );
  }

  if (message.role === "error") {
    return (
      <div
        style={{
          padding: "10px 14px",
          borderRadius: "6px",
          background: "rgba(239,68,68,0.1)",
          border: "1px solid rgba(239,68,68,0.3)",
          color: "var(--error)",
          fontSize: "12px",
          marginBottom: "12px",
        }}
      >
        {message.content}
      </div>
    );
  }

  return null;
}
