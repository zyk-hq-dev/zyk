# Example Prompts

Ready-to-paste prompts for Claude. Each one creates a real, runnable workflow in about 30 seconds.

---

## 1. Daily revenue report

Paste this into Claude to get a workflow that posts a Stripe revenue summary to Slack every morning:

```
Create a workflow that runs every weekday at 8 AM, fetches yesterday's revenue from the Stripe API, compares it to the same day last week, and posts a colour-coded summary to Slack — green if revenue is up, red if it's down.
```

---

## 2. New user onboarding sequence

Creates a 3-step onboarding workflow triggered manually with a user email:

```
Create a workflow that takes a new user's email address as input, sends them a welcome email via the SendGrid API, creates a record in Airtable, and posts a notification to the #new-users Slack channel with their email and signup time.
```

---

## 3. GitHub issue to Slack alert

Monitors for new GitHub issues with a specific label and pages your on-call engineer:

```
Create a workflow that runs every 15 minutes, checks for new GitHub issues in my repo labelled "urgent" that were opened in the last 15 minutes, and sends a Slack DM to the on-call user with the issue title, URL, and author.
```

---

## 4. Incident response with approval gate

Creates a full incident response workflow with a Slack approval step before paging anyone:

```
Create an incident response workflow I can trigger manually. It should:
1. Post an incident alert to Slack with Acknowledge and Dismiss buttons
2. Wait for someone to click Acknowledge
3. Ask for the severity level (P1 / P2 / P3) with buttons
4. If P1 or P2, create a GitHub issue and DM the on-call engineer
5. Post a resolution summary back to Slack when done
```

---

## 5. Weekly API health report

Pings a list of your API endpoints and summarises any failures:

```
Create a workflow that runs every Monday at 9 AM, makes a GET request to each of my API health-check endpoints (I'll add them as env vars), and posts a Slack summary listing which endpoints are up and which are down, with response times.
```

---

## Tips

- After pasting a prompt, Claude will ask one or two clarifying questions if something is genuinely ambiguous (like a cron schedule), then generate and deploy the workflow automatically.
- You can see the workflow running in real time at **http://localhost:3100**.
- For full execution logs, click through to the Hatchet UI at **http://localhost:8888**.
- To trigger a workflow manually after creation, ask Claude: _"Run the [workflow name] workflow."_
