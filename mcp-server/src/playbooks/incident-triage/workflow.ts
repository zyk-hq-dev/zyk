/**
 * incident-triage, major version 1. Control flow for playbooks/incident-triage/1.x.yaml.
 * Every step call is checked against the manifest at runtime (see engine/run.ts).
 */

import { renderTemplate } from "../config.js";
import type { PlaybookDefinition, PlaybookRun } from "../../engine/run.js";

interface Triage {
  severity: "sev1" | "sev2" | "sev3";
  title: string;
  summary: string;
  reporter_name: string;
  duplicate_of?: number;
}

interface Issue {
  issue_number: number;
  issue_url: string;
  assignee?: string;
}

interface Status {
  state: "open" | "closed";
  has_activity: boolean;
  assignee?: string;
  resolution_summary?: string;
}

type Severity = Triage["severity"];

export const incidentTriage: PlaybookDefinition = {
  id: "incident-triage",
  major: 1,

  async run(r: PlaybookRun): Promise<void> {
    const mail = r.trustedInput as { message_id: string; from: string; received_at: string; thread_url?: string };
    const config = r.config;

    // ── Intake ────────────────────────────────────────────────────────────────
    const triage = (await r.systemTask("triage", {
      input: { from: mail.from, received_at: mail.received_at },
      untrustedInput: true,
    })) as unknown as Triage;

    if (triage.duplicate_of) {
      await r.systemTask("comment_duplicate", {
        input: { duplicate_of: triage.duplicate_of, summary: triage.summary, received_at: mail.received_at },
      });
      return r.end("end_duplicate");
    }

    let severity: Severity = triage.severity;
    const autoCreate = (config.auto_create_severities as string[]).includes(severity);
    if (!autoCreate) {
      const confirm = await r.userTask("confirm", {
        input: { reporter: mail.from, title: triage.title, severity, summary: triage.summary },
        untrustedInput: true,
      });
      if (confirm.decision === "dismiss") return r.end("end_dismissed");
      severity = confirm.decision as Severity;
    }

    const issue = (await r.systemTask("create_issue", {
      input: {
        title: triage.title,
        summary: triage.summary,
        severity,
        reporter_name: triage.reporter_name,
        labels: config.github_labels,
      },
    })) as unknown as Issue;

    // ── Acknowledgement ───────────────────────────────────────────────────────
    const slaKey = `sla_${severity}`;
    await mailWithApproval(r, ["draft_ack", "approve_ack", "send_ack"], {
      to: mail.from,
      in_reply_to: mail.message_id,
      text: renderTemplate(String(config.ack_template), {
        reporter_name: triage.reporter_name,
        issue_url: issue.issue_url,
        severity,
        sla: String(config[slaKey]),
      }),
    });

    // ── SLA loop ──────────────────────────────────────────────────────────────
    const target = String(config.escalation_target);
    const maxRounds = Number(config.escalation_rounds);
    let round = 0;
    for (;;) {
      await r.wait("wait_sla", slaKey);
      const status = (await r.systemTask("check_status", {
        input: { issue_number: issue.issue_number, issue_url: issue.issue_url, activity_window: config[slaKey] },
      })) as unknown as Status;

      if (status.state === "closed") {
        await mailWithApproval(r, ["draft_resolution", "approve_resolution", "send_resolution"], {
          to: mail.from,
          in_reply_to: mail.message_id,
          text: renderTemplate(String(config.resolution_template), {
            reporter_name: triage.reporter_name,
            issue_url: issue.issue_url,
            resolution_summary: status.resolution_summary ?? "The issue has been closed.",
          }),
        });
        return r.end("end_resolved");
      }
      if (status.has_activity) continue;
      if (round >= maxRounds) return r.end("end_stale");
      round += 1;

      if (target === "assignee" || target === "both") {
        await r.systemTask("escalate", {
          input: {
            issue_number: issue.issue_number,
            text: renderTemplate(String(config.escalation_comment_template), {
              assignee_mention: status.assignee ? `@${status.assignee}` : "Maintainers,",
              severity,
              sla: String(config[slaKey]),
              round,
            }),
          },
        });
      }
      if (target === "user" || target === "both") {
        const review = await r.userTask("review_escalation", {
          input: { issue_url: issue.issue_url, severity, round, max_rounds: maxRounds },
        });
        if (review.decision === "stop_tracking") return r.end("end_stopped");
      }
    }
  },
};

/** draft → approve → (send | revise → draft … | skip). Returns whether the mail was sent. */
async function mailWithApproval(
  r: PlaybookRun,
  [draftKey, approveKey, sendKey]: [string, string, string],
  mail: { to: string; in_reply_to: string; text: string }
): Promise<"sent" | "skipped"> {
  let revisionNotes: string | undefined;
  for (;;) {
    const draft = (await r.systemTask(draftKey, {
      input: { ...mail, ...(revisionNotes ? { revision_notes: revisionNotes } : {}) },
    })) as { draft_id: string; text: string };
    const approval = await r.userTask(approveKey, { input: { to: mail.to, text: draft.text } });
    if (approval.decision === "send") {
      await r.systemTask(sendKey, { input: { draft_id: draft.draft_id, approved_text: draft.text } });
      return "sent";
    }
    if (approval.decision === "skip") return "skipped";
    revisionNotes = approval.comment ?? "Revise the draft.";
  }
}
