# Zyk — Claude-native workflow automation

> **Alpha coming soon.** This repository is not yet released. Star it to follow along — we'll be opening access shortly.
> Want to see it in action first? Visit **[zyk.dev](https://zyk.dev)** for demos and early access.

**Describe it. Run it. Done.**

We're betting on two things: **MCP-ready AI as the interface** for building and running workflows, and **durable execution as the engine** for making them reliable. Zyk is what happens when you combine them.

You describe a workflow in plain English through Claude. Zyk generates structured TypeScript and runs it on a durable execution engine. Retries, scheduling, and error handling built in by design.

No connectors to configure. No DSL to learn. Just describe it — the diagram builds itself.

**What durable means in practice:** a workflow can fire on a Slack message, create a GitHub issue, post Approve/Reject buttons back to Slack, and wait days for a human to respond — then resume and close the loop automatically. No split endpoints, no manual state management.

Open source, self-hosted on Railway.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/0vootV?referralCode=nLaNid&utm_medium=integration&utm_source=template&utm_campaign=generic)

**Learn more** — [zyk.dev](https://zyk.dev) · **Questions or feedback** — [hello@zyk.dev](mailto:hello@zyk.dev)

---

## Why this stack

**Claude** is becoming the daily interface for knowledge workers. Instead of building a separate UI, Zyk plugs into it — builders describe automations in conversation, Claude generates the code, Zyk deploys it. No new tool to learn.

**Hatchet over Temporal?** Single Docker image (Hatchet Lite), Postgres-only dependency, no Kafka or Cassandra, beautiful built-in monitoring UI. Temporal is powerful but complex to self-host. Hatchet is one `docker compose up`. That matters for small teams.

**Real TypeScript over a DSL.** Previous automation tools lock you into their connector library. If the connector doesn't exist, you're blocked. Claude knows thousands of APIs from training — it writes the HTTP calls directly. No connector maintenance, no limitations.

**Durable execution over serverless functions.** Serverless functions have hard execution timeouts — typically 10–15 minutes. That's fine for a webhook handler, but it makes human-in-the-loop workflows impossible to build correctly. Hatchet workflows can pause mid-execution, wait days for a human signal, and resume exactly where they left off. No queues, no external state store, no split endpoints.

**Railway over local Docker.** No Docker required on your machine. You get a public HTTPS URL automatically — which means Slack interactions work out of the box without ngrok. Env vars are managed in the Railway dashboard. One URL to paste into Claude.

---

## Deploy on Railway (~10 minutes)

You'll create three services in a Railway project: PostgreSQL, Hatchet Engine, and the Zyk MCP Server.

### Step 1 — Create a Railway project

1. Go to [railway.app](https://railway.app) and create a new project.
2. Add a **PostgreSQL** database (the built-in plugin — one click).

### Step 2 — Deploy Hatchet Engine

Add a new service → **Deploy from Docker image**:

```
ghcr.io/hatchet-dev/hatchet/hatchet-lite:latest
```

Set these environment variables:

| Variable | Value |
|----------|-------|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `SERVER_AUTH_COOKIE_SECRETS` | Two random hex strings, space-separated (run `openssl rand -hex 32` twice) |
| `SERVER_AUTH_COOKIE_DOMAIN` | Your Hatchet Railway domain, e.g. `hatchet-engine.up.railway.app` |
| `SERVER_GRPC_BIND_ADDRESS` | `0.0.0.0` |
| `SERVER_GRPC_PORT` | `7077` |
| `SERVER_GRPC_BROADCAST_ADDRESS` | `hatchet-engine.railway.internal:7077` |
| `SERVER_GRPC_INSECURE` | `t` |
| `SERVER_AUTH_SET_EMAIL_VERIFIED` | `t` |
| `SERVER_AUTH_COOKIE_INSECURE` | `t` |

Expose port **8080** (HTTP / REST API + UI) and enable a **TCP proxy on port 7077** (gRPC — workers connect here).

Wait until the Hatchet service shows healthy (~30 seconds).

### Step 3 — Deploy the Zyk MCP Server

Add another service → **Deploy from GitHub repo** → select this repo → set the **root directory** to `mcp-server/`.

Environment variables:

| Variable | Value |
|----------|-------|
| `HATCHET_HOST_PORT` | `hatchet-engine.railway.internal:7077` |
| `HATCHET_CLIENT_HOST_PORT` | `hatchet-engine.railway.internal:7077` |
| `HATCHET_REST_URL` | `http://hatchet-engine.railway.internal:8080` |
| `ZYK_API_KEY` | Any secret string — protects your MCP endpoint and dashboard |

`HATCHET_CLIENT_TOKEN` is **not required** — Zyk auto-generates one on first boot. Add any workflow secrets you need now (see [Adding secrets](#adding-secrets)).

### Step 4 — Add a persistent volume

In the Railway dashboard for the **zyk-mcp** service, go to **Volumes** → add a volume mounted at:

```
/app/workflows
```

This persists your workflow code and registry across deploys. Without it, all workflows are lost on every redeploy.

### Step 5 — Connect Claude

Your Zyk MCP server is now live at `https://<zyk-mcp>.up.railway.app`.

**Claude Desktop** — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "zyk": {
      "command": "npx",
      "args": ["-y", "zyk-mcp", "--proxy", "https://<zyk-mcp>.up.railway.app/mcp"],
      "env": {
        "ZYK_API_KEY": "your-secret-key"
      }
    }
  }
}
```

`npx` downloads and runs a tiny local bridge — Node.js must be installed, but nothing else.

| Platform | Config path |
|----------|-------------|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Roaming\Claude\claude_desktop_config.json` |

Fully quit and restart Claude after saving.

**Claude Code** — add to `.mcp.json`:

```json
{
  "mcpServers": {
    "zyk": {
      "type": "http",
      "url": "https://<zyk-mcp>.up.railway.app/mcp",
      "headers": {
        "Authorization": "Bearer your-secret-key"
      }
    }
  }
}
```

### Step 6 — Verify it works

Ask Claude: *"List my workflows"*

Expected:
```
No workflows registered yet. Use create_workflow to create your first workflow.
```

Then: *"Create a simple hello-world workflow that logs a greeting with a timestamp"*

Once created, ask Claude to run it and check the status. You should see the run complete in both Claude and the Hatchet UI.

---

## How it works

```
You (natural language)
    |
Claude
    |  MCP over HTTP
Zyk MCP Server  (Railway)
    |-- /app/workflows/registry.json   workflow registry
    +-- worker subprocess per workflow
            |  gRPC
        Hatchet Engine  (Railway — :8080 UI, :7077 gRPC)
            |
        PostgreSQL  (Railway — run history, scheduling, durable state)
```

**Worker lifecycle:** each worker runs as a child process, connects to Hatchet via gRPC, and waits for work. Workers auto-restart on crash and are restored when the MCP server restarts.

**Scheduling:** cron expressions live inside the workflow code (`on: { cron: "0 8 * * *" }`). Hatchet owns scheduling entirely.

**Human-in-the-loop:** workflows use `workflow.durableTask()` + `ctx.waitForEvent()` to pause durably in Hatchet's DB. When a user responds (via the Zyk dashboard or Slack), Zyk pushes a Hatchet event and the step resumes exactly where it left off — no polling loops, survives server restarts.

**Slack interactions:** set the Slack app's Interactivity Request URL to `https://<zyk-mcp>.up.railway.app/slack/interactions`.

---

## MCP Tools

| Tool | Description |
|------|-------------|
| `create_workflow` | Generate and register a new durable workflow |
| `update_workflow` | Update code/config and restart the worker, preserving the ID |
| `run_workflow` | Trigger a workflow execution |
| `get_status` | Check the status of a workflow or a specific run |
| `list_workflows` | See all registered workflows and their worker status |
| `list_runs` | See recent workflow run executions |
| `delete_workflow` | Remove a workflow from Zyk and Hatchet, stop its worker |
| `get_tasks` | List pending tasks waiting for your input |
| `respond_task` | Submit your answer to a pending task |
| `list_templates` | Browse pre-built workflow templates _(requires `ZYK_API_KEY`)_ |
| `use_template` | Pull a template's full code ready to deploy _(requires `ZYK_API_KEY`)_ |
| `review_workflow` | AI-assisted code quality review _(requires `ZYK_API_KEY`)_ |

Webhook trigger (no Claude required):

```
POST https://<zyk-mcp>.up.railway.app/webhook/<workflow_id>
Content-Type: application/json

{ ...your params... }
```

---

## Adding secrets

Add environment variables to the `zyk-mcp` Railway service. Generated workflows access them via `process.env.VAR_NAME`.

Common secrets:

| Variable | Description |
|----------|-------------|
| `SLACK_BOT_TOKEN` | `xoxb-...` |
| `SLACK_SIGNING_SECRET` | From Slack app settings — enables signature verification on `/slack/interactions` |
| `STRIPE_SECRET_KEY` | `sk_live_...` |
| `GITHUB_TOKEN` | `ghp_...` |

Any variable you add is automatically available in generated workflow code.

---

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ZYK_API_KEY` | Recommended | Protects your MCP endpoint and dashboard. Set the same value in your Claude config. |
| `HATCHET_HOST_PORT` | Yes | gRPC address: `hatchet-engine.railway.internal:7077` |
| `HATCHET_CLIENT_HOST_PORT` | Yes | Same as `HATCHET_HOST_PORT` |
| `HATCHET_CLIENT_TOKEN` | No | Auto-generated on first boot and cached to the persistent volume. |
| `HATCHET_REST_URL` | No | Hatchet REST URL (default: derived from `HATCHET_HOST_PORT`) |
| `WORKFLOWS_DIR` | No | Workflow storage directory (default `/app/workflows`) |
| `WEBHOOK_PORT` | No | HTTP server port (default `3100`) |

---

## Known limitations

- **Single-user/single-team.** All workflows share one Hatchet tenant. No auth, no per-user namespacing.
- **Human-in-the-loop via Slack or Zyk dashboard only.** Workflows can pause for a human response via Slack buttons or the Zyk task UI. Waiting for input from other systems (e.g. a Trello comment, an email reply) requires polling those APIs yourself.
- **No code sandboxing.** Generated workflows run with full Node.js permissions and inherit the server's environment variables. This is the right tradeoff for single-team use; it's not appropriate for untrusted multi-user environments.
- **Webhook trigger is unauthenticated.** `POST /webhook/:id` accepts requests from anywhere. Use `ZYK_API_KEY` or a reverse proxy for sensitive workflows.

---

## Troubleshooting

### Tools don't appear in Claude

- Confirm the URL in your MCP config matches your Railway deployment
- Check that the Railway service is healthy (green status)
- Open `https://<zyk-mcp>.up.railway.app/api/workflows` in a browser — it should return `[]`

### "Worker failed to start" on create_workflow

The worker subprocess couldn't connect to Hatchet. Check:
- `HATCHET_HOST_PORT` and `HATCHET_CLIENT_HOST_PORT` are set correctly
- The Hatchet service is healthy in Railway
- The TCP proxy on port 7077 is enabled on the Hatchet service

### Hatchet service is unhealthy

Give it 30–60 seconds on first boot (database migration). If it stays unhealthy, check Railway logs — the most common cause is `DATABASE_URL` not set correctly.

### Workflows lost after redeploy

The persistent volume isn't attached. Go to the zyk-mcp service → Volumes → add a volume at `/app/workflows`.

---

## Example workflows

See [`examples/`](./examples):

| File | What it does | Trigger | Requires |
|------|-------------|---------|----------|
| [`daily-revenue-report.ts`](./examples/daily-revenue-report.ts) | Fetch Stripe revenue → post to Slack | Schedule (8 AM daily) | `STRIPE_SECRET_KEY`, `SLACK_BOT_TOKEN` |
| [`new-user-onboarding.ts`](./examples/new-user-onboarding.ts) | Welcome email + Notion page + Slack notification on signup | Webhook | `RESEND_API_KEY`, `NOTION_TOKEN`, `SLACK_BOT_TOKEN` |
| [`api-error-monitor.ts`](./examples/api-error-monitor.ts) | Poll API health → PagerDuty + Slack on failure | Schedule (every 5 min) | `API_HEALTH_URL`, `PAGERDUTY_ROUTING_KEY`, `SLACK_BOT_TOKEN` |

To deploy an example, paste its code into Claude and ask:

> "Register this workflow: [paste code]"

---

## vs. Zapier / n8n / Make / Temporal

| | Zapier/Make | n8n | Serverless functions | Temporal | **Zyk** |
|---|---|---|---|---|---|
| Interface | Visual UI | Visual UI | Code | Code | **Conversation** |
| Connectors | Pre-built only | Pre-built only | DIY | DIY | **Any API Claude knows** |
| Durability | Basic | Basic | No (timeout-bound) | Yes | **Yes (Hatchet)** |
| Human-in-the-loop | Workarounds | Workarounds | Requires split architecture | Yes | **Yes — wait days if needed** |
| Self-host | Limited | Yes | Cloud-only | Complex | **One command on Railway** |
| Custom logic | Limited | Limited | Full code | Full code | **Full TypeScript** |

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for local development setup.

---

## License

MIT
