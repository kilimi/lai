import { test, expect } from "@playwright/test";
import { createProjectViaUi, openProjectCardMenu } from "./helpers";

test.describe("Duplicate project from Projects page", () => {
  test("duplicates a project from the card menu", async ({ page }) => {
    const name = `Dup Source ${Date.now()}`;
    await createProjectViaUi(page, name, { tags: ["dup-test"] });

    await openProjectCardMenu(page, name);
    await page.getByRole("menuitem", { name: "Duplicate" }).click();

    const copyName = `${name} (Copy)`;
    await expect(page.getByText(copyName).first()).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(name).first()).toBeVisible();
  });
});
