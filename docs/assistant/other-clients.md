# Other MCP clients

zyk is plain MCP: tools, one prompt, and server instructions over Streamable HTTP, with no
client-specific features. Any assistant that can call tools on a remote MCP server can be the
worker. Only Claude is tested. Client features change often, so check your client's current docs.

What you need from a client, and how to work around gaps:

| Need | Why | If missing |
|---|---|---|
| Remote MCP over HTTPS with tool calls | everything | not usable |
| A way to pass the key | auth | the URL form `https://<domain>/mcp/k/<key>` needs no header or OAuth support |
| Server instructions shown to the model | protocol rules | paste the "Working with zyk" and "Safety" parts of the [project instructions](project-instructions.md) into the client's custom instructions |
| MCP prompts | `/zyk-work` | just say "fetch my zyk tasks and work through them" |
| Connectors for GitHub and mail in the same chat | doing the work | the client can only do the steps it has tools for. Use `fetch_and_lock` with `topics` to take only those |
| Scheduled runs with connectors | timers firing while you are away | run "zyk" manually, or use Claude's scheduled run alongside. Workers can mix safely |

Mapping the Claude setup:

- **Project instructions** → the client's custom instructions, system prompt, or project/GPT
  instructions: [project-instructions.md](project-instructions.md).
- **Scheduled run** → the client's scheduled or background tasks, if they can call connectors:
  [scheduled-run.md](scheduled-run.md), the prompt as is.
- **Approvals** → in the chat, like Claude. A client that supports MCP elicitation still uses
  the conversation in milestone 1.

## ChatGPT

Custom remote MCP servers are added as connectors (at the time of writing, through developer
mode in the connector settings, with write actions behind a confirmation). Use the URL key form
if the connector dialog offers only OAuth or no auth. Check whether its scheduled tasks can use
connectors before relying on them for the hourly run.

## Grok

xAI's API supports remote MCP tools for agents. Point it at the zyk URL (key in the path, or an
`Authorization` header if the API lets you set one) and use the project instructions as the
system prompt. A scheduler outside Grok (cron, CI) can then run the scheduled prompt through
the API.

## Mixing workers

Several assistants can work the same zyk tenant at once, e.g. ChatGPT in the browser and a
Claude scheduled run. Claims are exclusive (fetch-and-lock with fencing), effects are idempotent
via markers, and every result names the worker in the audit log. Give each worker a distinct
`worker` name in `fetch_and_lock` so the history shows who did what.
