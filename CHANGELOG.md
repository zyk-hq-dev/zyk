# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0-beta] - 2026-02-25

### Added

**Core MCP server**
- Nine MCP tools: `create_workflow`, `update_workflow`, `run_workflow`, `get_status`, `list_workflows`, `delete_workflow`, `list_runs`, `list_templates`, `use_template`, `review_workflow`
- Dynamic TypeScript workflow registration and execution via Hatchet
- Per-workflow worker process management (spawn, restart, terminate)
- Structured error surfacing in `get_status`: failed step names, error messages, retry counts

**Hatchet integration**
- Hatchet Lite single-container setup via Docker Compose
- PostgreSQL persistence (workflows survive MCP server restarts)
- gRPC client auto-initialisation from `HATCHET_CLIENT_TOKEN`
- esbuild-based TypeScript transpilation for user-generated workflow code

**Web dashboard** (http://localhost:3100)
- Live workflow list with status badges and last-run indicators
- Mermaid diagram rendering per workflow (server-side storage, never sent to Claude)
- Run history with links to Hatchet UI for detailed logs
- Slack interactions endpoint (`POST /slack/interactions`) for button-click polling
- Polling endpoint (`GET /slack/pending/:correlationId`) for workflow-level approval gates

**Developer experience**
- Cross-platform setup script (`node setup.js`) — generates tokens, writes `.env`, updates Claude config
- `.mcp.json` for Claude Code integration
- Example workflows: daily revenue report, new user onboarding, API error monitor, incident response
- `PROMPTS.md` with ready-to-paste Claude prompts for instant demos

**Documentation**
- Full README with setup, architecture, and troubleshooting
- CONTRIBUTING.md with dev setup and PR guidelines
- SECURITY.md with credential hygiene checklist
- CLAUDE.md with workflow code generation rules for Claude

### Known limitations

- Single-user / single-tenant (no auth layer yet)
- No workflow versioning UI (use Hatchet's built-in history)
- No cloud-hosted option (self-hosted only)
- Slack button interactions require a public HTTPS URL (ngrok for local dev)

[0.1.0-beta]: https://github.com/zyk-hq/zyk/releases/tag/v0.1.0-beta
