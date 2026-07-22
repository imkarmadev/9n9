import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

type GraphNode = {
  id: string;
  type: "n9n";
  position: { x: number; y: number };
  data: { kind: string; label: string; config: Record<string, unknown>; notes?: string };
};

type GraphEdge = { id: string; source: string; target: string; sourceHandle?: string | null; label?: string };
type Workflow = { id: string; name: string; graph: { nodes: GraphNode[]; edges: GraphEdge[] } };
let createdIds: string[] = [];

function secureHeaders() {
  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? "3109"}`;
  return {
    origin: baseURL,
    "x-9n9-csrf": readFileSync(path.join(process.cwd(), ".test-data", "csrf-token"), "utf8"),
  };
}

async function createWorkflow(request: APIRequestContext, graph?: Workflow["graph"]) {
  const response = await request.post("/api/workflows", {
    data: { name: `[e2e] v05 ${Date.now()}-${Math.random()}` },
    headers: secureHeaders(),
  });
  expect(response.ok()).toBeTruthy();
  let workflow = (await response.json()) as Workflow;
  createdIds.push(workflow.id);
  if (graph) {
    const update = await request.put(`/api/workflows/${workflow.id}`, {
      data: { graph },
      headers: secureHeaders(),
    });
    expect(update.ok()).toBeTruthy();
    workflow = (await update.json()) as Workflow;
  }
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

test("palette search, recent nodes, node defaults, notes, panels, and shortcut help work", async ({ page, request }) => {
  const workflow = await createWorkflow(request);
  await openWorkflow(page, workflow);

  await page.getByLabel("Search nodes").fill("HTTP");
  await expect(page.locator('.palette button[data-node-kind="action.http"]')).toBeVisible();
  await expect(page.locator('.palette button[data-node-kind="action.codex"]')).toBeHidden();
  await page.locator('.palette button[data-node-kind="action.http"]').click();

  await page.locator(".inspector").getByLabel("URL").fill("https://defaults.example.test");
  await page.getByLabel("Node notes").fill("Calls the internal defaults endpoint.");
  await page.getByRole("button", { name: "Use settings as default" }).click();
  await page.getByLabel("Search nodes").fill("");
  await expect(page.locator(".palette__recent")).toContainText("HTTP");

  await page.getByLabel("Collapse inspector").click();
  await expect(page.getByLabel("Open inspector")).toBeVisible();
  await page.getByLabel("Open inspector").click();
  await page.getByLabel("Collapse node palette").click();
  await expect(page.getByLabel("Open node palette")).toBeVisible();
  await page.getByLabel("Open node palette").click();

  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toContainText("Duplicate selection");
  await page.getByLabel("Close keyboard shortcuts").click();

  await page.locator('.palette button[data-node-kind="action.http"]').last().click();
  await expect(page.locator(".inspector").getByLabel("URL")).toHaveValue("https://defaults.example.test");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator(".save-state")).toHaveText("Saved");

  const saved = await savedWorkflow(request, workflow.id);
  expect(saved.graph.nodes.some((node) => node.data.notes === "Calls the internal defaults endpoint.")).toBeTruthy();
});

test("box selection, copy paste, duplication, group movement, snap, minimap, and layout work", async ({ page, request }) => {
  const workflow = await createWorkflow(request);
  await openWorkflow(page, workflow);
  await page.locator('.palette button[data-node-kind="data.compose"]').click();
  await page.locator('.palette button[data-node-kind="action.http"]').click();
  await expect(page.locator(".react-flow__minimap")).toBeVisible();

  const boxes = await page.locator(".react-flow__node").evaluateAll((items) => items.map((item) => {
    const box = item.getBoundingClientRect();
    return { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
  }));
  const selectionBounds = {
    left: Math.min(...boxes.map((box) => box.left)) - 8,
    top: Math.min(...boxes.map((box) => box.top)) - 8,
    right: Math.max(...boxes.map((box) => box.right)) + 8,
    bottom: Math.max(...boxes.map((box) => box.bottom)) + 8,
  };
  await page.mouse.move(selectionBounds.left, selectionBounds.top);
  await page.mouse.down();
  await page.mouse.move(selectionBounds.right, selectionBounds.bottom, { steps: 12 });
  await page.mouse.up();
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(3);

  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(3);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+C" : "Control+C");
  await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
  await expect(page.locator(".react-flow__node")).toHaveCount(6);
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(3);

  const selectedIds = await page.locator(".react-flow__node.selected").evaluateAll((items) => items.map((item) => item.getAttribute("data-id")));
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator(".save-state")).toHaveText("Saved");
  const positionsBefore = new Map((await savedWorkflow(request, workflow.id)).graph.nodes.map((node) => [node.id, node.position.x]));
  await page.keyboard.press("Shift+ArrowRight");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator(".save-state")).toHaveText("Saved");
  const positionsAfter = new Map((await savedWorkflow(request, workflow.id)).graph.nodes.map((node) => [node.id, node.position.x]));
  expect(selectedIds.map((id) => (positionsAfter.get(id!) ?? 0) - (positionsBefore.get(id!) ?? 0))).toEqual([20, 20, 20]);

  await page.getByLabel("Automatic layout").click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator(".save-state")).toHaveText("Saved");
  const saved = await savedWorkflow(request, workflow.id);
  expect(saved.graph.nodes).toHaveLength(6);
  for (const node of saved.graph.nodes) {
    expect(node.position.x % 20).toBe(0);
    expect(node.position.y % 20).toBe(0);
  }
});

test("edge labels, reconnection, and deletion controls persist correctly", async ({ page, request }) => {
  const graph: Workflow["graph"] = {
    nodes: [
      { id: "start", type: "n9n", position: { x: 80, y: 160 }, data: { kind: "trigger.manual", label: "Start", config: {} } },
      { id: "compose", type: "n9n", position: { x: 380, y: 100 }, data: { kind: "data.compose", label: "Compose", config: { value: "ok" } } },
      { id: "http", type: "n9n", position: { x: 380, y: 260 }, data: { kind: "action.http", label: "HTTP", config: { method: "GET", url: "https://example.com", headers: "{}", body: "" } } },
    ],
    edges: [{ id: "start-compose", source: "start", target: "compose" }],
  };
  const workflow = await createWorkflow(request, graph);
  await openWorkflow(page, workflow);

  const edge = page.locator(".react-flow__edge").first();
  await edge.locator(".react-flow__edge-interaction").click({ force: true });
  await page.getByLabel("Edge label").fill("primary route");
  await page.getByRole("button", { name: "Save" }).click();
  await expect.poll(async () => (await savedWorkflow(request, workflow.id)).graph.edges[0]?.label).toBe("primary route");

  const updater = page.locator(".react-flow__edgeupdater-target");
  await expect(updater).toBeVisible();
  const updaterBox = await updater.boundingBox();
  const httpTarget = await page.locator(".flow-node--action-http").locator("xpath=..").locator(".flow-handle.target").boundingBox();
  if (!updaterBox || !httpTarget) throw new Error("Expected edge updater and HTTP target handles");
  await page.mouse.move(updaterBox.x + updaterBox.width / 2, updaterBox.y + updaterBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(httpTarget.x + httpTarget.width / 2, httpTarget.y + httpTarget.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Save" }).click();
  await expect.poll(async () => (await savedWorkflow(request, workflow.id)).graph.edges[0]?.target).toBe("http");

  await page.locator(".react-flow__edge").first().locator(".react-flow__edge-interaction").click({ force: true });
  await page.getByLabel("Delete edge").click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect.poll(async () => (await savedWorkflow(request, workflow.id)).graph.edges.length).toBe(0);
});

test("sticky notes and canvas groups are editable, non-executable, context-accessible, and usable on small screens", async ({ page, request }) => {
  const workflow = await createWorkflow(request);
  await openWorkflow(page, workflow);
  await page.setViewportSize({ width: 700, height: 800 });
  await expect(page.locator(".palette")).toBeVisible();

  const canvas = page.locator(".canvas");
  const canvasBox = await canvas.boundingBox();
  if (!canvasBox) throw new Error("Expected canvas bounds");
  await page.mouse.click(canvasBox.x + canvasBox.width * 0.55, canvasBox.y + 84, { button: "right" });
  await expect(page.getByRole("menu", { name: "Canvas context menu" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Add sticky note" }).click();
  await page.getByLabel("Sticky note text").fill("This annotation never executes.");
  await page.getByLabel("Sticky note color").selectOption("blue");

  await page.locator('.palette button[data-node-kind="annotation.group"]').click();
  await page.getByLabel("Group width").fill("440");
  await page.getByLabel("Group height").fill("260");
  await expect(page.getByRole("button", { name: "Workflow validation" })).toContainText("Valid");

  await expect.poll(async () => (await savedWorkflow(request, workflow.id)).graph.nodes.length).toBe(3);
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.locator(".run-panel")).toContainText("1 nodes executed");
  const saved = await savedWorkflow(request, workflow.id);
  expect(saved.graph.nodes.map((node) => node.data.kind)).toEqual(expect.arrayContaining(["annotation.sticky", "annotation.group"]));
  expect(saved.graph.nodes.find((node) => node.data.kind === "annotation.sticky")?.data.config.text).toBe("This annotation never executes.");
});
