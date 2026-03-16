#!/usr/bin/env node
/**
 * Zyk setup script
 * Detects your Claude install type, prompts for config values,
 * and writes the mcpServers entry to the correct config file.
 *
 * Usage: node setup.js   (or: npm run setup)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { createInterface } from "readline";
import { homedir } from "os";

// ── .env reader ───────────────────────────────────────────────────────────────
function readEnvFile(filePath) {
  if (!existsSync(filePath)) return {};
  const vars = {};
  for (const line of readFileSync(filePath, "utf-8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) vars[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return vars;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── ANSI colours ──────────────────────────────────────────────────────────────
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
};
const bold = (s) => `${c.bold}${s}${c.reset}`;
const dim = (s) => `${c.dim}${s}${c.reset}`;
const green = (s) => `${c.green}${s}${c.reset}`;
const yellow = (s) => `${c.yellow}${s}${c.reset}`;
const cyan = (s) => `${c.cyan}${s}${c.reset}`;
const red = (s) => `${c.red}${s}${c.reset}`;

// ── Config path detection ─────────────────────────────────────────────────────
function detectConfigPath() {
  const platform = process.platform;

  if (platform === "darwin") {
    return {
      path: join(
        homedir(),
        "Library",
        "Application Support",
        "Claude",
        "claude_desktop_config.json"
      ),
      label: "macOS",
    };
  }

  if (platform === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    const appData =
      process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");

    // Windows Store: check if the sandboxed package directory exists
    const storeDir = join(
      localAppData,
      "Packages",
      "Claude_pzs8sxrjxfjjc",
      "LocalCache",
      "Roaming",
      "Claude"
    );
    if (existsSync(storeDir)) {
      return {
        path: join(storeDir, "claude_desktop_config.json"),
        label: "Windows (Store)",
        note:
          "Claude is installed from the Microsoft Store.\n" +
          "  Its config lives in a sandboxed path — " +
          yellow("%APPDATA%\\Roaming\\Claude") +
          " would be ignored.",
      };
    }

    // Traditional .exe installer
    return {
      path: join(appData, "Roaming", "Claude", "claude_desktop_config.json"),
      label: "Windows (installer)",
    };
  }

  // Linux
  return {
    path: join(homedir(), ".config", "Claude", "claude_desktop_config.json"),
    label: "Linux",
  };
}

// ── Readline helpers ──────────────────────────────────────────────────────────
function prompt(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function promptWithDefault(rl, question, defaultValue) {
  const answer = await prompt(rl, `${question} ${dim(`[${defaultValue}]`)} `);
  return answer.trim() || defaultValue;
}

async function promptRequired(rl, question) {
  while (true) {
    const answer = await prompt(rl, question);
    if (answer.trim()) return answer.trim();
    console.log(yellow("  Required — please enter a value."));
  }
}

async function confirm(rl, question) {
  const answer = await prompt(rl, `${question} ${dim("[y/N]")} `);
  return answer.trim().toLowerCase() === "y";
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // --yes / -y: non-interactive mode (skip prompts, use defaults)
  const autoYes = process.argv.includes("--yes") || process.argv.includes("-y");
  console.log();
  console.log(bold("  ⚡ Zyk Setup"));
  console.log(dim("  Configures Claude to connect to your Zyk MCP server."));
  console.log();

  // ── 1. Detect config path ────────────────────────────────────────────────
  const { path: configPath, label, note } = detectConfigPath();

  console.log(`  ${bold("Claude install:")} ${cyan(label)}`);
  if (note) console.log(`  ${note}`);
  console.log(`  ${bold("Config path:")} ${dim(configPath)}`);
  console.log();

  // ── 2. Check dist/index.js exists ───────────────────────────────────────
  const serverPath = resolve(__dirname, "dist", "index.js");
  if (!existsSync(serverPath)) {
    console.log(
      red("  ✗ dist/index.js not found.") +
        " Run " +
        cyan("npm run build") +
        " first."
    );
    process.exit(1);
  }
  console.log(`  ${bold("MCP server:")} ${dim(serverPath)}`);
  console.log();

  // ── 3. Load token (env var → .env file → prompt) ─────────────────────────
  const rl = autoYes
    ? { question: (_, cb) => cb(""), close: () => {} }  // no-op readline in --yes mode
    : createInterface({ input: process.stdin, output: process.stdout });

  // Try environment variable first
  let token = process.env.HATCHET_CLIENT_TOKEN ?? "";
  let tokenSource = "environment";

  // Then try .env files (root dir or mcp-server dir)
  if (!token) {
    for (const envPath of [
      resolve(__dirname, "..", ".env"),  // root (when running from mcp-server/)
      resolve(__dirname, ".env"),        // same dir (when running from root)
    ]) {
      const vars = readEnvFile(envPath);
      if (vars.HATCHET_CLIENT_TOKEN && vars.HATCHET_CLIENT_TOKEN !== "your-token-here") {
        token = vars.HATCHET_CLIENT_TOKEN;
        tokenSource = envPath;
        break;
      }
    }
  }

  if (token) {
    const src = tokenSource === "environment" ? "environment variable" : dim(tokenSource);
    console.log(`  ${bold("HATCHET_CLIENT_TOKEN:")} ${dim(`found in ${src}`)}`);
    console.log();
  } else if (autoYes) {
    console.log(red("  ✗ HATCHET_CLIENT_TOKEN not found in environment or .env"));
    console.log(dim("  Run ./scripts/bootstrap.sh first to generate a token, or set it in .env"));
    process.exit(1);
  } else {
    console.log(
      `  ${bold("Hatchet API token")} — get one from the Hatchet dashboard at ${cyan("http://localhost:8888")}`
    );
    console.log(
      dim("  (Settings → API Tokens, or run: ./scripts/bootstrap.sh to generate automatically)")
    );
    console.log();
    token = await promptRequired(
      rl,
      `  Enter your ${bold("HATCHET_CLIENT_TOKEN")}: `
    );
    console.log();
  }

  // Try .env for the gRPC host too
  let defaultHatchetHost = "localhost:7077";
  for (const envPath of [resolve(__dirname, "..", ".env"), resolve(__dirname, ".env")]) {
    const vars = readEnvFile(envPath);
    if (vars.HATCHET_HOST_PORT) { defaultHatchetHost = vars.HATCHET_HOST_PORT; break; }
  }

  const hatchetHost = autoYes
    ? defaultHatchetHost
    : await promptWithDefault(rl, `  Hatchet gRPC address ${bold("HATCHET_HOST_PORT")}:`, defaultHatchetHost);
  if (!autoYes) console.log();

  // ── 4. Read existing config and merge ────────────────────────────────────
  let existing = {};
  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      console.log(
        yellow("  Warning: existing config is not valid JSON — will overwrite.")
      );
    }
  }

  // Detect if running from a global npm install (no local dist next to a repo)
  // If so, generate an `npx -y zyk-mcp` command instead of an absolute path.
  const isGlobalInstall = serverPath.includes("node_modules") &&
    !existsSync(resolve(__dirname, "..", ".git"));

  const zykEntry = isGlobalInstall
    ? {
        command: "npx",
        args: ["-y", "zyk-mcp"],
        env: {
          HATCHET_CLIENT_TOKEN: token,
          HATCHET_CLIENT_HOST_PORT: hatchetHost,
          HATCHET_CLIENT_TLS_STRATEGY: "none",
        },
      }
    : {
        command: "node",
        args: [serverPath],
        env: {
          HATCHET_CLIENT_TOKEN: token,
          HATCHET_CLIENT_HOST_PORT: hatchetHost,
          HATCHET_CLIENT_TLS_STRATEGY: "none",
        },
      };

  const updated = {
    ...existing,
    mcpServers: {
      ...(existing.mcpServers ?? {}),
      zyk: zykEntry,
    },
  };

  // ── 5. Preview ───────────────────────────────────────────────────────────
  const preview = JSON.stringify(updated, null, 2);
  console.log(dim("  ┌─ Will write to config ─────────────────────────────────"));
  for (const line of preview.split("\n")) {
    console.log(dim("  │ ") + line);
  }
  console.log(dim("  └────────────────────────────────────────────────────────"));
  console.log();

  const ok = autoYes ? true : await confirm(rl, "  Write this config?");
  rl.close();

  if (!ok) {
    console.log(dim("  Aborted — nothing written."));
    console.log();
    process.exit(0);
  }

  // ── 6. Write ─────────────────────────────────────────────────────────────
  const dir = dirname(configPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(updated, null, 2) + "\n", "utf-8");

  console.log();
  console.log(green("  ✓ Config written."));
  console.log();
  console.log(bold("  Next steps:"));
  console.log("  1. " + bold("Fully quit Claude") + dim(" (tray icon → Quit, not just close the window)"));
  console.log("  2. Reopen Claude");
  console.log("  3. Ask Claude: " + cyan('"List my workflows"'));
  console.log(
    dim('     You should see: "No workflows registered yet."')
  );
  console.log();
}

main().catch((err) => {
  console.error(red("  Fatal: ") + err.message);
  process.exit(1);
});
