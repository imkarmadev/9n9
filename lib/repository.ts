import { randomUUID } from "node:crypto";
import { db } from "./db";
import { audit, hashToken, newSecretToken, verifyToken } from "./security";
import {
  EMPTY_GRAPH,
  type Workflow,
  type WorkflowExport,
  type WorkflowGraph,
  type WorkflowRun,
  type WorkflowSnapshot,
  type WorkflowTemplate,
  type WorkflowVersion,
} from "./types";
import { validateWorkflowGraph } from "./workflow-validation";

interface WorkflowRow {
  id: string;
  name: string;
  slug: string;
  enabled: number;
  graph: string;
  created_at: string;
  updated_at: string;
  webhook_token_hash: string | null;
  description: string;
  tags: string;
  archived_at: string | null;
}

interface WorkflowVersionRow {
  id: string;
  workflow_id: string;
  version: number;
  snapshot: string;
  reason: string;
  created_at: string;
}

interface WorkflowTemplateRow {
  id: string;
  name: string;
  description: string;
  tags: string;
  graph: string;
  created_at: string;
  updated_at: string;
}

type Actor = { userId?: string; ip?: string };

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
    description: row.description ?? "",
    tags: parseJson(row.tags, []) as string[],
    archivedAt: row.archived_at ?? undefined,
  };
}

function mapVersion(row: WorkflowVersionRow): WorkflowVersion {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    version: row.version,
    snapshot: parseJson(row.snapshot, {}) as WorkflowSnapshot,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

function mapTemplate(row: WorkflowTemplateRow): WorkflowTemplate {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    tags: parseJson(row.tags, []) as string[],
    graph: parseJson(row.graph, EMPTY_GRAPH) as WorkflowGraph,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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

export function slugify(value: string) {
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

function assertSlugAvailable(slug: string, ignoreId?: string) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error("Webhook slug must use lowercase letters, numbers, and hyphens");
  }
  if (db.prepare("SELECT 1 FROM workflows WHERE slug = ? AND (? IS NULL OR id != ?)").get(slug, ignoreId ?? null, ignoreId ?? null)) {
    throw new Error("Webhook slug already exists");
  }
}

function normalizeTags(value: unknown, fallback: string[] = []) {
  if (value === undefined) return fallback;
  if (!Array.isArray(value)) throw new Error("Tags must be an array");
  return [...new Set(value.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean))]
    .slice(0, 12)
    .map((tag) => tag.slice(0, 32));
}

function assertGraph(value: unknown): asserts value is WorkflowGraph {
  if (!value || typeof value !== "object" || !Array.isArray((value as WorkflowGraph).nodes) || !Array.isArray((value as WorkflowGraph).edges)) {
    throw new Error("Invalid workflow graph");
  }
}

function snapshot(workflow: Workflow): WorkflowSnapshot {
  return {
    name: workflow.name,
    slug: workflow.slug,
    description: workflow.description,
    tags: workflow.tags,
    enabled: workflow.enabled,
    graph: workflow.graph,
  };
}

