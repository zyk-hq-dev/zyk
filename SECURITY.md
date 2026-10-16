# Security

## Security model (v2)

- **No third-party credentials.** zyk never holds GitHub, mail, or other tokens. The user's
  assistant does the work with its own connectors; zyk only stores process state and results.
- **No code execution.** Playbooks are reviewed code in this repository. Customizations are
  typed data; zyk never generates or runs user-supplied code.
- **API keys per tenant** (`zyk_` + 256 random bits), stored as SHA-256 hashes and shown once.
  Keys are scoped: `mcp` keys work the task API, `webhook` keys can only start workflows.
  Keys can be sent as `Authorization: Bearer <key>` or in the URL path. The path form can show
  up in proxy and platform logs (e.g. Railway's HTTP logs), so prefer the header where the
  client supports it, and revoke unused keys (`npm run admin -- key:revoke <prefix>`).
- **Approvals.** Every irreversible external action (sending mail) needs an approved user task
  directly before it. This is checked when the manifest loads and again at runtime. Scheduled
  runs are instructed never to complete user tasks.
- **Untrusted content.** External text (mail bodies, issue comments) only reaches the assistant
  as `untrusted_content`, marked as data. It never appears in task instructions, never passes
  through Hatchet, and is purged after `ZYK_UNTRUSTED_RETENTION_DAYS` (default 14).
- **Hatchet** is internal. On hosted deployments it has no public domain, the default admin
  login is replaced, and run retention is limited. See the checklist in
  [docs/deploy-railway.md](docs/deploy-railway.md).

Details: [docs/v2-architecture.md](docs/v2-architecture.md) §8.

## Local development

The Compose setup uses Hatchet Lite's development defaults (`admin@example.com` /
`Admin123!!`, insecure cookies, UI on `localhost:8888`). Don't expose it beyond your machine.
`.env` is in `.gitignore` and holds your local Hatchet token. Never commit it.

## Responsible disclosure

If you discover a security vulnerability in zyk, please report it privately before opening a
public issue:

- GitHub: open a [private security advisory](https://github.com/zyk-hq/zyk/security/advisories/new)

Please include:
- A description of the vulnerability and its potential impact
- Steps to reproduce
- Any suggested mitigations

We aim to acknowledge reports within 48 hours and provide a fix within 14 days for critical issues.
