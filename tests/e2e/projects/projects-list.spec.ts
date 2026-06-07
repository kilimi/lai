import { test, expect } from "@playwright/test";
import { createProjectViaUi } from "./helpers";

test.describe("Projects list filters and sort", () => {
  test("search, tag filter, and sort", async ({ page }) => {
    const ts = Date.now();
    const alpha = `Alpha ${ts}`;
    const beta = `Beta ${ts}`;

    await createProjectViaUi(page, alpha, { tags: ["filter-a"] });
    await createProjectViaUi(page, beta, { tags: ["filter-b", "shared"] });

    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");

    await page.fill('input[placeholder="Search projects..."]', "Beta");
    await expect(page.getByText(beta).first()).toBeVisible();
    await expect(page.getByText(alpha)).toHaveCount(0);

    await page.fill('input[placeholder="Search projects..."]', "");
    await page.getByRole("button", { name: "shared" }).click();
    await expect(page.getByText(beta).first()).toBeVisible();
    await expect(page.getByText(alpha)).toHaveCount(0);

    await page.getByRole("button", { name: "All" }).click();
    await page.getByRole("combobox").click();
    await page.getByRole("option", { name: "Name (A-Z)" }).click();

    const names = await page.locator(".glass-card h3").allTextContents();
    const visible = names.filter((n) => n.includes(String(ts)));
    expect(visible.length).toBeGreaterThanOrEqual(2);
    const sorted = [...visible].sort((a, b) => a.localeCompare(b));
    expect(visible).toEqual(sorted);
  });

  test("shows empty onboarding when no projects match filters", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");

    const hasWelcome = await page.getByText("Welcome to LAI Studio").isVisible().catch(() => false);
    if (hasWelcome) {
      test.skip(true, "No seeded projects — skip filter-empty test");
    }

    await page.fill('input[placeholder="Search projects..."]', "zzznomatchzzz");
    await expect(page.getByText("No matching projects")).toBeVisible();
    await page.getByRole("button", { name: "Clear Filters" }).click();
  });
});
