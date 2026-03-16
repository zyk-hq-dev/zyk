/**
 * Workflow code validation and preparation for the playground.
 * Extends mcp-server/utils/code-runner with cron validation and name injection.
 */

export interface CodeValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate a cron expression — must have exactly 5 fields.
 * Minimum interval is 1 minute (cron limitation).
 */
export function validateCronExpression(cron: string): {
  valid: boolean;
  error?: string;
} {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    return { valid: false, error: "Cron expression must have exactly 5 fields" };
  }
  return { valid: true };
}

/**
 * Basic static validation of workflow code before saving/running.
 */
export function validateWorkflowCode(code: string): CodeValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!/export\s+default\s+/.test(code)) {
    errors.push(
      "Workflow code must have a default export (e.g., `export default { start: () => worker.start() };`)"
    );
  }

  const secretPatterns = [
    /sk-[a-zA-Z0-9]{20,}/,
    /xoxb-[0-9]+-[a-zA-Z0-9]+/,
    /gh[pousr]_[A-Za-z0-9]{36}/,
    /AKIA[0-9A-Z]{16}/,
  ];
  for (const pattern of secretPatterns) {
    if (pattern.test(code)) {
      warnings.push(
        "Possible hardcoded secret detected. Use process.env.VARIABLE_NAME instead."
      );
      break;
    }
  }

  if (
    !/@hatchet-dev\/typescript-sdk/.test(code) &&
    !/from ['"]@hatchet/.test(code)
  ) {
    warnings.push(
      "No Hatchet import detected. Workflow code should import from @hatchet-dev/typescript-sdk."
    );
  }

  // Block requests to internal/private network addresses (SSRF prevention)
  const ssrfPatterns = [
    /169\.254\.169\.254/,          // cloud metadata (AWS, GCP, Azure)
    /100\.100\.100\.200/,          // Alibaba Cloud metadata
    /192\.168\.\d+\.\d+/,         // RFC 1918 private
    /10\.\d+\.\d+\.\d+/,          // RFC 1918 private
    /172\.(1[6-9]|2\d|3[01])\.\d+\.\d+/, // RFC 1918 private
    /\blocalhost\b/,
    /127\.\d+\.\d+\.\d+/,         // loopback
    /\[::1\]/,                     // IPv6 loopback
  ];
  for (const pattern of ssrfPatterns) {
    if (pattern.test(code)) {
      errors.push("Requests to internal or private network addresses are not allowed.");
      break;
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Returns the Hatchet-internal workflow name for a given human name + session.
 * Format: <8-char session prefix>-<kebab-name>
 * e.g. "a1b2c3d4-weather-report"
 *
 * This is the single source of truth used by:
 *   - injectWorkflowName (written into compiled workflow code)
 *   - hatchet.runNoWait (routing runs to the correct worker)
 *   - the runs nameMap (linking Hatchet run history back to our workflow IDs)
 */
export function hatchetWorkflowName(workflowName: string, sessionId: string): string {
  const prefix = sessionId.slice(0, 8);
  const kebab = workflowName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${prefix}-${kebab}`;
}

/**
 * Inject the session-scoped Hatchet workflow name into generated code so the
 * worker registers under the right name and runs are routed correctly.
 */
export function injectWorkflowName(code: string, workflowName: string, sessionId: string): string {
  const finalName = hatchetWorkflowName(workflowName, sessionId);

  return code.replace(
    /hatchet\.workflow\(\s*\{([^}]*?)name\s*:\s*["'][^"']*["']/,
    (match) => match.replace(/name\s*:\s*["'][^"']*["']/, `name: "${finalName}"`)
  );
}
