# Zyk — Open-Source Workflow Automation

**Describe it. Run it. Done.**

We're betting on two things: **MCP-ready AI as the interface** for building and running workflows, and **durable execution as the engine** for making them reliable. Zyk is what happens when you combine them.

You describe a workflow in plain English through Claude. Zyk generates structured TypeScript and runs it on a durable execution engine. Retries, scheduling, and error handling built in by design.

No connectors to configure. No DSL to learn. Just describe it — the diagram builds itself.

**What durable means in practice:** a workflow can fire on a Slack message, create a GitHub issue, post Acknowledge/Escalate buttons back to Slack, and wait hours for a human to respond — then resume and close the loop automatically. No split endpoints, no manual state management.

**Builders describe and manage workflows through Claude.** Participants can respond through whatever interface the workflow surfaces — Slack, email, or directly through Claude. Different permissions, same underlying engine.

Open source, self-hosted on Railway. The generated code lives in your repo.

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?template=https://github.com/zyk-hq/zyk)

**Try it without any setup → [zyk.dev](https://zyk.dev)**
The playground runs pre-configured workflows in your browser. No Docker, no API keys, no local install needed.

**Questions or feedback** — reach out at [hello@zyk.dev](mailto:hello@zyk.dev).

---

## Why this stack

**Claude** is becoming the daily interface for knowledge workers. Instead of building a separate UI, Zyk plugs into it — builders describe automations in conversation, Claude generates the code, Zyk deploys it. No new tool to learn.

**Hatchet over Temporal?** Single Docker image (Hatchet Lite), Postgres-only dependency, no Kafka or Cassandra, beautiful built-in monitoring UI. Temporal is powerful but complex to self-host. Hatchet is one `docker compose up`. That matters for small teams.

**Real TypeScript over a DSL.** Previous automation tools lock you into their connector library. If the connector doesn't exist, you're blocked. Claude knows thousands of APIs from training — it writes the HTTP calls directly. No connector maintenance, no limitations.

**Durable execution over serverless functions.** Serverless functions have hard execution timeouts — typically 10–15 minutes. That's fine for a webhook handler, but it makes human-in-the-loop workflows impossible to build correctly. If your workflow posts an approval request to Slack and needs to wait hours for a response, a Lambda times out before the human clicks anything. You end up splitting the workflow into separate functions wired together with queues and external state — which you now have to manage yourself. Hatchet workflows are long-running processes: they can pause mid-execution, wait indefinitely for a human signal, and resume exactly where they left off. No queues, no external state store, no split endpoints.

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

Set these environment variables in the Railway dashboard:

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

`HATCHET_CLIENT_TOKEN` is **optional** — if you leave it out, Zyk auto-generates one on first boot (see Step 4). `HATCHET_CLIENT_TLS_STRATEGY` is pre-set to `none` in the Dockerfile.

Add any workflow secrets you need (see [Adding secrets](#adding-secrets)).

### Step 4 — Add a persistent volume

In the Railway dashboard for the **zyk-mcp** service, go to **Volumes** → add a volume mounted at:

```
/app/workflows
```

This persists workflow code, the registry, and the auto-generated token across container restarts. Without it, all workflows are lost on every deploy.

### Step 5 — Token bootstrap (automatic)

On first boot, if `HATCHET_CLIENT_TOKEN` is not set, Zyk automatically:
1. Waits for Hatchet to become healthy
2. Logs in as `admin@example.com` / `Admin123!!`
3. Creates a Hatchet API token via the REST API
4. Caches it to `/app/workflows/.token` (on the persistent volume)

**No action needed.** The token persists on the volume, so subsequent restarts skip this step entirely.

To use a manually-created token instead (e.g. to use a named token from the Hatchet UI):
1. Open `https://<your-hatchet-service>.up.railway.app` → **Settings → API Tokens**
2. Create a token and set it as `HATCHET_CLIENT_TOKEN` on the zyk-mcp service

### Step 6 — Connect Claude

Your Zyk MCP server is now live at `https://<zyk-mcp>.up.railway.app/mcp`.

**Claude Desktop** — add to `claude_desktop_config.json`, replacing the URL with your Railway URL:

```json
{
  "mcpServers": {
    "zyk": {
      "command": "npx",
      "args": ["-y", "zyk-mcp", "--proxy", "https://<zyk-mcp>.up.railway.app/mcp"]
    }
  }
}
```

`npx` downloads and runs a tiny local bridge (no install needed) that connects Claude Desktop to your Railway server. Node.js must be installed, but nothing else.

| Platform | Config path |
|----------|-------------|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Roaming\Claude\claude_desktop_config.json` |

Fully quit and restart Claude after saving. Ask Claude: *"List my workflows"* — you should get back a confirmation that no workflows exist yet.

**Claude Code** — add to `.mcp.json`:

```json
{
  "mcpServers": {
    "zyk": {
      "type": "http",
      "url": "https://<zyk-mcp>.up.railway.app/mcp"
    }
  }
}
```

---

## Testing your deployment

### Step 1 — Verify the connection

In Claude, ask:

> "List my workflows"

Expected response:

```
No workflows registered yet. Use create_workflow to create your first workflow.
```

### Step 2 — Create a test workflow

> "Create a simple test workflow called 'hello-world' that logs a greeting message with a timestamp. Make it manually triggered."

A successful response looks like:

```json
{
  "success": true,
  "workflow_id": "wf-a1b2c3d4",
  "name": "hello-world",
  "trigger": "on-demand",
  "message": "Workflow \"hello-world\" registered and worker started successfully."
}
```

### Step 3 — Run it

> "Run the hello-world workflow"

Then:

> "Check the status of that run"

### Step 4 — Verify in Hatchet

Open your Hatchet Railway URL → **Workflows** or **Runs**. You'll see the registered workflow and its completed run.

### Step 5 — Trigger via webhook

```bash
curl -X POST https://<zyk-mcp>.up.railway.app/webhook/wf-a1b2c3d4 \
  -H "Content-Type: application/json" \
  -d '{"name": "webhook caller"}'
```

---

## How it works

```
You (natural language)
    |
Claude
    |  MCP protocol over HTTP
Zyk MCP Server   (Railway — https://your-app.up.railway.app)
    |-- workflows/registry.json   persisted workflow registry
    +-- (one subprocess per workflow)
        Worker  -->  esbuild compiles .ts at deploy time
            |  gRPC
        Hatchet Engine  (Railway — :8080 UI/REST, :7077 gRPC)
            |
        PostgreSQL  (Railway plugin — run history, scheduling)
```

**Worker lifecycle:** each worker forks as a child process inside the Zyk container, connects to Hatchet via gRPC, and waits for work. Workers auto-restart on crash with exponential backoff (1s → 2s → 4s → … → 60s). They are restored automatically when the MCP server restarts.

**Scheduling:** cron expressions live inside the workflow code (`on: { cron: "0 8 * * *" }`). Hatchet owns scheduling entirely.

**Slack interactions:** workflows post a message with buttons, set `block_id` to a `correlationId`, then poll `GET /slack/pending/:correlationId`. When a user clicks a button, Zyk's webhook endpoint receives the Slack interaction and the polling loop picks it up. The Slack Interactivity Request URL should be set to `https://<zyk-mcp>.up.railway.app/slack/interactions`.

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
| `delete_workflow` | Remove a workflow and stop its worker |
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

Add them as environment variables on the `zyk-mcp` Railway service. Generated workflows access them via `process.env.VAR_NAME`.

Common secrets:

| Variable | Description |
|----------|-------------|
| `SLACK_BOT_TOKEN` | `xoxb-...` |
| `SLACK_SIGNING_SECRET` | From Slack app settings — enables signature verification on `/slack/interactions` |
| `STRIPE_SECRET_KEY` | `sk_live_...` |
| `GITHUB_TOKEN` | `ghp_...` |

Any variable you add to the service is automatically available in generated workflow code.

---

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `HATCHET_CLIENT_TOKEN` | No | Hatchet API token. If unset, auto-generated on first boot and cached to disk. |
| `HATCHET_HOST_PORT` | Yes (Railway) | gRPC address: `hatchet-engine.railway.internal:7077` |
| `HATCHET_CLIENT_HOST_PORT` | Yes (Railway) | Same as `HATCHET_HOST_PORT` |
| `HATCHET_REST_URL` | No | Hatchet REST URL for auto-bootstrap (default: derived from `HATCHET_HOST_PORT`, e.g. `http://hatchet-engine.railway.internal:8080`) |
| `HATCHET_CLIENT_TLS_STRATEGY` | No | Default `none` (set in Dockerfile). Override to `tls` for external Hatchet. |
| `WORKFLOWS_DIR` | No | Override the workflow storage directory (default `/app/workflows` in Docker). Set if your volume is mounted elsewhere. |
| `WEBHOOK_PORT` | No | HTTP server port (default `3100`) |
| `ZYK_WEBHOOK_BASE` | No | Base URL for internal Slack polling (default `http://localhost:3100` — correct for Railway since workers run in the same container) |

---

## Known limitations

- **Single-user/single-team.** All workflows share one Hatchet tenant. No auth, no per-user namespacing.
- **Slack interaction state is in-memory.** If the MCP server restarts while a workflow is waiting for a Slack button click, that pending state is lost.
- **No code sandboxing.** Generated workflows run with full Node.js permissions and inherit the server's environment variables. This is the right tradeoff for single-team use; it's not appropriate for untrusted multi-user environments.
- **Webhook receiver is unauthenticated.** `POST /webhook/:id` accepts requests from anywhere. Put it behind a reverse proxy with auth for sensitive workflows.

---

## Troubleshooting

### Tools don't appear in Claude

- Confirm the URL in your MCP config is correct and reachable
- Check that the Railway deployment is healthy (green status)
- Try opening `https://<zyk-mcp>.up.railway.app/api/workflows` in a browser — it should return `[]`

### "HATCHET_CLIENT_TOKEN is not set"

The env var isn't set on the Railway service. Go to the zyk-mcp service in Railway → Variables → add `HATCHET_CLIENT_TOKEN`.

### "Worker failed to start" on create_workflow

The worker subprocess couldn't connect to Hatchet. Check:
- `HATCHET_HOST_PORT` and `HATCHET_CLIENT_HOST_PORT` are set to `hatchet-engine.railway.internal:7077`
- The Hatchet service is healthy in Railway
- The TCP proxy on port 7077 is enabled on the Hatchet service

### Workflow runs appear in Hatchet under a different tenant

The token was generated for a different tenant. Regenerate:

```bash
HATCHET_BASE_URL=https://<hatchet-engine>.up.railway.app node scripts/generate-token.js
```

Update `HATCHET_CLIENT_TOKEN` in the Railway dashboard and redeploy.

### Hatchet service is unhealthy

Give it 30–60 seconds on first boot (it migrates the database). If it stays unhealthy, check Railway logs for the hatchet-engine service — the most common cause is `DATABASE_URL` not being set correctly.

---

## Example workflows

See [`examples/`](./examples):

| File | What it does | Trigger | Requires |
|------|-------------|---------|----------|
| [`daily-revenue-report.ts`](./examples/daily-revenue-report.ts) | Fetch Stripe revenue → post to Slack | Schedule (8 AM daily) | `STRIPE_SECRET_KEY`, `SLACK_BOT_TOKEN` |
| [`new-user-onboarding.ts`](./examples/new-user-onboarding.ts) | Welcome email + Notion page + Slack notification on signup | Webhook | `RESEND_API_KEY`, `NOTION_TOKEN`, `SLACK_BOT_TOKEN` |
| [`api-error-monitor.ts`](./examples/api-error-monitor.ts) | Poll API health → PagerDuty + Slack on failure | Schedule (every 5 min) | `API_HEALTH_URL`, `PAGERDUTY_ROUTING_KEY`, `SLACK_BOT_TOKEN` |

To use an example, paste its code into a conversation and ask Claude to register it:

> "Register this workflow code: [paste contents of examples/api-error-monitor.ts]"

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

## Running locally (contributors)

If you're contributing to Zyk itself, you can run the stack locally with Docker Compose:

```bash
docker compose up postgres hatchet-engine -d
node scripts/generate-token.js   # prints a token
cp .env.example .env             # then set HATCHET_CLIENT_TOKEN
cd mcp-server && npm install && npm run build
node dist/index.js
```

Update `.mcp.json` to point to `http://localhost:3100/mcp`:

```json
{
  "mcpServers": {
    "zyk": {
      "type": "http",
      "url": "http://localhost:3100/mcp"
    }
  }
}
```

---

## License

MIT
