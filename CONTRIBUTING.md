# Contributing to Zyk

Thank you for your interest in contributing! This guide covers how to get a local development environment running and how to submit changes.

## Dev setup

### Prerequisites

- Node.js 20+
- Docker Desktop (for Hatchet + Postgres)
- A Slack app with `chat:write` scope (optional — for Slack workflows)

### 1. Clone and install

```bash
git clone https://github.com/zyk-hq/zyk.git
cd zyk
cd mcp-server && npm install
```

### 2. Start Hatchet

```bash
docker compose up -d
```

Wait ~15 seconds for Hatchet to initialise, then open http://localhost:8888 to confirm it's running.

### 3. Generate a Hatchet token and configure env

```bash
node scripts/generate-token.js
```

This calls the Hatchet REST API and prints a token for your tenant. Copy it, then:

```bash
cp .env.example .env
# Set HATCHET_CLIENT_TOKEN=<token> in .env
```

To connect Claude, run the setup script:

```bash
node mcp-server/setup.js
```

### 4. Start the MCP server

```bash
cd mcp-server && npm run dev
```

The server listens on port 3100. Open http://localhost:3100 to see the dashboard.

### Running with Claude Code

The repo includes a `.mcp.json` that registers the server with Claude Code automatically. Make sure `HATCHET_CLIENT_TOKEN` is set in `.env` first, then start a new Claude Code session in this directory.

### Running with Claude

After running `setup.js`, the script updates your Claude config. Restart Claude to pick up the changes.

## Typecheck and build

```bash
cd mcp-server
npm run typecheck   # type-check without emitting
npm run build       # compile TypeScript to dist/
```

CI runs both on every push and PR.

## Code style

- **TypeScript strict mode** — all types explicit, no implicit `any`
- **No extra dependencies** — use `fetch()` for HTTP, the Hatchet SDK for workflow primitives, and nothing else unless there's a compelling reason
- **Minimal abstractions** — three similar lines of code is better than a premature helper
- **No default exports** except in workflow files (required by the worker loader)
- Error paths: throw on non-OK HTTP responses so Hatchet retries automatically

## Project structure

```
mcp-server/src/
  index.ts           MCP server entry point and tool registration
  tools/             One file per MCP tool
  hatchet/           Hatchet client, workflow registry, worker management
  server/            Express webhook + dashboard server
  utils/             Code runner (esbuild transpilation) and diagram storage
```

## Submitting a PR

1. Fork the repo and create a branch: `git checkout -b my-feature`
2. Make your changes. Keep commits focused and messages descriptive.
3. Run `npm run typecheck && npm run build` locally — CI will check this too.
4. Open a PR against `main`. Fill in the PR template.
5. A maintainer will review within a few days.

## Reporting bugs

Use the GitHub issue tracker. The bug report template will ask for your Node.js version, Docker version, and the relevant error output.

## Feature requests

Open a GitHub issue with the feature request template. Describe the use case — what workflow would this enable that isn't possible today?
