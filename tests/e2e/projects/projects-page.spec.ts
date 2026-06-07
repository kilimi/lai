import { test, expect } from "@playwright/test";
import { createProjectViaUi } from "./helpers";

test.describe("Projects page UI", () => {
  test("sidebar quick link opens project datasets", async ({ page }) => {
    const name = `Sidebar ${Date.now()}`;
    await createProjectViaUi(page, name);

    await page.goto("/");
    await page.locator(".fixed.left-0.top-16.w-4").hover();
    await page.getByRole("link", { name: name }).first().click();
    await expect(page).toHaveURL(/\/projects\/\d+\/datasets/);
  });

  test("refresh button reloads list", async ({ page }) => {
    const name = `Refresh ${Date.now()}`;
    await createProjectViaUi(page, name);

    await page.getByRole("button", { name: "Refresh projects" }).click();
    await expect(page.getByText(name).first()).toBeVisible({ timeout: 15000 });
  });
});
