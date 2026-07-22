export type NodeKind =
  | "trigger.manual"
  | "trigger.webhook"
  | "trigger.schedule"
  | "action.codex"
  | "action.http"
  | "data.compose"
  | "logic.condition";

export type NodeConfig = Record<string, unknown>;

export interface WorkflowNodeData extends Record<string, unknown> {
  kind: NodeKind;
  label: string;
  config: NodeConfig;
}

export interface WorkflowNode {
  id: string;
  type: "n9n";
  position: { x: number; y: number };
  data: WorkflowNodeData;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface Workflow {
  id: string;
  name: string;
  slug: string;
  enabled: boolean;
  graph: WorkflowGraph;
  createdAt: string;
  updatedAt: string;
  webhookProtected: boolean;
  webhookToken?: string;
  description: string;
  tags: string[];
  archivedAt?: string;
}

export interface WorkflowSnapshot {
  name: string;
  slug: string;
  description: string;
  tags: string[];
  enabled: boolean;
  graph: WorkflowGraph;
}

export interface WorkflowVersion {
  id: string;
  workflowId: string;
  version: number;
  snapshot: WorkflowSnapshot;
  reason: string;
  createdAt: string;
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  tags: string[];
  graph: WorkflowGraph;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowExport {
  format: "9n9.workflow";
  version: 1;
  exportedAt: string;
  workflow: Omit<WorkflowSnapshot, "enabled">;
}

export type RunStatus = "running" | "success" | "failed";

export interface RunTrace {
  nodeId: string;
  label: string;
  kind: NodeKind;
  status: "success" | "failed" | "skipped";
  startedAt: string;
  durationMs: number;
  output?: unknown;
  error?: string;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  workflowName?: string;
  status: RunStatus;
  triggerType: string;
  input: unknown;
  output?: unknown;
  error?: string;
  trace: RunTrace[];
  startedAt: string;
  finishedAt?: string;
}

export interface NodeTestResult {
  nodeId: string;
  label: string;
  kind: NodeKind;
  status: "success" | "failed";
  input: unknown;
  output?: unknown;
  error?: string;
  durationMs: number;
}

export const EMPTY_GRAPH: WorkflowGraph = {
  nodes: [
    {
      id: "trigger",
      type: "n9n",
      position: { x: 80, y: 160 },
      data: {
        kind: "trigger.manual",
        label: "When I click run",
        config: {},
      },
    },
  ],
  edges: [],
};
