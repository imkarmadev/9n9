import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

type Workflow = {
  id: string;
  name: string;
  slug: string;
  graph: {
    nodes: Array<Record<string, unknown>>;
    edges: Array<Record<string, unknown>>;
  };
};

let createdWorkflowIds: string[] = [];

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
  });
  expect(createResponse.ok()).toBeTruthy();
  let workflow = (await createResponse.json()) as Workflow;
  createdWorkflowIds.push(workflow.id);

  if (options?.graph || options?.enabled !== undefined) {
    const updateResponse = await request.put(
      "/api/workflows/" + workflow.id,
      {
        data: {
          enabled: options.enabled,
          graph: options.graph,
        },
      },
    );
    expect(updateResponse.ok()).toBeTruthy();
    workflow = (await updateResponse.json()) as Workflow;
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

test.beforeEach(() => {
  createdWorkflowIds = [];
});

test.afterEach(async ({ request }) => {
  await Promise.all(
    createdWorkflowIds.map((id) =>
      request.delete("/api/workflows/" + id),
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
  await expect(page.locator(".save-state")).toHaveText("Unsaved");

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
