import { defineConfig } from "@playwright/test";

const baseURL = process.env.B1_TEST_BASE_URL || "http://127.0.0.1:3101";
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname)) throw new Error("Cloudflare browser checks require a loopback URL.");

export default defineConfig({
  testDir: "tests/cloudflare",
  outputDir: "test-results/cloudflare",
  timeout: 45000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL,
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}
  }
});
