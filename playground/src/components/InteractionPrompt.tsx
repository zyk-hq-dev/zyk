"use client";

import { useState } from "react";

interface Props {
  correlationId: string;
  message: string;
  options?: string[];
  onRespond: (correlationId: string, action: string) => void;
}

export default function InteractionPrompt({
  correlationId,
  message,
  options,
  onRespond,
}: Props) {
  const [textInput, setTextInput] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [submittedValue, setSubmittedValue] = useState<string | null>(null);

  const submit = async (action: string) => {
    if (submitted) return;
    setSubmitted(true);
    setSubmittedValue(action);

    try {
      await fetch(`/api/interact/respond/${encodeURIComponent(correlationId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      onRespond(correlationId, action);
    } catch {
      setSubmitted(false);
      setSubmittedValue(null);
    }
  };

  return (
    <div
      style={{
        background: "rgba(99,102,241,0.08)",
        border: "1px solid rgba(99,102,241,0.3)",
        borderRadius: "8px",
        padding: "12px 14px",
        marginTop: "8px",
      }}
    >
      <div
        style={{
          fontSize: "11px",
          color: "var(--accent-hover)",
          fontWeight: 500,
          marginBottom: "6px",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}
      >
        Workflow is asking
      </div>
      <p
        style={{
          fontSize: "13px",
          color: "var(--text-secondary)",
          margin: "0 0 10px",
          lineHeight: 1.5,
        }}
      >
        {message}
      </p>

      {submitted ? (
        <div
          style={{
            fontSize: "12px",
            color: "var(--success)",
            display: "flex",
            alignItems: "center",
            gap: "6px",
          }}
        >
          <span>✓</span>
          <span>Responded: {submittedValue}</span>
        </div>
      ) : options && options.length > 0 ? (
        // Option buttons
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
          {options.map((opt) => (
            <button
              key={opt}
              onClick={() => submit(opt)}
              style={{
                padding: "5px 14px",
                borderRadius: "6px",
                fontSize: "12px",
                fontWeight: 500,
                background: "var(--bg-secondary)",
                color: "var(--text-secondary)",
                border: "1px solid var(--border-light)",
                cursor: "pointer",
                fontFamily: "var(--font-sans)",
                transition: "background 0.15s, color 0.15s",
              }}
              onMouseEnter={(e) => {
                (e.target as HTMLButtonElement).style.background =
                  "var(--accent)";
                (e.target as HTMLButtonElement).style.color = "#fff";
                (e.target as HTMLButtonElement).style.borderColor =
                  "var(--accent)";
              }}
              onMouseLeave={(e) => {
                (e.target as HTMLButtonElement).style.background =
                  "var(--bg-secondary)";
                (e.target as HTMLButtonElement).style.color =
                  "var(--text-secondary)";
                (e.target as HTMLButtonElement).style.borderColor =
                  "var(--border-light)";
              }}
            >
              {opt}
            </button>
          ))}
        </div>
      ) : (
        // Free-text input
        <div style={{ display: "flex", gap: "8px" }}>
          <input
            type="text"
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && textInput.trim()) submit(textInput.trim());
            }}
            placeholder="Type your answer..."
            style={{
              flex: 1,
              padding: "6px 10px",
              borderRadius: "6px",
              border: "1px solid var(--border-light)",
              background: "var(--bg-tertiary)",
              color: "var(--text)",
              fontSize: "13px",
              fontFamily: "var(--font-sans)",
              outline: "none",
            }}
          />
          <button
            onClick={() => textInput.trim() && submit(textInput.trim())}
            style={{
              padding: "6px 14px",
              borderRadius: "6px",
              fontSize: "12px",
              fontWeight: 500,
              background: "var(--accent)",
              color: "#fff",
              border: "none",
              cursor: "pointer",
              fontFamily: "var(--font-sans)",
            }}
          >
            Send
          </button>
        </div>
      )}
    </div>
  );
}
