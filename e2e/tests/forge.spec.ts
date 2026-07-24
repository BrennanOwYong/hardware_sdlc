// End-to-end tests against the running dev server. These drive the real UI in
// a real browser, which is the only way to catch the failures unit tests
// cannot see: a component that throws on mount, a hydration mismatch, a button
// that renders but is not clickable, an overlay that never paints.
//
// What these tests deliberately do NOT cover is listed in TESTING-GAPS.md:
// anything needing a live camera, a screen share, or a physical board.
import { test, expect, type Page } from "@playwright/test";
import path from "node:path";

const DESK_PHOTO = path.resolve(
  "/mnt/c/Users/brenn/Documents/hardware_project/images",
  "WhatsApp Image 2026-07-24 at 01.41.25.jpeg",
);

/** Vision calls take 30-60 s; give the slow paths room without hanging forever. */
const VISION_TIMEOUT = 180_000;

async function expectNoPageError(page: Page, fn: () => Promise<void>) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await fn();
  expect(errors, `uncaught page errors: ${errors.join(" | ")}`).toHaveLength(0);
}

test.describe("navigation and page health", () => {
  for (const [route, marker] of [
    ["/", /Forge/i],
    ["/inventory", /Inventory/i],
    ["/assemble", /assembly/i],
    ["/timeline", /Timeline/i],
    ["/coach", /Coach|goal/i],
    ["/builder", /Builder|idea/i],
    ["/check", /build this/i],
  ] as const) {
    test(`${route} renders without a page error`, async ({ page }) => {
      await expectNoPageError(page, async () => {
        const res = await page.goto(route);
        expect(res?.status(), `${route} HTTP status`).toBeLessThan(400);
        await expect(page.locator("body")).toContainText(marker, { timeout: 30_000 });
      });
    });
  }

  test("nav reaches every primary surface", async ({ page }) => {
    await page.goto("/");
    for (const label of ["Inventory", "Assemble", "Timeline", "Coach", "Builder"]) {
      await expect(page.getByRole("link", { name: label, exact: true })).toBeVisible();
    }
  });
});

test.describe("T3 assembly demo autoplay (the money shot)", () => {
  test("runs the scripted build, catches the planted mistake, ends in firmware", async ({
    page,
  }) => {
    await page.goto("/assemble?demo=auto");
    // Two-stage confirmation must appear at least once.
    await expect(page.getByText(/Correct - push it in now/i)).toBeVisible({
      timeout: 60_000,
    });
    // The deliberate misplacement at step 4 must be flagged, not silently passed.
    await expect(page.getByText(/Wrong placement/i)).toBeVisible({ timeout: 60_000 });
    // And the run must still reach completion afterwards.
    await expect(page.getByText(/All 7 steps seated/i)).toBeVisible({
      timeout: 120_000,
    });
  });

  test("firmware appears with the pins the run actually used", async ({ page }) => {
    await page.goto("/assemble?demo=auto");
    await expect(page.getByText(/All 7 steps seated/i)).toBeVisible({
      timeout: 120_000,
    });
    const code = page.locator("pre, code").first();
    await expect(code).toContainText(/13/, { timeout: 60_000 });
    await expect(code).toContainText(/2/);
  });
});

test.describe("T4 manual sim blocks wrong placements", () => {
  test("a wrong hole does not advance the build", async ({ page }) => {
    await page.goto("/assemble");
    await page.getByRole("button", { name: /Manual sim/i }).click();
    const stepBefore = await page.getByText(/Step \d+ of \d+/).innerText();
    const wrong = page.getByRole("button", { name: /wrong hole/i });
    if (await wrong.isVisible()) {
      await wrong.click();
      await page.waitForTimeout(800);
      const stepAfter = await page.getByText(/Step \d+ of \d+/).innerText();
      expect(stepAfter, "a wrong hole must not advance the step").toBe(stepBefore);
    }
  });

  test("tip then seat advances one step", async ({ page }) => {
    await page.goto("/assemble");
    await page.getByRole("button", { name: /Manual sim/i }).click();
    const before = await page.getByText(/Step \d+ of \d+/).innerText();
    await page.getByRole("button", { name: /Tip on correct target/i }).click();
    await expect(page.getByText(/Correct - push it in now/i)).toBeVisible();
    await page.getByRole("button", { name: /Seat it/i }).click();
    await expect(page.getByText(/Step \d+ of \d+/)).not.toHaveText(before, {
      timeout: 10_000,
    });
  });
});

test.describe("T18 sample identification is instant", () => {
  test("the sample sheet returns without a vision round trip", async ({ page }) => {
    await page.goto("/inventory");
    const started = Date.now();
    await page.getByRole("button", { name: /sample parts image/i }).click();
    await expect(page.getByText(/source: mock|12 parts/i).first()).toBeVisible({
      timeout: 20_000,
    });
    expect(
      Date.now() - started,
      "sample must use its known inventory, not the SAM pipeline",
    ).toBeLessThan(20_000);
  });
});

test.describe("T27 quantity-aware venn (needs a vision key)", () => {
  test("a real desk photo produces a venn with shortfall counts", async ({ page }) => {
    test.setTimeout(VISION_TIMEOUT + 60_000);
    await page.goto("/check");
    await page.getByLabel(/What do you want to build/i).fill("a button that turns on an LED");
    await page.setInputFiles('input[type="file"]', DESK_PHOTO);

    // The venn only renders once the assessment returns a bill of materials.
    await expect(page.getByText(/What you have vs what this needs/i)).toBeVisible({
      timeout: VISION_TIMEOUT,
    });
    // Shortfall lines are the point of the feature.
    await expect(page.getByText(/need \d+, saw \d+, get \d+ more/i).first()).toBeVisible();
    // And the verdict must be honest about a desk with no electronics.
    await expect(
      page.getByText(/Not with these parts|a few parts short/i),
    ).toBeVisible();
  });
});

test.describe("T26 timeline split layout", () => {
  test("selecting one commit shows its state on the right", async ({ page }) => {
    await page.goto("/timeline");
    const nodes = page.locator(".timeline-node");
    // The rail is populated by a fetch, so wait for it rather than racing it.
    await nodes.first().waitFor({ state: "visible", timeout: 30_000 }).catch(() => {});
    const count = await nodes.count();
    test.skip(count === 0, "no commits recorded yet: run a build first");
    await nodes.first().click();
    await expect(page.locator(".timeline-detail")).toBeVisible();
    // A single click must be enough to see a diff; no two-checkbox ritual.
    await expect(page.getByLabel(/Comparison target/i)).toBeVisible();
  });
});

test.describe("keyless and error paths", () => {
  test("check page refuses a photo before a goal is set", async ({ page }) => {
    await page.goto("/check");
    await page.setInputFiles('input[type="file"]', DESK_PHOTO);
    await expect(page.getByText(/Say what you want to build first/i)).toBeVisible({
      timeout: 15_000,
    });
  });
});
