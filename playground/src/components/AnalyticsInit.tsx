"use client";

import { useEffect } from "react";
import { initAnalytics } from "@/lib/analytics";
import { getStoredConsent } from "@/hooks/useConsent";

export default function AnalyticsInit() {
  useEffect(() => {
    if (getStoredConsent() === "accepted") {
      initAnalytics();
    }
  }, []);
  return null;
}
