import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? "3109"}`;
const secureHeaders = () => ({
  origin: baseURL,
  "x-9n9-csrf": readFileSync(path.join(process.cwd(), ".test-data", "csrf-token"), "utf8"),
});

type Graph = { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> };
type Workflow = {
  id: string; name: string; slug: string; description: string; tags: string[];
  enabled: boolean; archivedAt?: string; graph: Graph;
};

const manualGraph: Graph = {
  nodes: [{ id: "trigger", type: "n9n", position: { x: 80, y: 160 }, data: { kind: "trigger.manual", label: "Start", config: {} } }],
  edges: [],
};
const invalidGraph: Graph = {
  nodes: [{ id: "http", type: "n9n", position: { x: 80, y: 160 }, data: { kind: "action.http", label: "Broken HTTP", config: { method: "GET", url: "" } } }],
  edges: [],
};

async function createWorkflow(request: APIRequestContext, name: string, graph: Graph = manualGraph) {
  const response = await request.post("/api/workflows", { headers: secureHeaders(), data: { name, graph } });
  expect(response.status()).toBe(201);
  return await response.json() as Workflow;
}

async function removeWorkflow(request: APIRequestContext, id?: string) {
  if (id) await request.delete(`/api/workflows/${id}`, { headers: secureHeaders() });
}

async function openWorkflow(page: Page, name: string) {
  await page.goto("/");
  await page.locator(".flow-list button").filter({ hasText: name }).click();
  await expect(page.getByLabel("Flow name")).toHaveValue(name);
}

test("metadata autosaves and search, sort, and unsaved navigation protection work", async ({ page, request }) => {
  const original = `[e2e] metadata ${Date.now()}`;
  const renamed = `${original} renamed`;
  const finalName = `${original} race-safe`;
  const workflow = await createWorkflow(request, original);
  try {
    await openWorkflow(page, original);
    await page.getByLabel("Flow name").fill(renamed);
    await expect(page.locator(".save-state")).toHaveText(/Autosave pending|Saving…/);

    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain("unsaved changes");
      await dialog.dismiss();
    });
    await page.getByRole("button", { name: "Runs" }).click();
    await expect(page.getByLabel("Flow name")).toHaveValue(renamed);
    await expect(page.locator(".save-state")).toHaveText("Saved", { timeout: 5_000 });

    let delayedFirstSave = false;
    await page.route(`**/api/workflows/${workflow.id}`, async (route) => {
      if (route.request().method() === "PUT" && !delayedFirstSave) {
        delayedFirstSave = true;
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
      await route.continue();
    });
    await page.getByLabel("Flow name").fill(`${renamed} in flight`);
    await expect(page.locator(".save-state")).toHaveText("Saving…", { timeout: 3_000 });
    await page.getByLabel("Flow name").fill(finalName);
    await expect(page.locator(".save-state")).toHaveText("Saved", { timeout: 6_000 });
    await page.unroute(`**/api/workflows/${workflow.id}`);

    await page.getByRole("button", { name: "Workflow settings" }).click();
    const dialog = page.getByRole("dialog", { name: "Workflow settings" });
    await dialog.getByLabel("Webhook slug").fill(`e2e-metadata-${Date.now()}`);
    await dialog.getByLabel("Workflow description").fill("Searchable Raspberry Pi automation");
    await dialog.getByLabel("Workflow tags").fill("pi, important, local");
    await dialog.getByRole("button", { name: "Close workflow settings" }).click();
    await expect(page.locator(".save-state")).toHaveText("Saved", { timeout: 5_000 });

    const saved = await (await request.get(`/api/workflows/${workflow.id}`)).json() as Workflow;
    expect(saved.name).toBe(finalName);
    expect(saved.description).toBe("Searchable Raspberry Pi automation");
    expect(saved.tags).toEqual(["pi", "important", "local"]);
    expect(saved.slug).toMatch(/^e2e-metadata-/);

    await page.getByLabel("Search workflows").fill("important");
    await expect(page.locator(".flow-list button").filter({ hasText: finalName })).toBeVisible();
    await page.getByLabel("Workflow sort").selectOption("name");
    await page.getByLabel("Workflow status filter").selectOption("all");
  } finally {
    await removeWorkflow(request, workflow.id);
  }
});

test("duplicate, archive, restore, filtering, and permanent delete preserve lifecycle rules", async ({ request }) => {
  const source = await createWorkflow(request, `[e2e] lifecycle ${Date.now()}`);
  let copy: Workflow | undefined;
  try {
    const duplicate = await request.post(`/api/workflows/${source.id}/duplicate`, { headers: secureHeaders(), data: {} });
    expect(duplicate.status()).toBe(201);
    copy = await duplicate.json() as Workflow;
    expect(copy.name).toContain("copy");
    expect(copy.enabled).toBe(false);
    expect(copy.graph).toEqual(source.graph);

    const archivedResponse = await request.post(`/api/workflows/${copy.id}/archive`, { headers: secureHeaders(), data: {} });
    const archived = await archivedResponse.json() as Workflow;
    expect(archived.archivedAt).toBeTruthy();
    expect(archived.enabled).toBe(false);
    expect((await request.post(`/api/workflows/${copy.id}/run`, { headers: secureHeaders(), data: {} })).ok()).toBe(false);

    const active = await (await request.get("/api/workflows?archived=active")).json() as Workflow[];
    const archivedList = await (await request.get("/api/workflows?archived=archived")).json() as Workflow[];
    expect(active.some((item) => item.id === copy?.id)).toBe(false);
    expect(archivedList.some((item) => item.id === copy?.id)).toBe(true);

    const restored = await (await request.post(`/api/workflows/${copy.id}/restore`, { headers: secureHeaders(), data: {} })).json() as Workflow;
    expect(restored.archivedAt).toBeUndefined();
    expect((await request.delete(`/api/workflows/${copy.id}`, { headers: secureHeaders() })).status()).toBe(204);
    copy = undefined;
  } finally {
    await removeWorkflow(request, copy?.id);
    await removeWorkflow(request, source.id);
  }
});

test("export, import, and reusable templates round-trip without credential bindings", async ({ page, request }) => {
  const graph: Graph = {
    nodes: [
      manualGraph.nodes[0],
      { id: "http", type: "n9n", position: { x: 400, y: 160 }, data: { kind: "action.http", label: "HTTP", config: { method: "GET", url: "https://example.com", credentialId: "credential-local-only" } } },
    ],
    edges: [{ id: "trigger-http", source: "trigger", target: "http" }],
  };
  const source = await createWorkflow(request, `[e2e] portable ${Date.now()}`, graph);
  let imported: Workflow | undefined;
  let instantiated: Workflow | undefined;
  let templateId = "";
  try {
    const exportedResponse = await request.get(`/api/workflows/${source.id}/export`);
    expect(exportedResponse.headers()["content-disposition"]).toContain(".9n9.json");
    const exported = await exportedResponse.json() as { format: string; version: number; workflow: { graph: Graph } };
    expect(exported.format).toBe("9n9.workflow");
    expect(exported.version).toBe(1);

    const importedResponse = await request.post("/api/workflows/import", { headers: secureHeaders(), data: exported });
    expect(importedResponse.status()).toBe(201);
    imported = await importedResponse.json() as Workflow;
    expect(imported.enabled).toBe(false);
    expect(imported.name).toContain("import");

    const templateResponse = await request.post("/api/templates", { headers: secureHeaders(), data: { workflowId: source.id } });
    expect(templateResponse.status()).toBe(201);
    const template = await templateResponse.json() as { id: string; name: string; graph: Graph };
    templateId = template.id;
    const templateHttp = template.graph.nodes.find((node) => node.id === "http") as { data: { config: Record<string, unknown> } };
    expect(templateHttp.data.config.credentialId).toBeUndefined();

    await page.goto("/");
    await page.getByRole("button", { name: "Templates" }).click();
    await expect(page.getByRole("heading", { name: template.name })).toBeVisible();

    const instantiate = await request.post(`/api/templates/${template.id}/instantiate`, { headers: secureHeaders(), data: {} });
    instantiated = await instantiate.json() as Workflow;
    expect(instantiated.enabled).toBe(false);
    const instantiatedHttp = instantiated.graph.nodes.find((node) => node.id === "http") as { data: { config: Record<string, unknown> } };
    expect(instantiatedHttp.data.config.credentialId).toBeUndefined();
  } finally {
    if (templateId) await request.delete(`/api/templates/${templateId}`, { headers: secureHeaders() });
    await removeWorkflow(request, instantiated?.id);
    await removeWorkflow(request, imported?.id);
    await removeWorkflow(request, source.id);
  }
});

test("version restore is immutable and invalid activation requires explicit confirmation", async ({ page, request }) => {
  const name = `[e2e] versions ${Date.now()}`;
  const workflow = await createWorkflow(request, name);
  try {
    await request.put(`/api/workflows/${workflow.id}`, {
      headers: secureHeaders(),
      data: { name: `${name} changed`, description: "second version", graph: invalidGraph, reason: "test update" },
    });
    const versions = await (await request.get(`/api/workflows/${workflow.id}/versions`)).json() as Array<{ version: number; snapshot: { name: string } }>;
    expect(versions.length).toBeGreaterThanOrEqual(2);
    expect(versions[0].snapshot.name).toBe(`${name} changed`);

    const denied = await request.put(`/api/workflows/${workflow.id}`, { headers: secureHeaders(), data: { enabled: true } });
    expect(denied.status()).toBe(409);
    expect((await denied.json()).code).toBe("INVALID_WORKFLOW");

    await openWorkflow(page, `${name} changed`);
    page.once("dialog", async (dialog) => { expect(dialog.message()).toContain("validation issue"); await dialog.dismiss(); });
    await page.getByRole("button", { name: "Enable flow" }).click();
    await expect(page.getByRole("button", { name: "Enable flow" })).toBeVisible();
    page.once("dialog", async (dialog) => { await dialog.accept(); });
    await page.getByRole("button", { name: "Enable flow" }).click();
    await expect(page.getByRole("button", { name: "Disable flow" })).toBeVisible();

    const oldest = versions.at(-1)!;
    const restoredResponse = await request.post(`/api/workflows/${workflow.id}/versions/${oldest.version}/restore`, { headers: secureHeaders(), data: {} });
    const restored = await restoredResponse.json() as Workflow;
    expect(restored.name).toBe(name);
    expect(restored.enabled).toBe(false);
    const after = await (await request.get(`/api/workflows/${workflow.id}/versions`)).json() as Array<{ version: number }>;
    expect(after[0].version).toBeGreaterThan(versions[0].version);
  } finally {
    await removeWorkflow(request, workflow.id);
  }
});
