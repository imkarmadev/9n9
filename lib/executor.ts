import {
  createRun,
  finishRun,
  getWorkflow,
} from "./repository";
import { resolveTemplate } from "./template";
import {
  applyHttpCredential,
  credentialSecretValues,
  getCredential,
  markCredentialUsed,
} from "./credentials";
import { redactSecrets } from "./redaction";
import type {
  NodeConfig,
  NodeTestResult,
  RunTrace,
  Workflow,
  WorkflowNode,
  WorkflowRun,
} from "./types";

const CODEX_AGENT_URL =
  process.env.CODEX_AGENT_URL ?? "http://codex-agent:8080";

function asString(value: unknown, fallback = "") {
  if (value === undefined || value === null) return fallback;
  return typeof value === "string" ? value : JSON.stringify(value);
}

export async function testWorkflowNode(
  workflowOrId: Workflow | string,
  nodeId: string,
  input: unknown = {},
  steps: Record<string, unknown> = {},
): Promise<NodeTestResult> {
  const workflow =
    typeof workflowOrId === "string"
      ? getWorkflow(workflowOrId)
      : workflowOrId;
  if (!workflow) throw new Error("Workflow not found");
  if (workflow.archivedAt) throw new Error("Archived workflows cannot run");

  const node = workflow.graph.nodes.find((item) => item.id === nodeId);
  if (!node) throw new Error("Node not found");

  const startedAt = Date.now();
  try {
    const output = await executeNode(node, { input, steps });
    return {
      nodeId: node.id,
      label: node.data.label,
      kind: node.data.kind,
      status: "success",
      input,
      output: safeOutput(output),
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      nodeId: node.id,
      label: node.data.label,
      kind: node.data.kind,
      status: "failed",
      input,
      error: error instanceof Error ? error.message : "Unknown node error",
      durationMs: Date.now() - startedAt,
    };
  }
}

function safeOutput(value: unknown) {
  const serialized = JSON.stringify(value);
  if (!serialized || serialized.length <= 12_000) return value;
  return {
    truncated: true,
    preview: serialized.slice(0, 12_000),
  };
}

async function responseBody(response: Response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function runHttp(config: NodeConfig, context: ExecutionContext) {
  const resolved = resolveTemplate(config, context) as NodeConfig;
  const url = asString(resolved.url);
  if (!url) throw new Error("HTTP node needs a URL");

  const method = asString(resolved.method, "GET").toUpperCase();
  let headers: Record<string, string> = {};
  if (resolved.headers && typeof resolved.headers === "object") {
    headers = resolved.headers as Record<string, string>;
  } else if (typeof resolved.headers === "string" && resolved.headers.trim()) {
    try {
      headers = JSON.parse(resolved.headers) as Record<string, string>;
    } catch {
      throw new Error("HTTP headers must be a valid JSON object");
    }
  }

  let credentialSecrets: string[] = [];
  const credentialId = asString(resolved.credentialId);
  if (credentialId) {
    const credential = getCredential(credentialId);
    if (!credential) throw new Error("Selected credential no longer exists");
    credentialSecrets = credentialSecretValues(credential.data);
    applyHttpCredential(credential.summary.type, credential.data, headers);
    markCredentialUsed(credentialId);
  }

  const init: RequestInit = {
    method,
    headers,
    signal: AbortSignal.timeout(30_000),
  };

  if (!["GET", "HEAD"].includes(method) && resolved.body !== undefined) {
    init.body =
      typeof resolved.body === "string"
        ? resolved.body
        : JSON.stringify(resolved.body);
    if (
      !Object.keys(headers).some(
        (key) => key.toLowerCase() === "content-type",
      )
    ) {
      (init.headers as Record<string, string>)["content-type"] =
        "application/json";
    }
  }

  const response = await fetch(url, init);
  const body = await responseBody(response);
  if (!response.ok) {
    throw new Error(
      "HTTP " + response.status + ": " + asString(redactSecrets(body, credentialSecrets), response.statusText),
    );
  }

  return redactSecrets({
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body,
  }, credentialSecrets);
}

async function runCodex(config: NodeConfig, context: ExecutionContext) {
  const resolved = resolveTemplate(config, context) as NodeConfig;
  const prompt = asString(resolved.prompt);
  if (!prompt) throw new Error("Codex node needs a prompt");

  const response = await fetch(CODEX_AGENT_URL + "/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      prompt,
      cwd: asString(resolved.cwd, "/workspace"),
    }),
    signal: AbortSignal.timeout(120_000),
  });

  const body = await responseBody(response);
  if (!response.ok) {
    throw new Error(
      "Codex bridge " +
        response.status +
        ": " +
        asString(body, response.statusText),
    );
  }
  return body;
}

