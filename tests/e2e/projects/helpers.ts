import { expect, Page } from "@playwright/test";

export async function navigateToCreateProject(page: Page) {
  await page.goto("/");
  await page.waitForLoadState("domcontentloaded");

  const main = page.locator("main");
  const headerNew = main.getByRole("link", { name: "New Project" });
  const onboarding = main.getByRole("link", { name: /create your first project/i }).first();

  if (await headerNew.isVisible().catch(() => false)) {
    await headerNew.click();
  } else if (await onboarding.isVisible().catch(() => false)) {
    await onboarding.click();
  } else {
    await page.locator(".fixed.left-0.top-16.w-4").hover();
    await page.getByRole("link", { name: "New Project" }).first().click();
  }

  await expect(page).toHaveURL("/projects/new");
}

export async function createProjectViaUi(
  page: Page,
  name: string,
  options?: { description?: string; tags?: string[] },
) {
  await navigateToCreateProject(page);
  await page.fill("input#name", name);
  if (options?.description) {
    await page.fill("textarea#description", options.description);
  }
  if (options?.tags) {
    for (const tag of options.tags) {
      await page.fill('input[placeholder*="Add tags"]', tag);
      await page.press('input[placeholder*="Add tags"]', "Enter");
    }
  }
  await page.click('button[type="submit"]:has-text("Create")');
  await page.waitForURL("/", { timeout: 30000, waitUntil: "domcontentloaded" });
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 20000 });
}

export async function openProjectCardMenu(page: Page, projectName: string) {
  await page.goto("/");
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByText(projectName).first()).toBeVisible({ timeout: 20000 });

  const card = page
    .locator(".glass-card")
    .filter({ has: page.getByText(projectName, { exact: false }) })
    .first();
  await expect(card).toBeVisible();
  await card.getByTestId("project-card-menu").click({ force: true });
}
