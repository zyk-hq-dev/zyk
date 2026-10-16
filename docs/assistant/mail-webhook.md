# Incident mails via webhook (optional)

By default the hourly scheduled run finds new incident mails ([scheduled-run.md](scheduled-run.md)).
That needs no extra setup, but a mail can wait up to an hour. A webhook starts the process
when the mail arrives.

## Endpoint

```
POST https://<your zyk domain>/webhooks/incident-triage
Authorization: Bearer <webhook key>
Content-Type: application/json

{
  "message_id": "<CAF1234@mail.example.com>",
  "from": "Ada Lovelace <ada@example.com>",
  "subject": "Checkout is down",
  "body": "Nobody can pay since 9:00.",
  "received_at": "2026-10-16T09:00:00Z",
  "thread_url": "https://mail.google.com/mail/u/0/#inbox/18f..."
}
```

- `message_id`, `from`, `subject`, and `received_at` are required; `body` and `thread_url` are
  optional. Other fields are rejected. `get_playbook incident-triage` shows the schema.
- Create the key with `npm run admin -- webhook-key:create <tenant_id> "mail forwarder"`.
  Webhook keys can only start workflows; they cannot fetch tasks or read instances. MCP keys
  don't work here.
- Senders that cannot set headers can use `/webhooks/k/<webhook key>/incident-triage`. The key
  then appears in URLs and logs.
- Responses: `202` started, `200` already started for this `message_id` (redeliveries are
  safe), `400` invalid input (the response lists the problems), `401` bad key, `404` unknown
  playbook, `413` body over 1 MB, `415` not JSON.
- `subject` and `body` are stored as untrusted content. They are purged after
  `ZYK_UNTRUSTED_RETENTION_DAYS` (default 14) and never passed to Hatchet.

## Forwarders

Any tool that can call an HTTP endpoint on new mail works:

- **Google Apps Script:** a time-driven trigger (every minute) that searches the incident
  label, posts each new message (`getHeader("Message-ID")`, `getFrom()`, `getSubject()`,
  `getPlainBody()`, `getDate().toISOString()`), and then removes the label.
- **Zapier / Make / n8n:** "New email matching search" → "Webhook POST" with the JSON above.
- **Mail services with inbound parsing** (Postmark, SendGrid, Mailgun): point them at a small
  adapter that maps their payload to the JSON above.

Test with curl:

```bash
curl -i -X POST "https://<domain>/webhooks/incident-triage" \
  -H "Authorization: Bearer $ZYK_WEBHOOK_KEY" -H "Content-Type: application/json" \
  -d '{"message_id":"<test-1@example.com>","from":"Test <t@example.com>","subject":"Test incident","received_at":"2026-10-16T09:00:00Z"}'
```

Sending the same command again returns `200` with `"created": false`.

Keep the scheduled run for the due work, and remove its step 1 (mail search). If both are
active, `message_id` dedupe still prevents a second instance, provided both use the same kind
of id. The Message-ID header is the safer choice.
