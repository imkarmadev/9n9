import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

const port = Number(process.env.PLAYWRIGHT_PORT ?? 3109);
const externalBaseURL = process.env.PLAYWRIGHT_BASE_URL;
const baseURL = externalBaseURL ?? "http://127.0.0.1:" + port;
const databasePath = path.join(
  process.cwd(),
  ".test-data",
  "9n9-e2e-" + process.pid + ".db",
);
const authStatePath = path.join(process.cwd(), ".test-data", "auth.json");
const testMasterKey = Buffer.alloc(32, 9).toString("base64");
const testPassword = process.env.N9N_E2E_PASSWORD ?? "9n9-playwright-admin-password";

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    viewport: { width: 1440, height: 960 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    storageState: authStatePath,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: externalBaseURL
    ? undefined
    : {
        command:
          "npm run dev -- --hostname 127.0.0.1 --port " + String(port),
        url: baseURL + "/api/status",
        reuseExistingServer: false,
        timeout: 120_000,
        env: {
          N9N_DATABASE_PATH: databasePath,
          N9N_MASTER_KEY: testMasterKey,
          N9N_BOOTSTRAP_ADMIN_USERNAME: "admin",
          N9N_BOOTSTRAP_ADMIN_PASSWORD: testPassword,
          N9N_PUBLIC_ORIGIN: baseURL,
          CODEX_AGENT_URL: "http://127.0.0.1:1",
          NEXT_TELEMETRY_DISABLED: "1",
        },
      },
});
