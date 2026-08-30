import { test, expect } from "@playwright/test";

test("Worker true union and manufacturing mesh pipeline work in the browser", async ({ page }) => {
    await page.goto("http://localhost:3000/test/browser/worker-dist/index.html");

    const result = await page.waitForSelector("#result", { timeout: 70_000 });
    const text = await result.textContent();

    expect(text).toContain("ALL PASSED");
});
