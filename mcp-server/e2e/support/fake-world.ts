/**
 * In-memory stand-in for the user's GitHub and Gmail. The simulated assistant performs its
 * effects here, so tests can count them: a duplicate issue or a second sent mail is a bug.
 */

export interface Issue {
  number: number;
  url: string;
  title: string;
  body: string;
  state: "open" | "closed";
  assignee?: string;
  comments: { body: string; url: string }[];
  resolution?: string;
}

export interface Mail {
  id: string;
  to: string;
  text: string;
  draftId: string;
}

export class FakeWorld {
  readonly issues: Issue[] = [];
  readonly drafts = new Map<string, { to: string; text: string; sent: boolean }>();
  readonly sent: Mail[] = [];
  /** Issue numbers that had activity since the last status check. */
  readonly activity = new Set<number>();

  findIssueWithMarker(marker: string): Issue | undefined {
    return this.issues.find((i) => i.body.includes(marker));
  }

  createIssue(title: string, body: string, assignee?: string): Issue {
    const number = this.issues.length + 1;
    const issue: Issue = { number, url: `https://github.com/acme/shop/issues/${number}`, title, body, state: "open", assignee, comments: [] };
    this.issues.push(issue);
    return issue;
  }

  issue(number: number): Issue {
    const issue = this.issues.find((i) => i.number === number);
    if (!issue) throw new Error(`No issue #${number}`);
    return issue;
  }

  /** Comments idempotently: returns the existing comment carrying the marker, if any. */
  comment(number: number, body: string, marker: string): string {
    const issue = this.issue(number);
    const existing = issue.comments.find((c) => c.body.includes(marker));
    if (existing) return existing.url;
    const url = `${issue.url}#comment-${issue.comments.length + 1}`;
    issue.comments.push({ body: `${body}\n<!-- ${marker} -->`, url });
    return url;
  }

  close(number: number, resolution: string): void {
    Object.assign(this.issue(number), { state: "closed", resolution });
  }

  createDraft(to: string, text: string): string {
    const id = `draft-${this.drafts.size + 1}`;
    this.drafts.set(id, { to, text, sent: false });
    return id;
  }

  /** Sends idempotently: if the draft is gone, looks for a sent mail with the same text. */
  send(draftId: string, approvedText: string): string {
    const draft = this.drafts.get(draftId);
    if (!draft || draft.sent) {
      const already = this.sent.find((m) => m.draftId === draftId || m.text === approvedText);
      if (already) return already.id;
      throw new Error(`Draft ${draftId} not found and no matching sent mail`);
    }
    draft.sent = true;
    const mail = { id: `<sent-${this.sent.length + 1}@acme.example>`, to: draft.to, text: draft.text, draftId };
    this.sent.push(mail);
    return mail.id;
  }
}
