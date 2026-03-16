"use client";

import { useEffect, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import Chat from "@/components/Chat";

export default function Home() {
  const [sessionId, setSessionId] = useState<string | null>(null);

  useEffect(() => {
    // Get or create a persistent session ID
    let id = localStorage.getItem("zyk-session-id");
    if (!id) {
      id = uuidv4();
      localStorage.setItem("zyk-session-id", id);
    }
    setSessionId(id);
  }, []);

  if (!sessionId) {
    return (
      <div
        style={{
          display: "flex",
          height: "100vh",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--bg)",
          color: "var(--text-muted)",
          fontSize: "14px",
        }}
      >
        Loading...
      </div>
    );
  }

  return <Chat sessionId={sessionId} />;
}
