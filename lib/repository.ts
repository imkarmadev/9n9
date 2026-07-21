import { randomUUID } from "node:crypto";
import { db } from "./db";
import { audit, hashToken, newSecretToken, verifyToken } from "./security";
import {
  EMPTY_GRAPH,
  type Workflow,
  type WorkflowGraph,
  type WorkflowRun,
} from "./types";

interface WorkflowRow {
  id: string;
  name: string;
  slug: string;
  enabled: number;
  graph: string;
  created_at: string;
  updated_at: string;
  webhook_token_hash: string | null;
}

interface RunRow {
  id: string;
  workflow_id: string;
  workflow_name?: string;
  status: WorkflowRun["status"];
  trigger_type: string;
  input: string | null;
  output: string | null;
  error: string | null;
  trace: string;
  started_at: string;
  finished_at: string | null;
}

function parseJson(value: string | null, fallback: unknown = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function mapWorkflow(row: WorkflowRow): Workflow {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    enabled: Boolean(row.enabled),
    graph: parseJson(row.graph, EMPTY_GRAPH) as WorkflowGraph,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    webhookProtected: Boolean(row.webhook_token_hash),
  };
}

function mapRun(row: RunRow): WorkflowRun {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    workflowName: row.workflow_name,
    status: row.status,
    triggerType: row.trigger_type,
    input: parseJson(row.input),
    output: parseJson(row.output),
    error: row.error ?? undefined,
    trace: parseJson(row.trace, []) as WorkflowRun["trace"],
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
  };
}

function slugify(value: string) {
  return (
    value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "flow"
  );
}

function uniqueSlug(name: string, ignoreId?: string) {
  const base = slugify(name);
  let candidate = base;
  let suffix = 2;

  while (
    db
      .prepare(
        "SELECT 1 FROM workflows WHERE slug = ? AND (? IS NULL OR id != ?)",
      )
      .get(candidate, ignoreId ?? null, ignoreId ?? null)
  ) {
    candidate = base + "-" + suffix;
    suffix += 1;
  }

  return candidate;
}

export function ensureStarterWorkflow() {
  const now = new Date().toISOString();
  const graph: WorkflowGraph = {
    nodes: [
      EMPTY_GRAPH.nodes[0],
      {
        id: "codex",
        type: "n9n",
        position: { x: 400, y: 160 },
        data: {
          kind: "action.codex",
          label: "Ask local Codex",
          config: {
            prompt:
              "Reply with a short confirmation that the 9n9 local Codex bridge is working.",
          },
        },
      },
    ],
    edges: [{ id: "trigger-codex", source: "trigger", target: "codex" }],
  };

  db.prepare(
    `INSERT OR IGNORE INTO workflows
      (id, name, slug, enabled, graph, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM workflows)`,
  ).run(
    randomUUID(),
    "Local Codex check",
    "local-codex-check",
    1,
    JSON.stringify(graph),
    now,
    now,
  );
}

export function listWorkflows(): Workflow[] {
  ensureStarterWorkflow();
  return (
    db
      .prepare("SELECT * FROM workflows ORDER BY updated_at DESC")
      .all() as WorkflowRow[]
  ).map(mapWorkflow);
}

export function getWorkflow(id: string): Workflow | null {
  const row = db.prepare("SELECT * FROM workflows WHERE id = ?").get(id) as
    | WorkflowRow
    | undefined;
  return row ? mapWorkflow(row) : null;
}

export function getWorkflowBySlug(slug: string): Workflow | null {
  const row = db.prepare("SELECT * FROM workflows WHERE slug = ?").get(slug) as
    | WorkflowRow
    | undefined;
  return row ? mapWorkflow(row) : null;
}

export function createWorkflow(name = "Untitled flow"): Workflow {
  const id = randomUUID();
  const now = new Date().toISOString();
  const slug = uniqueSlug(name);
  const webhookToken = newSecretToken();

  db.prepare(
    `INSERT INTO workflows
      (id, name, slug, enabled, graph, webhook_token_hash, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?)` ,
  ).run(id, name, slug, JSON.stringify(EMPTY_GRAPH), hashToken(webhookToken), now, now);

  return { ...getWorkflow(id)!, webhookToken };
}

export function rotateWebhookToken(
  id: string,
  actor?: { userId?: string; ip?: string },
) {
  if (!getWorkflow(id)) return null;
  const token = newSecretToken();
  db.prepare("UPDATE workflows SET webhook_token_hash = ?, updated_at = ? WHERE id = ?")
    .run(hashToken(token), new Date().toISOString(), id);
  audit("webhook.token_rotated", {
    ...actor,
    resourceType: "workflow",
    resourceId: id,
  });
  return { token };
}

export function verifyWebhookToken(workflowId: string, token: string) {
  const row = db.prepare("SELECT webhook_token_hash FROM workflows WHERE id = ?").get(workflowId) as { webhook_token_hash: string | null } | undefined;
  return Boolean(row?.webhook_token_hash && verifyToken(token, row.webhook_token_hash));
}

export function updateWorkflow(
  id: string,
  patch: Partial<Pick<Workflow, "name" | "enabled" | "graph">>,
): Workflow | null {
  const current = getWorkflow(id);
  if (!current) return null;

  const name = patch.name?.trim() || current.name;
  const updatedAt = new Date().toISOString();
  const slug =
    name === current.name ? current.slug : uniqueSlug(name, current.id);

  db.prepare(
    `UPDATE workflows
     SET name = ?, slug = ?, enabled = ?, graph = ?, updated_at = ?
     WHERE id = ?` ,
  ).run(
    name,
    slug,
    Number(patch.enabled ?? current.enabled),
    JSON.stringify(patch.graph ?? current.graph),
    updatedAt,
    id,
  );

  return getWorkflow(id);
}

export function deleteWorkflow(id: string) {
  return db.prepare("DELETE FROM workflows WHERE id = ?").run(id).changes > 0;
}

export function createRun(
  workflowId: string,
  triggerType: string,
  input: unknown,
): WorkflowRun {
  const id = randomUUID();
  const startedAt = new Date().toISOString();

  db.prepare(
    `INSERT INTO runs
      (id, workflow_id, status, trigger_type, input, trace, started_at)
     VALUES (?, ?, 'running', ?, ?, '[]', ?)` ,
  ).run(id, workflowId, triggerType, JSON.stringify(input ?? null), startedAt);

  return getRun(id)!;
}

export function finishRun(
  id: string,
  result: Pick<WorkflowRun, "status" | "output" | "error" | "trace">,
) {
  db.prepare(
    `UPDATE runs
     SET status = ?, output = ?, error = ?, trace = ?, finished_at = ?
     WHERE id = ?` ,
  ).run(
    result.status,
    JSON.stringify(result.output ?? null),
    result.error ?? null,
    JSON.stringify(result.trace),
    new Date().toISOString(),
    id,
  );
  return getRun(id);
}

export function getRun(id: string): WorkflowRun | null {
  const row = db
    .prepare(
      `SELECT runs.*, workflows.name AS workflow_name
       FROM runs JOIN workflows ON workflows.id = runs.workflow_id
       WHERE runs.id = ?` ,
    )
    .get(id) as RunRow | undefined;
  return row ? mapRun(row) : null;
}

export function listRuns(limit = 50): WorkflowRun[] {
  return (
    db
      .prepare(
        `SELECT runs.*, workflows.name AS workflow_name
         FROM runs JOIN workflows ON workflows.id = runs.workflow_id
         ORDER BY runs.started_at DESC LIMIT ?` ,
      )
      .all(limit) as RunRow[]
  ).map(mapRun);
}
