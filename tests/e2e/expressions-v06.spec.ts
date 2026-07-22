import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

type NodeData = {
  kind: string;
  label: string;
  config: Record<string, unknown>;
  samples?: { development?: unknown; production?: unknown };
};
type GraphNode = { id: string; type: "n9n"; position: { x: number; y: number }; data: NodeData };
type Workflow = { id: string; name: string; graph: { nodes: GraphNode[]; edges: Array<Record<string, unknown>> } };
let createdIds: string[] = [];

function secureHeaders() {
  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? "3109"}`;
  return {
    origin: baseURL,
    "x-9n9-csrf": readFileSync(path.join(process.cwd(), ".test-data", "csrf-token"), "utf8"),
  };
}

function expressionGraph(value: unknown = "") {
  return {
    nodes: [
      { id: "trigger", type: "n9n" as const, position: { x: 80, y: 160 }, data: { kind: "trigger.manual", label: "Start", config: {} } },
      { id: "compose", type: "n9n" as const, position: { x: 400, y: 160 }, data: { kind: "data.compose", label: "Transform", config: { value } } },
    ],
    edges: [{ id: "trigger-compose", source: "trigger", target: "compose" }],
  };
}

async function createWorkflow(request: APIRequestContext, graph = expressionGraph()) {
  const response = await request.post("/api/workflows", { data: { name: `[e2e] v06 ${Date.now()}-${Math.random()}`, graph }, headers: secureHeaders() });
  expect(response.ok()).toBeTruthy();
  const workflow = (await response.json()) as Workflow;
  createdIds.push(workflow.id);
  return workflow;
}

async function openWorkflow(page: Page, workflow: Workflow) {
  await page.goto("/");
  await page.locator(".flow-list button").filter({ hasText: workflow.name }).click();
  await expect(page.getByLabel("Flow name")).toHaveValue(workflow.name);
}

async function savedWorkflow(request: APIRequestContext, id: string) {
  const response = await request.get(`/api/workflows/${id}`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as Workflow;
}

test.beforeEach(() => { createdIds = []; });
test.afterEach(async ({ request }) => {
  await Promise.all(createdIds.map((id) => request.delete(`/api/workflows/${id}`, { headers: secureHeaders() })));
});

test("preview API supports fallbacks, typed transforms, JSONPath, files, binary data, and diagnostics", async ({ request }) => {
  const denied = await request.post("/api/expressions/preview", { data: { value: "{{input.value}}" } });
  expect(denied.status()).toBe(403);

  const response = await request.post("/api/expressions/preview", {
    headers: secureHeaders(),
    data: {
      value: {
        number: "{{input.amount | number}}",
        boolean: "{{input.enabled | boolean}}",
        date: "{{input.created | date}}",
        json: "{{input.serialized | json}}",
        array: "{{input.single | array}}",
        object: "{{input.objectText | object}}",
        fallback: "{{input.missing ?? \"safe\" | string}}",
        names: "{{input | jsonpath:\"$.items[*].name\"}}",
        file: "{{files.invoice.name}}",
        binary: "{{binary.photo.mimeType}}",
      },
      context: {
        input: {
          amount: "42.5",
          enabled: "false",
          created: "2026-07-22T10:00:00Z",
          serialized: "{\"ok\":true}",
          single: "one",
          objectText: "{\"nested\":1}",
          items: [{ name: "alpha" }, { name: "beta" }],
          files: { invoice: { name: "invoice.pdf" } },
          binary: { photo: { mimeType: "image/png" } },
        },
        steps: {},
      },
    },
  });
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  expect(body.value).toEqual({
    number: 42.5,
    boolean: false,
    date: "2026-07-22T10:00:00.000Z",
    json: { ok: true },
    array: ["one"],
    object: { nested: 1 },
    fallback: "safe",
    names: ["alpha", "beta"],
    file: "invoice.pdf",
    binary: "image/png",
  });
  expect(body.diagnostics).toEqual([]);
  expect(body.paths.map((entry: { path: string }) => entry.path)).toEqual(expect.arrayContaining(["files.invoice.name", "binary.photo.mimeType", "input.items[0].name"]));

  const diagnosticResponse = await request.post("/api/expressions/preview", {
    headers: secureHeaders(),
    data: { value: ["{{input.unknown}}", "{{input.value | nope}}", "{{input.value"], context: { input: { value: 1 }, steps: {} } },
  });
  const diagnostics = (await diagnosticResponse.json()).diagnostics as Array<{ code: string; severity: string }>;
  expect(diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "missing_path", severity: "warning" }),
    expect.objectContaining({ code: "unknown_transform", severity: "error" }),
    expect.objectContaining({ code: "syntax", severity: "error" }),
  ]));
});

test("highlighted editor autocompletes paths and keeps separate development and production previews", async ({ page, request }) => {
  const workflow = await createWorkflow(request);
  await openWorkflow(page, workflow);

  await page.locator(".flow-node--trigger-manual").click();
  const inspector = page.locator(".inspector");
  await inspector.getByLabel("Development sample JSON").fill('{"body":{"name":"Alice","amount":"7"}}');
  await inspector.getByLabel("Development sample JSON").blur();
  await inspector.getByRole("button", { name: "Production" }).click();
  await inspector.getByLabel("Production sample JSON").fill('{"body":{"name":"Bob","amount":"9"}}');
  await inspector.getByLabel("Production sample JSON").blur();

  await page.locator(".flow-node--data-compose").click();
  const value = inspector.getByLabel("Value");
  await value.fill("{{input.bo");
  await expect(inspector.getByRole("listbox", { name: "Value autocomplete" })).toBeVisible();
  await inspector.getByRole("option", { name: "input.body", exact: true }).click();
  await expect(value).toHaveValue("{{input.body}}");
  await value.fill("{{input.body.name}}");
  await expect(inspector.locator(".expression-editor pre mark")).toContainText("{{input.body.name}}");
  await expect(inspector.locator(".expression-preview pre")).toContainText("Bob");

  await inspector.getByRole("button", { name: "Development" }).click();
  await expect(inspector.locator(".expression-preview pre")).toContainText("Alice");
  await inspector.getByLabel("Search sample paths").fill("amount");
  await inspector.getByRole("button", { name: /input\.body\.amount/ }).click();
  await expect(value).toHaveValue(/\{\{input\.body\.amount\}\}/);
  await inspector.getByRole("button", { name: "number" }).click();
  await expect(value).toHaveValue(/\| number/);

  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator(".save-state")).toHaveText("Saved");
  const saved = await savedWorkflow(request, workflow.id);
  const trigger = saved.graph.nodes.find((node) => node.id === "trigger")!;
  expect(trigger.data.samples?.development).toEqual({ body: { name: "Alice", amount: "7" } });
  expect(trigger.data.samples?.production).toEqual({ body: { name: "Bob", amount: "9" } });
});

test("previous run data can be browsed and pinned into an environment", async ({ page, request }) => {
  const workflow = await createWorkflow(request, expressionGraph("{{input.body}}"));
  const runResponse = await request.post(`/api/workflows/${workflow.id}/run`, {
    headers: secureHeaders(),
    data: { input: { body: { historic: "from-run", count: 3 } } },
  });
  expect(runResponse.ok()).toBeTruthy();
  const run = await runResponse.json();

  await openWorkflow(page, workflow);
  await page.locator(".flow-node--data-compose").click();
  const inspector = page.locator(".inspector");
  await inspector.getByLabel("Expression data source").selectOption(run.id);
  await inspector.getByLabel("Search sample paths").fill("historic");
  await expect(inspector.getByRole("button", { name: /input\.body\.historic/ })).toBeVisible();
  await inspector.getByRole("button", { name: /input\.body\.historic/ }).click();
  await expect(inspector.getByLabel("Value")).toHaveValue(/\{\{input\.body\.historic\}\}/);
  await expect(inspector.locator(".expression-preview pre")).toContainText("from-run");
  await inspector.getByRole("button", { name: "Pin to development" }).click();
  await page.getByRole("button", { name: "Save" }).click();

  const saved = await savedWorkflow(request, workflow.id);
  expect(saved.graph.nodes.find((node) => node.id === "trigger")?.data.samples?.development).toEqual(run.input);
  expect(saved.graph.nodes.find((node) => node.id === "compose")?.data.samples?.development).toEqual(run.output);
});

test("execution preserves typed expression values and invalid expression syntax blocks activation", async ({ page, request }) => {
  const graph = expressionGraph({
    amount: "{{input.body.amount ?? \"5\" | number}}",
    enabled: "{{input.body.enabled | boolean}}",
    names: "{{input.body | jsonpath:\"$.items[*].name\"}}",
    fileName: "{{files.upload.name}}",
  });
  const workflow = await createWorkflow(request, graph);
  const runResponse = await request.post(`/api/workflows/${workflow.id}/run`, {
    headers: secureHeaders(),
    data: { input: { body: { amount: "8", enabled: "true", items: [{ name: "one" }, { name: "two" }] }, files: { upload: { name: "data.csv" } } } },
  });
  expect(runResponse.ok()).toBeTruthy();
  expect((await runResponse.json()).output).toEqual({ amount: 8, enabled: true, names: ["one", "two"], fileName: "data.csv" });

  const invalid = structuredClone(graph);
  invalid.nodes[1].data.config.value = "{{input.body | definitely_not_real}}";
  const update = await request.put(`/api/workflows/${workflow.id}`, { headers: secureHeaders(), data: { graph: invalid } });
  expect(update.ok()).toBeTruthy();
  const enable = await request.put(`/api/workflows/${workflow.id}`, { headers: secureHeaders(), data: { enabled: true } });
  expect(enable.status()).toBe(409);
  expect((await enable.json()).issues).toEqual(expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining("Unknown transform") })]));

  await openWorkflow(page, workflow);
  await page.locator(".flow-node--data-compose").click();
  await expect(page.getByRole("button", { name: "Workflow validation" })).toContainText("1 issues");
  await expect(page.locator(".expression-preview")).toHaveClass(/has-error/);
});
