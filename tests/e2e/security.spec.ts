import { expect, request as playwrightRequest, test } from "@playwright/test";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? "3109"}`;
const csrfToken = () => readFileSync(path.join(process.cwd(), ".test-data", "csrf-token"), "utf8");
const secureHeaders = () => ({ origin: baseURL, "x-9n9-csrf": csrfToken() });

test("authentication is required and unsafe requests require CSRF", async ({ request }) => {
  const anonymous = await playwrightRequest.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
  });
  const protectedRead = await anonymous.get("/api/workflows");
  expect(protectedRead.status()).toBe(401);
  await anonymous.dispose();

  const missingCsrf = await request.post("/api/workflows", {
    data: { name: "should not exist" },
    headers: { origin: baseURL },
  });
  expect(missingCsrf.status()).toBe(403);

  const wrongOrigin = await request.post("/api/workflows", {
    data: { name: "should not exist" },
    headers: { origin: "http://evil.invalid", "x-9n9-csrf": csrfToken() },
  });
  expect(wrongOrigin.status()).toBe(403);
});

test("login issues a hardened cookie and rate limits failures", async () => {
  if (!process.env.N9N_E2E_SESSION_TOKEN) {
    const context = await playwrightRequest.newContext({ baseURL, extraHTTPHeaders: { origin: baseURL } });
    const login = await context.post("/api/auth/login", {
      data: { username: "admin", password: process.env.N9N_E2E_PASSWORD ?? "9n9-playwright-admin-password" },
    });
    expect(login.ok()).toBeTruthy();
    const cookies = await context.storageState();
    const session = cookies.cookies.find((cookie) => cookie.name === "n9n_session");
    expect(session?.httpOnly).toBe(true);
    expect(session?.sameSite).toBe("Strict");
    await context.dispose();
  }

  const attacker = await playwrightRequest.newContext({ baseURL, extraHTTPHeaders: { origin: baseURL } });
  const username = `missing-${Date.now()}`;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    expect((await attacker.post("/api/auth/login", { data: { username, password: "definitely-wrong" } })).status()).toBe(401);
  }
  const limited = await attacker.post("/api/auth/login", { data: { username, password: "definitely-wrong" } });
  expect(limited.status()).toBe(429);
  expect(limited.headers()["retry-after"]).toBe("900");
  await attacker.dispose();
});

test("credentials stay masked, execute server-side, and redact run data", async ({ page, request }) => {
  const secret = `secret-${Date.now()}-value`;
  const credentialResponse = await request.post("/api/credentials", {
    headers: secureHeaders(),
    data: { name: "[e2e] bearer", type: "bearer", data: { token: secret } },
  });
  expect(credentialResponse.status()).toBe(201);
  const credential = await credentialResponse.json() as { id: string; masked: string };
  expect(credential.masked).toBe("••••••••");
  expect(await credentialResponse.text()).not.toContain(secret);

  const echo = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ authorization: request.headers.authorization, echo: secret }));
  });
  await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
  const address = echo.address();
  if (!address || typeof address === "string") throw new Error("Echo server did not bind");

  let workflowId = "";
  const workflowName = `[e2e] credential ${Date.now()}`;
  try {
    const create = await request.post("/api/workflows", { headers: secureHeaders(), data: { name: workflowName } });
    const workflow = await create.json() as { id: string };
    workflowId = workflow.id;
    const update = await request.put(`/api/workflows/${workflow.id}`, {
      headers: secureHeaders(),
      data: {
        graph: {
          nodes: [
            { id: "trigger", type: "n9n", position: { x: 80, y: 160 }, data: { kind: "trigger.manual", label: "Start", config: {} } },
            { id: "http", type: "n9n", position: { x: 400, y: 160 }, data: { kind: "action.http", label: "Private request", config: { method: "GET", url: `http://127.0.0.1:${address.port}`, headers: "{}", credentialId: credential.id } } },
          ],
          edges: [{ id: "trigger-http", source: "trigger", target: "http" }],
        },
      },
    });
    expect(update.ok()).toBeTruthy();
    const run = await request.post(`/api/workflows/${workflow.id}/run`, { headers: secureHeaders(), data: { input: {} } });
    expect(run.ok()).toBeTruthy();
    const runText = await run.text();
    expect(runText).not.toContain(secret);
    expect(runText).toContain("[REDACTED]");

    await page.goto("/");
    await page.locator(".flow-list button").filter({ hasText: workflowName }).click();
    await page.locator(".flow-node--action-http").click();
    await expect(page.locator(".inspector").getByLabel("Credential")).toHaveValue(credential.id);
    await page.getByRole("button", { name: "Credentials" }).click();
    await expect(page.getByText("[e2e] bearer")).toBeVisible();
    await page.getByRole("button", { name: "Audit" }).click();
    await expect(page.getByText("credential.used")).toBeVisible();
  } finally {
    echo.close();
    if (workflowId) await request.delete(`/api/workflows/${workflowId}`, { headers: secureHeaders() });
    await request.delete(`/api/credentials/${credential.id}`, { headers: secureHeaders() });
  }
});

test("webhook rotation immediately revokes the old token", async ({ request }) => {
  const create = await request.post("/api/workflows", { headers: secureHeaders(), data: { name: `[e2e] rotate ${Date.now()}` } });
  const workflow = await create.json() as { id: string; slug: string; webhookToken: string };
  try {
    await request.put(`/api/workflows/${workflow.id}`, {
      headers: secureHeaders(),
      data: {
        enabled: true,
        graph: {
          nodes: [{ id: "webhook", type: "n9n", position: { x: 80, y: 160 }, data: { kind: "trigger.webhook", label: "Webhook", config: {} } }],
          edges: [],
        },
      },
    });
    const before = await request.post(`/hooks/${workflow.slug}`, { headers: { authorization: `Bearer ${workflow.webhookToken}` }, data: { ok: true } });
    expect(before.ok()).toBeTruthy();

    const rotation = await request.post(`/api/workflows/${workflow.id}/webhook-token`, { headers: secureHeaders(), data: {} });
    const { token } = await rotation.json() as { token: string };
    expect(token).not.toBe(workflow.webhookToken);
    expect((await request.post(`/hooks/${workflow.slug}`, { headers: { authorization: `Bearer ${workflow.webhookToken}` }, data: {} })).status()).toBe(401);
    expect((await request.post(`/hooks/${workflow.slug}`, { headers: { "x-9n9-webhook-token": token }, data: {} })).ok()).toBeTruthy();
  } finally {
    await request.delete(`/api/workflows/${workflow.id}`, { headers: secureHeaders() });
  }
});
