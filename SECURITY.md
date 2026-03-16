# Security

## Before deploying Zyk anywhere reachable from the public internet

**Rotate all credentials before deploying beyond localhost/private networks or sharing any URLs.**

| Credential | Where to rotate |
|---|---|
| `SLACK_BOT_TOKEN` | Slack app settings → OAuth & Permissions → Regenerate |
| `SLACK_SIGNING_SECRET` | Slack app settings → Basic Information → Regenerate |
| `GITHUB_TOKEN` | GitHub → Settings → Developer settings → Personal access tokens |
| `HATCHET_CLIENT_TOKEN` | Run `node scripts/generate-token.js` |

After rotating, update the token in:
1. `.env` (local development)
2. `.mcp.json` (Claude Code)
3. Claude config (`claude_desktop_config.json`)

**Check git history for accidentally committed secrets:**

```bash
git log --all --full-history -- .env
git log --all --full-history -- "**/.env"
git log --all --full-history -- .mcp.json
```

The `.env` and `.mcp.json` files are in `.gitignore`, but it's worth verifying they were never committed. If they were, consider using [git-filter-repo](https://github.com/newren/git-filter-repo) to purge them from history.

## Workflow code execution

Zyk runs user-generated TypeScript workflow code as a Node.js subprocess. **Do not run workflow code from untrusted sources.** The generated code:

- Runs with the same OS permissions as the MCP server process
- Has access to all environment variables in the server's process environment
- Can make arbitrary network requests

In the current single-user, self-hosted model this is acceptable — you control what Claude generates. A multi-tenant cloud deployment would require sandboxing (e.g., separate containers or a restricted runtime per workflow).

## Webhook endpoint

The Slack interactions endpoint (`POST /slack/interactions`) verifies the `X-Slack-Signature` header using the `SLACK_SIGNING_SECRET` environment variable. If `SLACK_SIGNING_SECRET` is not set, signature verification is skipped with a warning — **always set this in production**.

## Responsible disclosure

If you discover a security vulnerability in Zyk, please report it privately before opening a public issue. You can reach the maintainers at:

- GitHub: open a [private security advisory](https://github.com/zyk-hq/zyk/security/advisories/new)

Please include:
- A description of the vulnerability and its potential impact
- Steps to reproduce
- Any suggested mitigations

We aim to acknowledge reports within 48 hours and provide a fix within 14 days for critical issues.