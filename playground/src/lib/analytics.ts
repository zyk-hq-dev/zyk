import posthog from "posthog-js";

const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;

let initialized = false;

export function initAnalytics() {
  if (!key || initialized || typeof window === "undefined") return;
  initialized = true;
  posthog.init(key, {
    api_host: "https://us.i.posthog.com",
    person_profiles: "identified_only", // anonymous UUID per browser, no PII
    capture_pageview: true,
    autocapture: false,
  });
}

export function track(event: string, properties?: Record<string, unknown>) {
  if (!key || typeof window === "undefined") return;
  posthog.capture(event, properties);
}
