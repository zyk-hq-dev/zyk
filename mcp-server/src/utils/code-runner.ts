/**
 * Utilities for validating and preparing TypeScript workflow code
 * before handing it off to the Hatchet worker subprocess.
 */

export interface CodeValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Basic static validation of workflow code before saving/running.
 * Does NOT execute the code — just checks for obvious issues.
 */
export function validateWorkflowCode(code: string): CodeValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Must have a default export (the Hatchet worker)
  if (!/export\s+default\s+/.test(code)) {
    errors.push(
      'Workflow code must have a default export (e.g., `export default worker;`)'
    );
  }

  // Check for hardcoded secrets (basic heuristics)
  const secretPatterns = [
    /sk-[a-zA-Z0-9]{20,}/,          // OpenAI-style keys
    /xoxb-[0-9]+-[a-zA-Z0-9]+/,    // Slack bot tokens
    /gh[pousr]_[A-Za-z0-9]{36}/,   // GitHub tokens
    /AKIA[0-9A-Z]{16}/,             // AWS access keys
  ];

  for (const pattern of secretPatterns) {
    if (pattern.test(code)) {
      warnings.push(
        'Possible hardcoded secret detected. Use process.env.VARIABLE_NAME instead.'
      );
      break;
    }
  }

  // Warn about missing error handling in fetch calls
  const fetchCount = (code.match(/\bfetch\(/g) ?? []).length;
  const tryCatchCount = (code.match(/\btry\s*\{/g) ?? []).length;
  if (fetchCount > 0 && tryCatchCount === 0) {
    warnings.push(
      'External fetch calls detected without try/catch. Consider adding error handling.'
    );
  }

  // Must import Hatchet
  if (
    !/@hatchet-dev\/typescript-sdk/.test(code) &&
    !/from ['"]@hatchet/.test(code)
  ) {
    warnings.push(
      'No Hatchet import detected. Workflow code should import from @hatchet-dev/typescript-sdk.'
    );
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Wraps workflow code in a template that ensures it exports a startable worker.
 * Used when the user-provided code only exports workflow definitions.
 */
export function wrapWorkflowCode(
  workflowCode: string,
  workflowName: string
): string {
  // If the code already looks complete (has a worker.start()), don't wrap
  if (/\.start\(\)/.test(workflowCode)) {
    return workflowCode;
  }

  return `${workflowCode}

// Auto-generated worker wrapper
import HatchetSDK from "@hatchet-dev/typescript-sdk";

const hatchet = HatchetSDK.init();
const worker = hatchet.worker("${workflowName}-worker");
worker.registerWorkflow(workflow);

export default {
  start: () => worker.start(),
};
`;
}