function runCompose(config: NodeConfig, context: ExecutionContext) {
  const value = config.value ?? {};
  if (typeof value !== "string") return resolveTemplate(value, context);

  const rendered = asString(resolveTemplate(value, context));
  try {
    return JSON.parse(rendered);
  } catch {
    return rendered;
  }
}

function runCondition(config: NodeConfig, context: ExecutionContext) {
  const left = resolveTemplate(config.left, context);
  const right = resolveTemplate(config.right, context);
  const operation = asString(config.operation, "equals");

  switch (operation) {
    case "not_equals":
      return left !== right;
    case "contains":
      return asString(left).includes(asString(right));
    case "truthy":
      return Boolean(left);
    default:
      return left === right || asString(left) === asString(right);
  }
}

type ExecutionContext = {
  input: unknown;
  steps: Record<string, unknown>;
};

async function executeNode(
  node: WorkflowNode,
  context: ExecutionContext,
): Promise<unknown> {
  switch (node.data.kind) {
    case "trigger.manual":
    case "trigger.webhook":
    case "trigger.schedule":
      return context.input;
    case "action.codex":
      return runCodex(node.data.config, context);
    case "action.http":
      return runHttp(node.data.config, context);
    case "data.compose":
      return runCompose(node.data.config, context);
    case "logic.condition":
      return runCondition(node.data.config, context);
  }
}

function findStartNode(workflow: Workflow, triggerType: string) {
  const exactKind =
    triggerType === "webhook"
      ? "trigger.webhook"
      : triggerType === "schedule"
        ? "trigger.schedule"
        : "trigger.manual";

  return (
    workflow.graph.nodes.find((node) => node.data.kind === exactKind) ??
    workflow.graph.nodes.find((node) => node.data.kind.startsWith("trigger."))
  );
}

export async function executeWorkflow(
  workflowOrId: Workflow | string,
  triggerType = "manual",
  input: unknown = {},
): Promise<WorkflowRun> {
  const workflow =
    typeof workflowOrId === "string"
      ? getWorkflow(workflowOrId)
      : workflowOrId;

  if (!workflow) throw new Error("Workflow not found");

  if (workflow.archivedAt) throw new Error("Archived workflows cannot run");

  const run = createRun(workflow.id, triggerType, input);
  const trace: RunTrace[] = [];
  const context: ExecutionContext = { input, steps: {} };
  const start = findStartNode(workflow, triggerType);

  if (!start) {
    return finishRun(run.id, {
      status: "failed",
      error: "This flow has no trigger node",
      output: null,
      trace,
    })!;
  }

  const nodes = new Map(workflow.graph.nodes.map((node) => [node.id, node]));
  const queue = [start.id];
  const visited = new Set<string>();
  let lastOutput: unknown = input;

  try {
    while (queue.length) {
      const nodeId = queue.shift()!;
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);

      const node = nodes.get(nodeId);
      if (!node) continue;

      const startedAt = new Date();
      try {
        const output = await executeNode(node, context);
        lastOutput = output;
        context.steps[node.id] = output;
        trace.push({
          nodeId: node.id,
          label: node.data.label,
          kind: node.data.kind,
          status: "success",
          startedAt: startedAt.toISOString(),
          durationMs: Date.now() - startedAt.getTime(),
          output: safeOutput(output),
        });

        let outgoing = workflow.graph.edges.filter(
          (edge) => edge.source === node.id,
        );

        if (node.data.kind === "logic.condition") {
          const branch = output ? "true" : "false";
          const explicitBranches = outgoing.some((edge) => edge.sourceHandle);
          if (explicitBranches) {
            outgoing = outgoing.filter(
              (edge) => edge.sourceHandle === branch,
            );
          }
        }

        queue.push(...outgoing.map((edge) => edge.target));
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown node error";
        trace.push({
          nodeId: node.id,
          label: node.data.label,
          kind: node.data.kind,
          status: "failed",
          startedAt: startedAt.toISOString(),
          durationMs: Date.now() - startedAt.getTime(),
          error: message,
        });
        throw error;
      }
    }

    return finishRun(run.id, {
      status: "success",
      output: safeOutput(lastOutput),
      trace,
    })!;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown workflow error";
    return finishRun(run.id, {
      status: "failed",
      error: message,
      output: safeOutput(lastOutput),
      trace,
    })!;
  }
}
