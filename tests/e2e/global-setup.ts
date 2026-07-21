import { request as playwrightRequest, type FullConfig } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0].use.baseURL as string;
  const password = process.env.N9N_E2E_PASSWORD ?? "9n9-playwright-admin-password";
  const context = await playwrightRequest.newContext({
    baseURL,
    extraHTTPHeaders: { origin: baseURL },
  });
  const testData = path.join(process.cwd(), ".test-data");
  const authPath = path.join(testData, "auth.json");
  mkdirSync(testData, { recursive: true });
  let csrfToken: string;
  if (process.env.N9N_E2E_SESSION_TOKEN && process.env.N9N_E2E_CSRF_TOKEN) {
    const url = new URL(baseURL);
    writeFileSync(authPath, JSON.stringify({
      cookies: [{
        name: "n9n_session",
        value: process.env.N9N_E2E_SESSION_TOKEN,
        domain: url.hostname,
        path: "/",
        httpOnly: true,
        secure: url.protocol === "https:",
        sameSite: "Strict",
        expires: Math.floor(Date.now() / 1000) + 15 * 60,
      }],
      origins: [],
    }), { mode: 0o600 });
    csrfToken = process.env.N9N_E2E_CSRF_TOKEN;
  } else {
    const response = await context.post("/api/auth/login", {
      data: { username: "admin", password },
    });
    if (!response.ok()) {
      throw new Error(`Could not authenticate Playwright: ${response.status()} ${await response.text()}`);
    }
    const body = await response.json() as { csrfToken: string };
    csrfToken = body.csrfToken;
    await context.storageState({ path: authPath });
  }
  writeFileSync(path.join(testData, "csrf-token"), csrfToken, { mode: 0o600 });
  await context.dispose();
}
