import { defineConfig, devices } from "@playwright/test";

// Tests run against the dev server on 3126 so they exercise the working tree,
// not whatever build happens to be promoted. The app is a phone-first PWA, so
// the default viewport is a phone; desktop-specific behaviour gets its own
// project when it matters.
export default defineConfig({
  testDir: "./tests",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false, // the dev server compiles on demand; parallel hits stall it
  workers: 1,
  retries: 0,
  reporter: [["list"], ["json", { outputFile: "results.json" }]],
  use: {
    baseURL: process.env.FORGE_URL ?? "http://localhost:3126",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    actionTimeout: 20_000,
    navigationTimeout: 60_000,
  },
  projects: [
    { name: "phone", use: { ...devices["Pixel 7"] } },
  ],
});
