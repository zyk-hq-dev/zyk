import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: "#0a0a0b",
        "bg-secondary": "#111113",
        "bg-tertiary": "#1a1a1d",
        border: "#27272a",
        "border-light": "#3f3f46",
        text: "#fafafa",
        "text-secondary": "#a1a1aa",
        "text-muted": "#71717a",
        accent: "#6366f1",
        "accent-hover": "#818cf8",
        success: "#22c55e",
        error: "#ef4444",
        warning: "#f59e0b",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "-apple-system", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
