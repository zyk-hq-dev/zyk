# Zyk — Claude-native workflow automation

> **Alpha coming soon.** This repository is not yet released. Star it to follow along — we'll be opening access shortly.
> Want to see it in action first? Visit **[zyk.dev](https://zyk.dev)** for demos and early access.

**Built for Claude, not bolted onto it.**

Most workflow tools add AI as an afterthought. Zyk is different: you create, manage, and operate workflows entirely through conversation. Describe what you want, Claude generates real TypeScript and deploys it on Hatchet with retries, scheduling, and human-in-the-loop built in. When a workflow needs a human decision, answer it in Claude or in the Zyk dashboard and it resumes automatically. No node editors, no connectors to configure.

Open source, self-hosted on Railway. **Zero vendor lock-in** — your workflows are plain TypeScript files you own. If you ever outgrow Zyk, you can run them directly on Hatchet without changing a line of code.

**Learn more** — [zyk.dev](https://zyk.dev) · **Questions or feedback** — [hello@zyk.dev](mailto:hello@zyk.dev)

---

## Why this stack

**Claude** is becoming the daily interface for knowledge workers. Instead of building a separate UI, Zyk plugs into it. Builders describe automations in conversation, Claude generates the code, Zyk deploys it. No new tool to learn.

**Hatchet over Temporal?** Single Docker image (Hatchet Lite), Postgres-only dependency, no Kafka or Cassandra, beautiful built-in monitoring UI. Temporal is powerful but complex to self-host. Hatchet is one `docker compose up`. That matters for small teams.

**Real TypeScript over a DSL.** Previous automation tools lock you into their connector library. If the connector doesn't exist, you're blocked. Claude knows thousands of APIs from training, so it writes the HTTP calls directly. No connector maintenance, no limitations.

**Durable execution over serverless functions.** Serverless functions have hard execution timeouts, typically 10-15 minutes. That's fine for a webhook handler, but it makes human-in-the-loop workflows impossible to build correctly. Hatchet workflows can pause mid-execution, wait days for a human signal, and resume exactly where they left off. No queues, no external state store, no split endpoints.

**Railway over local Docker.** No Docker required on your machine. You get a public HTTPS URL automatically, which means Slack interactions work out of the box without ngrok. Env vars are managed in the Railway dashboard. One URL to paste into Claude.

---

## Get started

### Step 1 — Deploy on Railway

Click the button below. Railway will provision PostgreSQL, Hatchet Engine, and the Zyk MCP Server automatically.

[![Deploy on Railway](https://railway.com/button.svg)](#)

During setup, Railway will ask you to set one variable:

| Variable | Value |
|----------|-------|
| `ZYK_API_KEY` | Any secret string you choose. Protects your MCP endpoint and dashboard. Generate one with: `openssl rand -hex 32` or `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |

Everything else (Hatchet token, internal networking, persistent volume) is configured automatically.

Once deployed, copy your Zyk MCP Server URL from the Railway dashboard. It looks like `https://<zyk>.up.railway.app`.

### Step 2 — Connect Claude

Pick one — you only need to configure the Claude client you use:

**Claude Desktop** — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "zyk": {
      "command": "npx",
      "args": ["-y", "zyk-mcp", "--proxy", "https://<zyk>.up.railway.app/mcp"],
      "env": {
        "ZYK_API_KEY": "your-secret-key"
      }
    }
  }
}
```

`npx` runs a tiny local stdio/HTTP bridge. Node.js must be installed, nothing else.

The easiest way to find the config is inside Claude Desktop: **Settings > Developer > Local MCP Servers > Edit Config**. This opens the correct file regardless of how Claude was installed.

Fully quit and restart Claude after saving.

**Claude Code** — add to `.mcp.json`:

```json
{
  "mcpServers": {
    "zyk": {
      "type": "http",
      "url": "https://<zyk>.up.railway.app/mcp",
      "headers": {
        "Authorization": "Bearer your-secret-key"
      }
    }
  }
}
```

### Step 3 — Verify it works

Ask Claude: *"List my workflows"*

Expected response:
```
No workflows registered yet. Use create_workflow to create your first workflow.
```

Then try: *"Create a workflow that posts a daily summary to Slack every morning"* and watch it build.

> **Running locally?** See [CONTRIBUTING.md](./CONTRIBUTING.md) for local Docker Compose setup.

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
        Hatchet Engine  (Railway - :8080 UI, :7077 gRPC)
            |
        PostgreSQL  (Railway - run history, scheduling, durable state)
```

**Worker lifecycle:** each worker runs as a child process, connects to Hatchet via gRPC, and waits for work. Workers auto-restart on crash and are restored when the MCP server restarts.

**Scheduling:** cron expressions live inside the workflow code (`on: { cron: "0 8 * * *" }`). Hatchet owns scheduling entirely.

**Human-in-the-loop:** workflows use `workflow.durableTask()` + `ctx.waitForEvent()` to pause durably in Hatchet's DB. When a user responds (via the Zyk dashboard or Slack), Zyk pushes a Hatchet event and the step resumes exactly where it left off. No polling loops, survives server restarts.

**Slack interactions:** set the Slack app's Interactivity Request URL to `https://<zyk>.up.railway.app/slack/interactions`.

---

## Dashboard

Every Zyk deployment comes with a built-in dashboard. To find your URLs, click the service in the Railway project, then go to **Settings > Networking > Public URL**:

- **Zyk dashboard + MCP endpoint** — public URL of the `zyk` service, e.g. `https://<zyk>.up.railway.app`
- **Hatchet UI** — public URL of the `hatchet-lite` service, e.g. `https://<hatchet-lite>.up.railway.app`

- **Workflow list** — see all registered workflows and their live worker status
- **Visual diagram** — each workflow renders as a flowchart so you can see the steps at a glance
- **Task list** — pending human-in-the-loop questions appear here. Answer them with a click, no Claude required
- **Hatchet UI** — link through to the full Hatchet monitoring UI for run history, logs, and step traces

The dashboard is protected by your `ZYK_API_KEY`.

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
POST https://<zyk>.up.railway.app/webhook/<workflow_id>
Content-Type: application/json

{ ...your params... }
```

---

## Modifying a workflow

To change anything about a workflow — the Slack message format, a prompt, which channel to post to, adding a new step — just describe the change to Claude:

> "Update the github-incident-triage workflow to also include the issue author in the Slack message"

> "Change the approval threshold to HIGH and above, not just CRITICAL"

Claude will rewrite the relevant parts and call `update_workflow`, which redeploys the worker in place without changing the workflow ID or losing run history.

---

## Adding secrets

Add environment variables to the `zyk` Railway service. Generated workflows access them via `process.env.VAR_NAME`.

Common secrets:

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Required for workflows that use Claude to classify, summarize, or make decisions. Get yours at [console.anthropic.com](https://console.anthropic.com). |
| `SLACK_BOT_TOKEN` | `xoxb-...` token with `chat:write` scope. From your Slack app's OAuth & Permissions page. |
| `SLACK_CHANNEL` | Channel ID for Slack messages, e.g. `C01234ABCDE`. To find it: open the channel in Slack → click the channel name at the top → scroll to the bottom of the popup — the ID is shown there. |
| `SLACK_SIGNING_SECRET` | From Slack app settings. Enables signature verification on `/slack/interactions`. |
| `GITHUB_TOKEN` | `ghp_...` personal access token or GitHub App token with `repo` scope. |

Any variable you add is automatically available in generated workflow code.

---

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ZYK_API_KEY` | Recommended | Protects your MCP endpoint and dashboard. Set the same value in your Claude config. |
| `HATCHET_HOST_PORT` | Yes | gRPC address: `hatchet-lite.railway.internal:7077` |
| `HATCHET_CLIENT_HOST_PORT` | Yes | Same as `HATCHET_HOST_PORT` |
| `HATCHET_CLIENT_TOKEN` | No | Auto-generated on first boot and cached to the persistent volume. |
| `HATCHET_REST_URL` | No | Hatchet REST URL (default: derived from `HATCHET_HOST_PORT`) |
| `WORKFLOWS_DIR` | No | Workflow storage directory. Set to `/app/workflows` to match the persistent volume mount path. |
| `PORT` | No | HTTP server port. Railway sets this automatically (typically `8080`). Default `3100` for local. |
| `ZYK_WEBHOOK_BASE` | No | External base URL workers use to reach the Zyk server. Set automatically on Railway via `ZYK_WEBHOOK_BASE`. For local development, defaults to `http://localhost:3100`. Required if `PORT` differs from `3100` and you're running human-in-the-loop workflows. |

---

## Known limitations

- **Single-user/single-team.** All workflows share one Hatchet tenant. No auth, no per-user namespacing.
- **Human-in-the-loop via Slack or Zyk dashboard only.** Workflows can pause for a human response via Slack buttons or the Zyk task UI. Waiting for input from other systems (e.g. a Trello comment, an email reply) requires polling those APIs yourself.
- **No code sandboxing.** Generated workflows run with full Node.js permissions and inherit the server's environment variables. This is the right tradeoff for single-team use; it's not appropriate for untrusted multi-user environments.
- **Webhook trigger is unauthenticated.** `POST /webhook/:id` accepts requests from anywhere — the workflow ID is the only protection. Use a reverse proxy or add signature verification for sensitive workflows.

---

## Troubleshooting

### Tools don't appear in Claude

- Confirm the URL in your MCP config matches your Railway deployment
- Check that the Railway service is healthy (green status)
- Open `https://<zyk>.up.railway.app/api/workflows` in a browser. It should return `[]`.

### "Worker failed to start" on create_workflow

The worker subprocess couldn't connect to Hatchet. Check:
- `HATCHET_HOST_PORT` and `HATCHET_CLIENT_HOST_PORT` are set correctly
- The Hatchet service is healthy in Railway
- The TCP proxy on port 7077 is enabled on the Hatchet service

### Hatchet service is unhealthy

Give it 30-60 seconds on first boot (database migration). If it stays unhealthy, check Railway logs. The most common cause is `DATABASE_URL` not set correctly.

### Workflows lost after redeploy

The persistent volume isn't attached. Go to the zyk service, then Volumes, then add a volume at `/app/workflows`.

---

## Example workflows

### GitHub Issue Incident Triage

Triggered by a webhook when a GitHub issue is opened. Assesses severity with Claude, drafts a Slack alert for `#incidents`, and pauses for human approval before posting if the issue is critical.

**Prompt — paste this into Claude to create the workflow:**

> Create a workflow called "github-issue-incident-triage" with these steps:
>
> 1. Trigger: a GitHub issue is opened with a critical or production label
> 2. Call the Anthropic API to assess severity (critical / high / medium / low) and produce a short summary and impact statement
> 3. Draft a Slack message for #incidents with clearly labeled fields: severity level, issue link and number, labels, author, AI-generated summary, potential impact, and severity reasoning
> 4. If severity is critical, pause and ask me for approval before posting
> 5. On approval, post the message to the Slack channel in `SLACK_CHANNEL`

**Required environment variables:**

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | For Claude severity assessment |
| `SLACK_BOT_TOKEN` | `xoxb-...` token with `chat:write` scope |
| `SLACK_CHANNEL` | Target channel ID, e.g. `C01234ABCDE` (see above for how to find it) |

**Trigger** — point a GitHub webhook at Zyk (repo Settings → Webhooks → Add webhook, select "Issues" events), or use a GitHub Actions step:

```
POST https://<zyk>.up.railway.app/webhook/<workflow_id>
Content-Type: application/json

{
  "action": "opened",
  "issue": {
    "number": 99,
    "title": "Payment service returning 500s in production",
    "body": "...",
    "html_url": "https://github.com/org/repo/issues/99",
    "labels": [{ "name": "critical" }, { "name": "production" }],
    "user": { "login": "username" }
  }
}
```

This is GitHub's native webhook payload shape — no transformation needed.

**Full workflow code:** [`examples/github-issue-incident-triage.ts`](./examples/github-issue-incident-triage.ts)

---

## vs. Zapier / n8n / Make

| | n8n / Zapier / Make | **Zyk** |
|---|---|---|
| Interface | Web UI, node editor | **Claude via MCP** |
| AI role | Bolted-on assistant | **Claude writes, deploys and operates workflows** |
| Connectors | Pre-built only | **Any API Claude knows** |
| Durable execution | Breaks silently on failure | **Hatchet engine, checkpointed and auto-retry** |
| Human-in-the-loop | Not natively supported | **Pause, ask, resume built in** |
| Self-host | n8n yes, others no | **One-click Railway deploy, MIT license** |
| Output | JSON config / node graph | **Real TypeScript you can read and extend** |

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for local development setup.

---

## License

MIT
