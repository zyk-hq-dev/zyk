"use client";

import Link from "next/link";
import { initAnalytics } from "@/lib/analytics";
import { useConsent } from "@/hooks/useConsent";

export default function ConsentBanner() {
  const { consent, accept, decline } = useConsent();

  if (consent !== null) return null;

  const handleAccept = () => {
    accept();
    initAnalytics();
  };

  return (
    <div
      style={{
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 50,
        borderTop: "1px solid var(--border)",
        background: "#111113",
        padding: "16px 16px 32px",
      }}
    >
      <div
        style={{
          maxWidth: "900px",
          margin: "0 auto",
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "12px",
          flexWrap: "wrap",
        }}
      >
        <p style={{ fontSize: "13px", color: "var(--text-muted)", margin: 0 }}>
          We use anonymous analytics and session recordings (PostHog) to understand how Zyk is used.
          No personal data or IP addresses are stored.{" "}
          <Link
            href="/privacy"
            style={{ color: "var(--text)", textDecoration: "underline", textUnderlineOffset: "2px" }}
          >
            Privacy policy
          </Link>
        </p>
        <div style={{ display: "flex", gap: "8px", flexShrink: 0 }}>
          <button
            onClick={decline}
            style={{
              padding: "5px 12px",
              borderRadius: "5px",
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--text-muted)",
              fontSize: "13px",
              cursor: "pointer",
              fontFamily: "var(--font-sans)",
            }}
          >
            Decline
          </button>
          <button
            onClick={handleAccept}
            style={{
              padding: "5px 12px",
              borderRadius: "5px",
              border: "none",
              background: "#4f46e5",
              color: "#fff",
              fontSize: "13px",
              cursor: "pointer",
              fontFamily: "var(--font-sans)",
            }}
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}