function saveWorkflowVersion(workflow: Workflow, reason: string) {
  const value = JSON.stringify(snapshot(workflow));
  const latest = db.prepare("SELECT snapshot FROM workflow_versions WHERE workflow_id = ? ORDER BY version DESC LIMIT 1").get(workflow.id) as { snapshot: string } | undefined;
  if (latest?.snapshot === value) return;
  const next = (db.prepare("SELECT COALESCE(MAX(version), 0) + 1 AS version FROM workflow_versions WHERE workflow_id = ?").get(workflow.id) as { version: number }).version;
  db.prepare("INSERT INTO workflow_versions (id, workflow_id, version, snapshot, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(randomUUID(), workflow.id, next, value, reason.slice(0, 50), new Date().toISOString());
  db.prepare(`DELETE FROM workflow_versions WHERE id IN (
    SELECT id FROM workflow_versions WHERE workflow_id = ? ORDER BY version DESC LIMIT -1 OFFSET 100
  )`).run(workflow.id);
}

function stripCredentialBindings(graph: WorkflowGraph): WorkflowGraph {
  const cloned = structuredClone(graph);
  for (const node of cloned.nodes) {
    if ("credentialId" in node.data.config) delete node.data.config.credentialId;
  }
  return cloned;
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

  const inserted = db.prepare(
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
  if (inserted.changes) saveWorkflowVersion(getWorkflowBySlug("local-codex-check")!, "created");
}

export function listWorkflows(options: {
  search?: string;
  archived?: "active" | "archived" | "all";
  sort?: "updated" | "created" | "name";
} = {}): Workflow[] {
  ensureStarterWorkflow();
  const clauses: string[] = [];
  const values: string[] = [];
  const archived = options.archived ?? "active";
  if (archived === "active") clauses.push("archived_at IS NULL");
  if (archived === "archived") clauses.push("archived_at IS NOT NULL");
  const search = options.search?.trim();
  if (search) {
    clauses.push("(name LIKE ? OR description LIKE ? OR tags LIKE ?)");
    values.push(`%${search}%`, `%${search}%`, `%${search.toLowerCase()}%`);
  }
  const order = options.sort === "name"
    ? "name COLLATE NOCASE ASC"
    : options.sort === "created"
      ? "created_at DESC"
      : "updated_at DESC";
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  return (db.prepare(`SELECT * FROM workflows${where} ORDER BY ${order}`).all(...values) as WorkflowRow[]).map(mapWorkflow);
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

export function createWorkflow(name = "Untitled flow", input: {
  description?: string;
  tags?: string[];
  graph?: WorkflowGraph;
} = {}, actor?: Actor): Workflow {
  const id = randomUUID();
  const now = new Date().toISOString();
  const slug = uniqueSlug(name);
  const webhookToken = newSecretToken();
  const graph = input.graph ?? EMPTY_GRAPH;
  assertGraph(graph);
  const tags = normalizeTags(input.tags);

  db.prepare(
    `INSERT INTO workflows
      (id, name, slug, description, tags, enabled, graph, webhook_token_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)` ,
  ).run(id, name.trim() || "Untitled flow", slug, input.description?.trim() ?? "", JSON.stringify(tags), JSON.stringify(graph), hashToken(webhookToken), now, now);

  const workflow = getWorkflow(id)!;
  saveWorkflowVersion(workflow, "created");
  audit("workflow.created", { ...actor, resourceType: "workflow", resourceId: id, metadata: { name: workflow.name } });
  return { ...workflow, webhookToken };
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
  patch: Partial<Pick<Workflow, "name" | "slug" | "description" | "tags" | "enabled" | "graph">> & {
    forceEnableInvalid?: boolean;
    reason?: string;
  },
  actor?: Actor,
): Workflow | null {
  const current = getWorkflow(id);
  if (!current) return null;

  const name = patch.name?.trim() || current.name;
  const updatedAt = new Date().toISOString();
  const slug = patch.slug === undefined ? current.slug : slugify(patch.slug);
  assertSlugAvailable(slug, current.id);
  const graph = patch.graph ?? current.graph;
  assertGraph(graph);
  const enabled = patch.enabled ?? current.enabled;
  if (current.archivedAt && enabled) throw new Error("Restore the workflow before enabling it");
  const issues = validateWorkflowGraph(graph.nodes, graph.edges);
  if (enabled && !current.enabled && issues.length && !patch.forceEnableInvalid) {
    const error = new Error("Workflow has validation issues") as Error & { code?: string; issues?: unknown };
    error.code = "INVALID_WORKFLOW";
    error.issues = issues;
    throw error;
  }
  const tags = normalizeTags(patch.tags, current.tags);

  db.prepare(
    `UPDATE workflows
     SET name = ?, slug = ?, description = ?, tags = ?, enabled = ?, graph = ?, updated_at = ?
     WHERE id = ?` ,
  ).run(
    name,
    slug,
    patch.description === undefined ? current.description : patch.description.trim().slice(0, 2000),
    JSON.stringify(tags),
    Number(enabled),
    JSON.stringify(graph),
    updatedAt,
    id,
  );

  const workflow = getWorkflow(id)!;
  saveWorkflowVersion(workflow, patch.reason ?? "saved");
  audit("workflow.updated", { ...actor, resourceType: "workflow", resourceId: id });
  return workflow;
}

export function deleteWorkflow(id: string, actor?: Actor) {
  const current = getWorkflow(id);
  if (!current) return false;
  const deleted = db.prepare("DELETE FROM workflows WHERE id = ?").run(id).changes > 0;
  if (deleted) audit("workflow.deleted", { ...actor, resourceType: "workflow", resourceId: id, metadata: { name: current.name } });
  return deleted;
}

export function archiveWorkflow(id: string, actor?: Actor) {
  const current = getWorkflow(id);
  if (!current) return null;
  const now = new Date().toISOString();
  db.prepare("UPDATE workflows SET archived_at = ?, enabled = 0, updated_at = ? WHERE id = ?").run(now, now, id);
  const workflow = getWorkflow(id)!;
  saveWorkflowVersion(workflow, "archived");
  audit("workflow.archived", { ...actor, resourceType: "workflow", resourceId: id });
  return workflow;
}

export function restoreArchivedWorkflow(id: string, actor?: Actor) {
  const current = getWorkflow(id);
  if (!current) return null;
  db.prepare("UPDATE workflows SET archived_at = NULL, updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  const workflow = getWorkflow(id)!;
  saveWorkflowVersion(workflow, "unarchived");
  audit("workflow.unarchived", { ...actor, resourceType: "workflow", resourceId: id });
  return workflow;
}

export function duplicateWorkflow(id: string, actor?: Actor) {
  const source = getWorkflow(id);
  if (!source) return null;
  const copy = createWorkflow(`${source.name} copy`, {
    description: source.description,
    tags: source.tags,
    graph: structuredClone(source.graph),
  }, actor);
  audit("workflow.duplicated", { ...actor, resourceType: "workflow", resourceId: copy.id, metadata: { sourceId: id } });
  return copy;
}

export function exportWorkflow(id: string): WorkflowExport | null {
  const workflow = getWorkflow(id);
  if (!workflow) return null;
  return {
    format: "9n9.workflow",
    version: 1,
    exportedAt: new Date().toISOString(),
    workflow: {
      name: workflow.name,
      slug: workflow.slug,
      description: workflow.description,
      tags: workflow.tags,
      graph: workflow.graph,
    },
  };
}

export function importWorkflow(value: unknown, actor?: Actor) {
  if (!value || typeof value !== "object") throw new Error("Import must be a JSON object");
  const envelope = value as Partial<WorkflowExport> & { workflow?: Partial<WorkflowSnapshot> };
  if (envelope.format !== "9n9.workflow" || envelope.version !== 1 || !envelope.workflow) {
    throw new Error("Unsupported 9n9 workflow export");
  }
  assertGraph(envelope.workflow.graph);
  const imported = createWorkflow(`${envelope.workflow.name?.trim() || "Imported flow"} import`, {
    description: envelope.workflow.description,
    tags: normalizeTags(envelope.workflow.tags),
    graph: structuredClone(envelope.workflow.graph),
  }, actor);
  audit("workflow.imported", { ...actor, resourceType: "workflow", resourceId: imported.id });
  return imported;
}

export function listWorkflowVersions(workflowId: string): WorkflowVersion[] {
  return (db.prepare("SELECT * FROM workflow_versions WHERE workflow_id = ? ORDER BY version DESC").all(workflowId) as WorkflowVersionRow[]).map(mapVersion);
}

export function restoreWorkflowVersion(workflowId: string, version: number, actor?: Actor) {
  const row = db.prepare("SELECT * FROM workflow_versions WHERE workflow_id = ? AND version = ?").get(workflowId, version) as WorkflowVersionRow | undefined;
  if (!row) return null;
  const historical = mapVersion(row).snapshot;
  const restored = updateWorkflow(workflowId, {
    name: historical.name,
    slug: historical.slug,
    description: historical.description,
    tags: historical.tags,
    graph: historical.graph,
    enabled: false,
    reason: `restored v${version}`,
  }, actor);
  audit("workflow.version_restored", { ...actor, resourceType: "workflow", resourceId: workflowId, metadata: { version } });
  return restored;
}

export function listTemplates(): WorkflowTemplate[] {
  return (db.prepare("SELECT * FROM workflow_templates ORDER BY name COLLATE NOCASE").all() as WorkflowTemplateRow[]).map(mapTemplate);
}

export function createTemplate(input: {
  name?: unknown;
  description?: unknown;
  tags?: unknown;
  graph?: unknown;
}, actor?: Actor) {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new Error("Template name is required");
  assertGraph(input.graph);
  const id = randomUUID();
  const now = new Date().toISOString();
  const graph = stripCredentialBindings(input.graph);
  db.prepare("INSERT INTO workflow_templates (id, name, description, tags, graph, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, name.slice(0, 120), typeof input.description === "string" ? input.description.trim().slice(0, 2000) : "", JSON.stringify(normalizeTags(input.tags)), JSON.stringify(graph), now, now);
  audit("template.created", { ...actor, resourceType: "template", resourceId: id });
  return mapTemplate(db.prepare("SELECT * FROM workflow_templates WHERE id = ?").get(id) as WorkflowTemplateRow);
}

export function createTemplateFromWorkflow(workflowId: string, actor?: Actor) {
  const workflow = getWorkflow(workflowId);
  if (!workflow) return null;
  return createTemplate({ name: workflow.name, description: workflow.description, tags: workflow.tags, graph: workflow.graph }, actor);
}

export function instantiateTemplate(templateId: string, actor?: Actor) {
  const row = db.prepare("SELECT * FROM workflow_templates WHERE id = ?").get(templateId) as WorkflowTemplateRow | undefined;
  if (!row) return null;
  const template = mapTemplate(row);
  const workflow = createWorkflow(template.name, { description: template.description, tags: template.tags, graph: structuredClone(template.graph) }, actor);
  audit("template.instantiated", { ...actor, resourceType: "template", resourceId: templateId, metadata: { workflowId: workflow.id } });
  return workflow;
}

export function deleteTemplate(id: string, actor?: Actor) {
  const deleted = db.prepare("DELETE FROM workflow_templates WHERE id = ?").run(id).changes > 0;
  if (deleted) audit("template.deleted", { ...actor, resourceType: "template", resourceId: id });
  return deleted;
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
