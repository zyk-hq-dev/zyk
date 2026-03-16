import Link from "next/link";

export default function PrivacyPage() {
  return (
    <div style={{ maxWidth: "672px", margin: "0 auto", padding: "48px 24px" }}>
      <Link
        href="/"
        style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "13px", color: "var(--text-muted)", textDecoration: "none", marginBottom: "32px" }}
      >
        ← Back
      </Link>

      <h1 style={{ marginTop: "16px", fontSize: "24px", fontWeight: 600, color: "#fff" }}>Privacy Policy</h1>
      <p style={{ marginTop: "4px", fontSize: "13px", color: "var(--text-muted)" }}>Last updated: March 2026</p>

      <div style={{ marginTop: "32px", display: "flex", flexDirection: "column", gap: "24px", fontSize: "14px", lineHeight: 1.7, color: "var(--text-muted)" }}>
        <section>
          <h2 style={{ marginBottom: "8px", fontSize: "15px", fontWeight: 500, color: "#fff" }}>What we collect</h2>
          <p>
            Zyk uses{" "}
            <a href="https://posthog.com" target="_blank" rel="noopener noreferrer" style={{ color: "var(--text)", textDecoration: "underline", textUnderlineOffset: "2px" }}>
              PostHog
            </a>{" "}
            to collect anonymous usage data — specifically which features are used and how often. This includes session recordings (screen interactions, clicks, and scrolls) to help us understand how the playground is used and what to improve. No personal data is captured in recordings.
          </p>
        </section>

        <section>
          <h2 style={{ marginBottom: "8px", fontSize: "15px", fontWeight: 500, color: "#fff" }}>What we do not collect</h2>
          <ul style={{ margin: 0, paddingLeft: "20px", display: "flex", flexDirection: "column", gap: "4px" }}>
            <li>No names, email addresses, or any personally identifiable information</li>
            <li>No IP addresses (PostHog is configured to discard them)</li>
            <li>No workflow content or code you write in the playground</li>
          </ul>
        </section>

        <section>
          <h2 style={{ marginBottom: "8px", fontSize: "15px", fontWeight: 500, color: "#fff" }}>Cookies &amp; storage</h2>
          <p>
            If you accept analytics, PostHog stores a random anonymous ID in your browser (a cookie and localStorage entry) so it can count unique sessions. This ID is not linked to any personal data.
          </p>
          <p style={{ marginTop: "8px" }}>
            If you decline, no analytics cookies or tracking IDs are set.
          </p>
        </section>

        <section>
          <h2 style={{ marginBottom: "8px", fontSize: "15px", fontWeight: 500, color: "#fff" }}>Your choices</h2>
          <p>
            You can change your preference at any time by clearing your browser&apos;s localStorage for this site (DevTools → Application → Local Storage). Reloading the page will show the consent banner again.
          </p>
        </section>

        <section>
          <h2 style={{ marginBottom: "8px", fontSize: "15px", fontWeight: 500, color: "#fff" }}>Data controller</h2>
          <p>
            Analytics data is processed by PostHog Inc. under their{" "}
            <a href="https://posthog.com/privacy" target="_blank" rel="noopener noreferrer" style={{ color: "var(--text)", textDecoration: "underline", textUnderlineOffset: "2px" }}>
              Privacy Policy
            </a>
            .
          </p>
        </section>
      </div>
    </div>
  );
}
