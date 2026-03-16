import type { Metadata } from "next";
import Script from "next/script";
import ConsentBanner from "@/components/ConsentBanner";
import AnalyticsInit from "@/components/AnalyticsInit";
import "./globals.css";

export const metadata: Metadata = {
  title: "Zyk — Workflow Playground",
  description: "Describe a workflow, watch it build and run.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark" style={{ height: "100%" }}>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
        <Script
          src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"
          strategy="beforeInteractive"
        />
      </head>
      <body style={{ height: "100%", margin: 0 }}>
        <AnalyticsInit />
        {children}
        <ConsentBanner />
      </body>
    </html>
  );
}
