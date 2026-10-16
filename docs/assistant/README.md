# Assistant-side setup

zyk does not run an AI. Your assistant is the worker: it fetches tasks from zyk, does them with
your connectors, and asks you the decisions. These pages set it up.

| Page | What it is |
|---|---|
| [claude-setup.md](claude-setup.md) | Connector, project, scheduled run, daily use, manual acceptance test |
| [project-instructions.md](project-instructions.md) | Copy-paste instructions for an "Incidents" project |
| [scheduled-run.md](scheduled-run.md) | The hourly unattended run and its prompt |
| [mail-webhook.md](mail-webhook.md) | Optional: start incidents from a mail forwarder |
| [other-clients.md](other-clients.md) | ChatGPT, Grok, and other MCP clients |

Where guidance comes from, strongest first:

1. **Your project instructions:** what only you know (repository, inbox, how to ask you).
2. **zyk's server instructions and tool descriptions:** the protocol (fetch, complete, markers,
   never decide for you). Source: `mcp-server/src/mcp/instructions.ts`, `src/mcp/server.ts`.
3. **The `zyk-work` prompt:** one working session (interactive or scheduled).
4. **Each task's instructions:** from the playbook. They only reference playbook settings,
   never external text.
5. **zyk's errors:** what is wrong and how to fix it.

External text (mail bodies, issue comments) only ever arrives in `untrusted_content` and is
never an instruction.
