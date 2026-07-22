import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

type Workflow = {
  id: string;
  name: string;
  slug: string;
  webhookToken?: string;
  graph: {
    nodes: Array<Record<string, unknown>>;
    edges: Array<Record<string, unknown>>;
  };
};

let createdWorkflowIds: string[] = [];

function secureHeaders() {
  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? "3109"}`;
  return {
    origin: baseURL,
    "x-9n9-csrf": readFileSync(path.join(process.cwd(), ".test-data", "csrf-token"), "utf8"),
  };
}

async function createWorkflow(
  request: APIRequestContext,
  name: string,
  options?: {
    enabled?: boolean;
    graph?: Workflow["graph"];
  },
) {
  const createResponse = await request.post("/api/workflows", {
    data: { name },
    headers: secureHeaders(),
  });
  expect(createResponse.ok()).toBeTruthy();
  let workflow = (await createResponse.json()) as Workflow;
  const webhookToken = workflow.webhookToken;
  createdWorkflowIds.push(workflow.id);

  if (options?.graph || options?.enabled !== undefined) {
    const updateResponse = await request.put(
      "/api/workflows/" + workflow.id,
      {
        data: {
          enabled: options.enabled,
          graph: options.graph,
        },
        headers: secureHeaders(),
      },
    );
    expect(updateResponse.ok()).toBeTruthy();
    workflow = { ...(await updateResponse.json()) as Workflow, webhookToken };
  }

  return workflow;
}

async function openWorkflow(page: Page, workflow: Workflow) {
  await page.goto("/");
  const flowButton = page.locator(".flow-list button").filter({
    hasText: workflow.name,
  });
  await expect(flowButton).toBeVisible();
  await flowButton.click();
  await expect(page.getByLabel("Flow name")).toHaveValue(workflow.name);
}

function rectanglesOverlap(
  first: { x: number; y: number; width: number; height: number },
  second: { x: number; y: number; width: number; height: number },
) {
  return !(
    first.x + first.width <= second.x ||
    second.x + second.width <= first.x ||
    first.y + first.height <= second.y ||
    second.y + second.height <= first.y
  );
}

async function connectNodes(
  page: Page,
  sourceNode: ReturnType<Page["locator"]>,
  targetNode: ReturnType<Page["locator"]>,
) {
  const sourceHandle = sourceNode.locator(".flow-handle.source").first();
  const targetHandle = targetNode.locator(".flow-handle.target").first();
  await expect(sourceHandle).toBeVisible();
  await expect(targetHandle).toBeVisible();
  const sourceBox = await sourceHandle.boundingBox();
  const targetBox = await targetHandle.boundingBox();
  if (!sourceBox || !targetBox) {
    throw new Error("Expected connection handles to have layout boxes");
  }
  await page.mouse.move(
    sourceBox.x + sourceBox.width / 2,
    sourceBox.y + sourceBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    targetBox.x + targetBox.width / 2,
    targetBox.y + targetBox.height / 2,
    { steps: 12 },
  );
  await page.mouse.up();
}

test.beforeEach(() => {
  createdWorkflowIds = [];
});

test.afterEach(async ({ request }) => {
  await Promise.all(
    createdWorkflowIds.map((id) =>
      request.delete("/api/workflows/" + id, { headers: secureHeaders() }),
    ),
  );
});

test("palette adds a visible selected node without overlapping existing nodes", async ({
  page,
  request,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(Crypto.prototype, "randomUUID", {
      configurable: true,
      value: undefined,
    });
  });

  const workflow = await createWorkflow(
    request,
    "[e2e] palette " + Date.now(),
  );
  await openWorkflow(page, workflow);

  await page.locator(".palette button").filter({ hasText: "HTTP" }).click();

  const canvas = page.locator(".canvas");
  const manualNode = page.locator(".flow-node--trigger-manual");
  const httpNode = page.locator(".flow-node--action-http");

  await expect(httpNode).toBeVisible();
  await expect(httpNode).toBeInViewport();
  await expect(page.locator(".inspector").getByLabel("Name")).toHaveValue(
    "HTTP",
  );
  await expect(page.locator(".save-state")).toHaveText(/Autosave pending|Saving…|Saved/);

  const handleTolerance = 4;
  await expect
    .poll(async () => {
      const currentCanvasBox = await canvas.boundingBox();
      const currentHttpBox = await httpNode.boundingBox();
      if (!currentCanvasBox || !currentHttpBox) return false;
      return (
        currentHttpBox.x >= currentCanvasBox.x - handleTolerance &&
        currentHttpBox.y >= currentCanvasBox.y - handleTolerance &&
        currentHttpBox.x + currentHttpBox.width <=
          currentCanvasBox.x + currentCanvasBox.width + handleTolerance &&
        currentHttpBox.y + currentHttpBox.height <=
          currentCanvasBox.y + currentCanvasBox.height + handleTolerance
      );
    }, { message: "HTTP node should settle fully inside the canvas" })
    .toBe(true);

  const manualBox = await manualNode.boundingBox();
  const httpBox = await httpNode.boundingBox();
  if (!manualBox || !httpBox) {
    throw new Error("Expected canvas and workflow nodes to have layout boxes");
  }

  expect(rectanglesOverlap(manualBox, httpBox)).toBe(false);

  const httpUrl = page.locator(".inspector").getByLabel("URL");
  await httpUrl.fill("");
  await expect(page.getByRole("button", { name: "Workflow validation" })).toContainText(
    "2 issues",
  );
  await expect(httpNode.locator("xpath=..")).toHaveClass(/has-validation-error/);
  await httpUrl.fill("https://example.com");
  await expect(page.getByRole("button", { name: "Workflow validation" })).toContainText(
    "1 issues",
  );

  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator(".save-state")).toHaveText("Saved");

  await manualNode.click();
  await expect(page.locator(".inspector").getByLabel("Name")).toHaveValue(
    "When I click run",
  );
  await expect(page.locator(".save-state")).toHaveText("Saved");

  const savedResponse = await request.get(
    "/api/workflows/" + workflow.id,
  );
  const saved = (await savedResponse.json()) as Workflow;
  for (const node of saved.graph.nodes) {
    expect(Object.keys(node).sort()).toEqual([
      "data",
      "id",
      "position",
      "type",
    ]);
  }
  expect(pageErrors).toEqual([]);
});

test("a configured flow runs and exposes its trace and output", async ({
  page,
  request,
}) => {
  const workflow = await createWorkflow(
    request,
    "[e2e] run " + Date.now(),
    {
      graph: {
        nodes: [
          {
            id: "trigger",
            type: "n9n",
            position: { x: 80, y: 160 },
            data: {
              kind: "trigger.manual",
              label: "Start",
              config: {},
            },
          },
          {
            id: "compose",
            type: "n9n",
            position: { x: 400, y: 160 },
            data: {
              kind: "data.compose",
              label: "Build result",
              config: {
                value: '{"playwright":true,"message":"flow works"}',
              },
            },
          },
        ],
        edges: [
          {
            id: "trigger-compose",
            source: "trigger",
            target: "compose",
          },
        ],
      },
    },
  );
  await openWorkflow(page, workflow);

  await page.getByRole("button", { name: "Run", exact: true }).click();

  const runPanel = page.locator(".run-panel");
  await expect(runPanel).toBeVisible();
  await expect(runPanel).toContainText("success");
  await expect(runPanel).toContainText("2 nodes executed");
  await expect(runPanel.locator("pre")).toContainText('"playwright": true');
  await expect(runPanel.locator("pre")).toContainText("flow works");
});

test("an enabled webhook executes and appears in run history", async ({
  page,
  request,
}) => {
  const workflow = await createWorkflow(
    request,
    "[e2e] webhook " + Date.now(),
    {
      enabled: true,
      graph: {
        nodes: [
          {
            id: "webhook",
            type: "n9n",
            position: { x: 80, y: 160 },
            data: {
              kind: "trigger.webhook",
              label: "Webhook",
              config: {},
            },
          },
          {
            id: "reply",
            type: "n9n",
            position: { x: 400, y: 160 },
            data: {
              kind: "data.compose",
              label: "Reply",
              config: {
                value: '{"accepted":true,"echo":{{input.body.value}}}',
              },
            },
          },
        ],
        edges: [
          {
            id: "webhook-reply",
            source: "webhook",
            target: "reply",
          },
        ],
      },
    },
  );

  const hookResponse = await request.post("/hooks/" + workflow.slug, {
    data: { value: 42 },
    headers: { authorization: `Bearer ${workflow.webhookToken}` },
  });
  expect(hookResponse.ok()).toBeTruthy();
  await expect(hookResponse.json()).resolves.toEqual({
    accepted: true,
    echo: 42,
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Runs" }).click();

  const runRow = page.locator(".runs-table__row").filter({
    hasText: workflow.name,
  });
  await expect(runRow).toBeVisible();
  await expect(runRow).toContainText("success");
  await expect(runRow).toContainText("webhook");
});

test("nodes drag onto the canvas, validate, and connect through large handles", async ({
  page,
  request,
}) => {
  const workflow = await createWorkflow(
    request,
    "[e2e] editor " + Date.now(),
  );
  await openWorkflow(page, workflow);

  const canvas = page.locator(".canvas");
  const composePalette = page.locator(
    '.palette button[data-node-kind="data.compose"]',
  );
  await composePalette.dragTo(canvas, {
    targetPosition: { x: 560, y: 300 },
  });

  const manualNode = page.locator(".flow-node--trigger-manual");
  const composeNode = page.locator(".flow-node--data-compose");
  await expect(composeNode).toBeVisible();
  await expect(composeNode).toBeInViewport();
  await expect(page.getByRole("button", { name: "Workflow validation" })).toContainText(
    "1 issues",
  );

  await page.getByRole("button", { name: "Workflow validation" }).click();
  await expect(page.getByLabel("Validation issues")).toContainText(
    "Compose is not connected to an input",
  );
  await page.getByRole("button", { name: "Close validation" }).click();

  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByLabel("Validation issues")).toBeVisible();
  await expect(page.locator(".run-panel")).toHaveCount(0);
  await page.getByRole("button", { name: "Close validation" }).click();

  await connectNodes(page, manualNode, composeNode);
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Workflow validation" })).toContainText(
    "Valid",
  );

  await connectNodes(page, manualNode, composeNode);
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);

  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator(".save-state")).toHaveText("Saved");
  const saved = (await (
    await request.get("/api/workflows/" + workflow.id)
  ).json()) as Workflow;
  expect(saved.graph.nodes).toHaveLength(2);
  expect(saved.graph.edges).toHaveLength(1);
});

test("keyboard deletion and undo redo restore nodes and connections", async ({
  page,
  request,
}) => {
  const workflow = await createWorkflow(
    request,
    "[e2e] history " + Date.now(),
    {
      graph: {
        nodes: [
          {
            id: "trigger",
            type: "n9n",
            position: { x: 80, y: 160 },
            data: {
              kind: "trigger.manual",
              label: "Start",
              config: {},
            },
          },
          {
            id: "compose",
            type: "n9n",
            position: { x: 400, y: 160 },
            data: {
              kind: "data.compose",
              label: "Compose",
              config: { value: '{"ok":true}' },
            },
          },
        ],
        edges: [
          {
            id: "trigger-compose",
            source: "trigger",
            target: "compose",
          },
        ],
      },
    },
  );
  await openWorkflow(page, workflow);

  const edge = page.locator(".react-flow__edge");
  await expect(edge).toHaveCount(1);
  const sourceHandle = page
    .locator(".flow-node--trigger-manual .flow-handle.source")
    .first();
  const targetHandle = page
    .locator(".flow-node--data-compose .flow-handle.target")
    .first();
  const sourceBox = await sourceHandle.boundingBox();
  const targetBox = await targetHandle.boundingBox();
  if (!sourceBox || !targetBox) {
    throw new Error("Expected edge handles to have layout boxes");
  }
  await page.mouse.click(
    (sourceBox.x + targetBox.x) / 2,
    (sourceBox.y + targetBox.y) / 2,
  );
  await expect(edge).toHaveClass(/selected/);
  await page.keyboard.press("Delete");
  await expect(page.locator(".react-flow__edge")).toHaveCount(0);

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);

  const composeNode = page.locator(".flow-node--data-compose");
  await composeNode.click();
  await page.keyboard.press("Backspace");
  await expect(composeNode).toHaveCount(0);
  await expect(page.locator(".react-flow__edge")).toHaveCount(0);

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.locator(".flow-node--data-compose")).toBeVisible();
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);

  await page.getByRole("button", { name: "Redo" }).click();
  await expect(page.locator(".flow-node--data-compose")).toHaveCount(0);
  await page.keyboard.press("Control+z");
  await expect(page.locator(".flow-node--data-compose")).toBeVisible();
});

test("expression picker inserts upstream values and a node test shows IO", async ({
  page,
  request,
}) => {
  const workflow = await createWorkflow(
    request,
    "[e2e] node test " + Date.now(),
    {
      graph: {
        nodes: [
          {
            id: "trigger",
            type: "n9n",
            position: { x: 80, y: 160 },
            data: {
              kind: "trigger.manual",
              label: "Start",
              config: {},
            },
          },
          {
            id: "compose",
            type: "n9n",
            position: { x: 400, y: 160 },
            data: {
              kind: "data.compose",
              label: "Build output",
              config: { value: "" },
            },
          },
        ],
        edges: [
          {
            id: "trigger-compose",
            source: "trigger",
            target: "compose",
          },
        ],
      },
    },
  );
  await openWorkflow(page, workflow);
  await page.locator(".flow-node--data-compose").click();

  const inspector = page.locator(".inspector");
  const valueField = inspector.getByLabel("Value");
  await inspector.getByRole("button", { name: "Start output" }).click();
  await expect(valueField).toHaveValue("{{steps.trigger}}");

  await valueField.fill('{"echo":{{input.body.value}}}');
  await inspector
    .getByLabel("Test input JSON")
    .fill('{"body":{"value":42}}');
  await inspector.getByRole("button", { name: "Test node" }).click();

  const result = inspector.locator(".node-test__result");
  await expect(result).toContainText("success");
  await expect(result.locator("pre")).toContainText('"echo": 42');
  await expect(page.locator(".save-state")).toHaveText("Node test passed");
});
