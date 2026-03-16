"use client";

import { useState, useEffect } from "react";

const CONSENT_KEY = "zyk_analytics_consent";

export type ConsentState = "accepted" | "declined" | null;

export function getStoredConsent(): ConsentState {
  if (typeof window === "undefined") return null;
  return (localStorage.getItem(CONSENT_KEY) as ConsentState) ?? null;
}

export function useConsent() {
  // Start null so server and client render the same initial HTML (no hydration mismatch).
  // Read localStorage only after mount.
  const [consent, setConsent] = useState<ConsentState>(null);

  useEffect(() => {
    setConsent(getStoredConsent());
  }, []);

  const accept = () => {
    localStorage.setItem(CONSENT_KEY, "accepted");
    setConsent("accepted");
  };

  const decline = () => {
    localStorage.setItem(CONSENT_KEY, "declined");
    setConsent("declined");
  };

  return { consent, accept, decline };
}
