import type { WorkflowEdge, WorkflowNode } from "./types";

export type ValidationIssue = {
  id: string;
  message: string;
  nodeId?: string;
};

function isAnnotation(node: WorkflowNode) {
  return node.data.kind.startsWith("annotation.");
}

function configured(value: unknown) {
  return typeof value === "string" ? value.trim().length > 0 : value != null;
}

export function wouldCreateCycle(
  source: string,
  target: string,
  edges: Pick<WorkflowEdge, "source" | "target">[],
) {
  const queue = [target];
  const visited = new Set<string>();
  while (queue.length) {
    const current = queue.shift()!;
    if (current === source) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    queue.push(
      ...edges
        .filter((edge) => edge.source === current)
        .map((edge) => edge.target),
    );
  }
  return false;
}

export function validateWorkflowGraph(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const executableNodes = nodes.filter((node) => !isAnnotation(node));
  const nodeIds = new Set(executableNodes.map((node) => node.id));

  if (!executableNodes.some((node) => node.data.kind.startsWith("trigger."))) {
    issues.push({ id: "missing-trigger", message: "Add a trigger node." });
  }

  for (const edge of edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      issues.push({
        id: "broken-edge-" + edge.id,
        message: "A connection points to a missing node.",
      });
    }
  }

  for (const node of executableNodes) {
    const incoming = edges.filter((edge) => edge.target === node.id);
    if (!node.data.kind.startsWith("trigger.") && incoming.length === 0) {
      issues.push({
        id: "disconnected-" + node.id,
        nodeId: node.id,
        message: node.data.label + " is not connected to an input.",
      });
    }
    if (node.data.kind.startsWith("trigger.") && incoming.length > 0) {
      issues.push({
        id: "trigger-input-" + node.id,
        nodeId: node.id,
        message: node.data.label + " is a trigger and cannot have an input.",
      });
    }
    if (incoming.length > 1) {
      issues.push({
        id: "multiple-inputs-" + node.id,
        nodeId: node.id,
        message: node.data.label + " has more than one input.",
      });
    }

    const config = node.data.config;
    if (node.data.kind === "action.http" && !configured(config.url)) {
      issues.push({
        id: "http-url-" + node.id,
        nodeId: node.id,
        message: node.data.label + " needs a URL.",
      });
    }
    if (node.data.kind === "action.codex" && !configured(config.prompt)) {
      issues.push({
        id: "codex-prompt-" + node.id,
        nodeId: node.id,
        message: node.data.label + " needs a prompt.",
      });
    }
    if (node.data.kind === "trigger.schedule" && !configured(config.cron)) {
      issues.push({
        id: "schedule-cron-" + node.id,
        nodeId: node.id,
        message: node.data.label + " needs a cron schedule.",
      });
    }
  }

  for (const edge of edges) {
    const remaining = edges.filter((candidate) => candidate.id !== edge.id);
    if (wouldCreateCycle(edge.source, edge.target, remaining)) {
      issues.push({
        id: "cycle-" + edge.id,
        nodeId: edge.source,
        message: "Connections cannot form a cycle.",
      });
      break;
    }
  }

  return issues;
}
