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

export default defineConfig({
  testDir: "./tests/e2e",
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
          CODEX_AGENT_URL: "http://127.0.0.1:1",
          NEXT_TELEMETRY_DISABLED: "1",
        },
      },
});
