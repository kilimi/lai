import { test, expect } from "@playwright/test";
import { createProjectViaUi, openProjectCardMenu } from "./helpers";

test.describe("Delete project from Projects page", () => {
  test("deletes a project from the card menu", async ({ page }) => {
    const name = `Delete Me ${Date.now()}`;
    await createProjectViaUi(page, name);

    await openProjectCardMenu(page, name);
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page.getByRole("button", { name: "Delete project" }).click();

    await expect(page.getByText(name)).toHaveCount(0, { timeout: 15000 });
  });
});
