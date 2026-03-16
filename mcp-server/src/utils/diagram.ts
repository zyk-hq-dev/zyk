/**
 * Mermaid diagram generation utilities for Zyk workflows.
 *
 * These are used as a fallback or reference — in practice, Claude generates
 * the diagram directly as part of create_workflow.
 *
 * ── HOW DIAGRAMS WORK IN THE MCP CONTEXT ─────────────────────────────────
 *
 * Claude renders `mermaid` code blocks as interactive diagrams in the
 * side panel. When Claude calls create_workflow, it should ALSO output the
 * diagram in its chat response as a fenced code block:
 *
 *   ```mermaid
 *   flowchart TD
 *     ...
 *   ```
 *
 * This triggers Claude's native Mermaid renderer. No server-side SVG
 * rendering is needed.
 *
 * The `diagram` field in create_workflow is stored alongside the workflow for
 * reference (e.g. in get_status output), not for server-side rendering.
 *
 * ── STYLE GUIDE FOR CLAUDE ───────────────────────────────────────────────
 *
 * Use these Mermaid conventions when generating diagrams for Zyk workflows:
 *
 *   flowchart TD
 *   %%{init: {"theme": "dark", "themeVariables": {"primaryColor": "#6366f1",
 *   "primaryTextColor": "#fafafa", "primaryBorderColor": "#3f3f46",
 *   "lineColor": "#52525b", "background": "#111113",
 *   "fontFamily": "Inter, system-ui, sans-serif"}}}%%
 *
 *   Node shapes:
 *     START(["▶ Trigger name"])          ← rounded stadium: trigger/start
 *     STEP["Step name"]                  ← rectangle: normal task
 *     DECISION{"Condition?"}            ← diamond: branching logic
 *     PARALLEL[/"Parallel step"/]       ← parallelogram: concurrent execution
 *     END(["✓ Done"])                    ← rounded stadium: terminal node
 *
 *   Labels on edges:
 *     DECISION -->|"Yes"| STEP_A
 *     DECISION -->|"No"| STEP_B
 */

// ── Mermaid dark-theme init block ────────────────────────────────────────────

/** Prepend to any generated diagram for consistent dark styling. */
export const MERMAID_DARK_INIT = `%%{init: {"theme": "dark", "themeVariables": {
  "primaryColor": "#6366f1",
  "primaryTextColor": "#fafafa",
  "primaryBorderColor": "#3f3f46",
  "lineColor": "#52525b",
  "secondaryColor": "#27272a",
  "background": "#111113",
  "fontFamily": "Inter, system-ui, sans-serif",
  "fontSize": "13px"
}}}%%`;

// ── Types ─────────────────────────────────────────────────────────────────────

export type StepType = "task" | "decision" | "parallel" | "start" | "end";

export interface DiagramStep {
  /** Node ID — must be unique, alphanumeric + hyphens */
  id: string;
  /** Display label */
  label: string;
  type?: StepType;
  /** IDs of nodes this step connects to. For decisions, use edges instead. */
  next?: string[];
}

export interface DiagramEdge {
  from: string;
  to: string;
  /** Optional label shown on the arrow */
  label?: string;
}

// ── Node shape helpers ────────────────────────────────────────────────────────

function nodeShape(step: DiagramStep): string {
  const label = JSON.stringify(step.label); // quote and escape
  switch (step.type) {
    case "start":
    case "end":
      return `${step.id}(["${step.label}"])`;
    case "decision":
      return `${step.id}{${label}}`;
    case "parallel":
      return `${step.id}[/${label}/]`;
    default:
      return `${step.id}[${label}]`;
  }
}

// ── Primary generator ─────────────────────────────────────────────────────────

/**
 * Generate a complete Mermaid flowchart from a list of steps and optional edges.
 *
 * For simple linear workflows, just pass steps and omit edges — connections
 * are inferred from each step's `next` array.
 */
export function generateMermaidDiagram(params: {
  trigger: "on-demand" | "schedule";
  schedule?: string;
  steps: DiagramStep[];
  /** Explicit edges (for branching/parallel). Overrides step.next. */
  edges?: DiagramEdge[];
  direction?: "TD" | "LR";
}): string {
  const { trigger, schedule, steps, edges, direction = "TD" } = params;

  const lines: string[] = [MERMAID_DARK_INIT, `flowchart ${direction}`];

  // Trigger node
  let triggerLabel: string;
  if (trigger === "schedule" && schedule) {
    triggerLabel = `⏰ Schedule: ${schedule}`;
  } else {
    triggerLabel = "▶ On-demand";
  }
  lines.push(`    START(["${triggerLabel}"])`);

  // Step nodes
  for (const step of steps) {
    lines.push(`    ${nodeShape(step)}`);
  }

  // End node (if not already defined as a step)
  const hasExplicitEnd = steps.some((s) => s.type === "end");
  if (!hasExplicitEnd) {
    lines.push(`    END(["✓ Done"])`);
  }

  // Edges
  if (edges && edges.length > 0) {
    // Use explicit edges
    if (steps.length > 0) {
      lines.push(`    START --> ${steps[0].id}`);
    }
    for (const edge of edges) {
      if (edge.label) {
        lines.push(`    ${edge.from} -->|"${edge.label}"| ${edge.to}`);
      } else {
        lines.push(`    ${edge.from} --> ${edge.to}`);
      }
    }
  } else {
    // Infer edges from step.next arrays
    if (steps.length > 0) {
      lines.push(`    START --> ${steps[0].id}`);
    }
    for (const step of steps) {
      if (step.next && step.next.length > 0) {
        for (const nextId of step.next) {
          lines.push(`    ${step.id} --> ${nextId}`);
        }
      }
    }
    // Connect last step to END if it has no explicit next and END wasn't defined
    if (!hasExplicitEnd && steps.length > 0) {
      const lastStep = steps[steps.length - 1];
      if (!lastStep.next || lastStep.next.length === 0) {
        lines.push(`    ${lastStep.id} --> END`);
      }
    }
  }

  return lines.join("\n");
}

/**
 * Convenience: generate a simple linear flowchart from a list of step names.
 * Good for quickly visualising sequential workflows.
 */
export function generateSimpleDiagram(params: {
  trigger: "on-demand" | "schedule";
  schedule?: string;
  stepNames: string[];
  direction?: "TD" | "LR";
}): string {
  const { stepNames, ...rest } = params;

  const steps: DiagramStep[] = stepNames.map((label, i) => ({
    id: `step${i}`,
    label,
    type: "task",
    next: i < stepNames.length - 1 ? [`step${i + 1}`] : [],
  }));

  return generateMermaidDiagram({ steps, ...rest });
}
