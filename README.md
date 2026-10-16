<p align="center">
  <img src="assets/zyk-logo.svg" alt="zyk" width="120" />
</p>

# zyk v2 — durable processes for AI assistants

> **Work in progress.** This branch is the v2 rewrite. Looking for v1 (the MCP server that
> generates Hatchet workflow code)? See tag [`v1.0.0`](../../tree/v1.0.0) or branch [`v1`](../../tree/v1).

Your AI assistant can act in all your tools via MCP, but it has no clock, no durable state,
and no memory across days. It can't reliably run "triage this incident, wait for the SLA,
check the issue, escalate if nobody responded."

zyk is the durable brain; your assistant is the worker:

- zyk runs **playbooks** on [Hatchet](https://hatchet.run): state, timers, waits, retries,
  approvals, and an audit log.
- Your assistant **pulls tasks** from zyk over MCP and executes them with your own connectors.
  zyk never sees your credentials.
- Human decisions are **user tasks** your assistant asks you about in the conversation.
- Customize playbooks by talking to your assistant ("wait 2 days instead of 1 for sev2").

The first playbook is **incident triage**: incident mail → triage → GitHub issue → SLA wait →
escalation → resolution mail.

Design: [`docs/v2-architecture.md`](docs/v2-architecture.md)

## License

See [LICENSE](LICENSE).
