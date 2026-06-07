import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Run tests serially to avoid parallel project creation conflicts
test.describe.configure({ mode: 'serial' });

// Helper to get project ID from API (newest match)
async function getProjectId(page: Page, projectName: string): Promise<number> {
  return page.evaluate(async (name) => {
    const r = await fetch('http://localhost:9999/projects');
    const projects = await r.json();
    const sorted = [...projects].sort((a: any, b: any) => b.id - a.id);
    const p = sorted.find((p: any) => p.name === name);
    return p ? p.id : 0;
  }, projectName);
}

// Helper function to create a test project first (datasets need a project)
async function createTestProject(page: Page, projectName: string): Promise<number> {
  await page.goto('/projects/new');
  await page.fill('input#name', projectName);
  await page.click('button[type="submit"]:has-text("Create")');
  await page.waitForURL('/', { timeout: 20000, waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 20000 });
  return getProjectId(page, projectName);
}

// Helper function to create a test dataset within a project
async function createTestDataset(page: Page, projectId: number, datasetName: string) {
  await page.goto(`/projects/${projectId}/datasets`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
  
  const createButton = page.locator('button:has-text("Create")').first();
  await createButton.waitFor({ state: 'visible', timeout: 10000 });
  await createButton.click();
  await page.waitForTimeout(500);
  
  await page.getByRole('menuitem', { name: 'Dataset', exact: true }).click();
  await page.waitForURL('**/projects/new/dataset', { timeout: 10000 });
  
  await page.fill('input[placeholder*="Vehicle Detection"]', datasetName);
  await page.fill('textarea[placeholder*="Describe"]', 'Initial dataset description for testing');
  
  await page.fill('input[placeholder*="Add tags"]', 'initial-tag');
  await page.click('button:has-text("Add")');
  await expect(page.getByText('initial-tag').first()).toBeVisible();
  
  await page.click('button[type="submit"]:has-text("Create Dataset")');
  await page.waitForURL(/\/projects\/\d+/, { timeout: 20000 });
  await page.waitForLoadState('networkidle', { timeout: 20000 });
}

// Helper function to open edit dialog for a dataset
async function openEditDialog(page: Page, datasetName: string) {
  // Wait for datasets to load with more time
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000); // Give UI more time to settle
  
  // Wait for the specific dataset name to be visible first
  await expect(page.getByText(datasetName).first()).toBeVisible({ timeout: 15000 });
  
  // Find the dataset card
  const allCards = page.locator('div.glass-card, div.overflow-hidden.hover-card');
  await allCards.first().waitFor({ state: 'visible', timeout: 15000 });
  
  // Give DOM time to stabilize
  await page.waitForTimeout(1000);
  
  const cardCount = await allCards.count();
  
  // Find the card with our dataset name
  let targetCard = null;
  for (let i = 0; i < cardCount; i++) {
    const card = allCards.nth(i);
    const text = await card.textContent();
    if (text?.includes(datasetName)) {
      targetCard = card;
      break;
    }
  }
  
  if (!targetCard) {
    throw new Error(`Could not find dataset card for: ${datasetName}`);
  }
  
  // Find the three-dot menu button (MoreHorizontal icon) in this card and click it
  const menuButton = targetCard.locator('button').filter({ has: page.locator('svg') }).last();
  await menuButton.waitFor({ state: 'visible', timeout: 10000 });
  await menuButton.click({ timeout: 10000 });
  
  // Wait for dropdown menu to appear
  await page.waitForTimeout(1000);
  
  // Click "Edit Dataset" menu item
  await page.getByRole('menuitem', { name: 'Edit Dataset' }).click();
  
  // Wait for edit dialog to open
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10000 });
}

test.describe('Edit Dataset', () => {
  const timestamp = Date.now();
  const testProjectName = `Project for Edit Dataset ${timestamp}`;
  const originalDatasetName = `Dataset to Edit ${timestamp}`;
  let projectId: number;
  
  test.beforeEach(async ({ page }) => {
    // Create a test project and dataset before each test
    projectId = await createTestProject(page, testProjectName);
    await createTestDataset(page, projectId, originalDatasetName);
  });

  test('should open edit dialog when clicking edit button', async ({ page }) => {
    // Open the edit dialog
    await openEditDialog(page, originalDatasetName);
    
    // Verify dialog is open
    const editDialog = page.getByRole('dialog');
    await expect(editDialog).toBeVisible();
    
    // Verify dialog title
    await expect(editDialog.getByRole('heading', { name: 'Edit Dataset' })).toBeVisible();
    
    // Verify current values are populated
    await expect(editDialog.locator('input').first()).toHaveValue(originalDatasetName);
    await expect(editDialog.locator('textarea').first()).toHaveValue('Initial dataset description for testing');
    
    // Find the tag within the dialog
    await expect(editDialog.getByText('initial-tag')).toBeVisible();
  });

  test('should successfully change dataset name', async ({ page }) => {
    const newName = `Updated Dataset Name ${timestamp}`;
    
    // Open edit dialog
    await openEditDialog(page, originalDatasetName);
    const editDialog = page.getByRole('dialog');
    
    // Change the name
    await editDialog.locator('input').first().fill(newName);
    
    // Click Save Changes button using evaluate to bypass viewport constraints
    const saveButton = editDialog.locator('button:has-text("Save Changes")');
    await saveButton.evaluate((btn) => (btn as HTMLElement).click());
    
    // Wait for dialog to close (indicates success)
    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 10000 });
    
    // Verify the new name appears on the page
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(newName).first()).toBeVisible({ timeout: 10000 });
  });

  test('should successfully change dataset description', async ({ page }) => {
    const newDescription = 'This is the updated dataset description with more details about the contents';
    
    // Open edit dialog
    await openEditDialog(page, originalDatasetName);
    const editDialog = page.getByRole('dialog');
    
    // Change the description
    await editDialog.locator('textarea').first().fill(newDescription);
    
    // Click Save Changes button
    const saveButton = editDialog.locator('button:has-text("Save Changes")');
    await saveButton.evaluate((btn) => (btn as HTMLElement).click());
    
    // Wait for dialog to close (indicates success)
    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 10000 });
    
    // Verify dataset still exists
    await expect(page.getByText(originalDatasetName).first()).toBeVisible({ timeout: 5000 });
  });

  test('should successfully add and remove tags', async ({ page }) => {
    // Open edit dialog
    await openEditDialog(page, originalDatasetName);
    
    const editDialog = page.getByRole('dialog');
    
    // Add new tags
    const newTags = ['computer-vision', 'annotation', 'testing'];
    for (const tag of newTags) {
      const tagInput = editDialog.locator('input[placeholder*="Add tags"]');
      await tagInput.fill(tag);
      await page.waitForTimeout(300);
      
      const addButton = editDialog.locator('button:has-text("Add")');
      await addButton.waitFor({ state: 'visible', timeout: 5000 });
      await addButton.click({ force: true });
      await page.waitForTimeout(500);
      
      await expect(editDialog.getByText(tag).first()).toBeVisible();
    }
    
    // Remove the initial tag - find it within the dialog
    const initialTagBadge = editDialog.locator('text=initial-tag').first().locator('..');
    const removeButton = initialTagBadge.locator('button').first();
    await removeButton.click({ force: true });
    
    // Wait a moment for UI to update
    await page.waitForTimeout(500);
    
    // Click Save Changes button
    const saveButton = editDialog.locator('button:has-text("Save Changes")');
    await saveButton.evaluate((btn) => (btn as HTMLElement).click());
    
    // Wait for dialog to close (indicates success)
    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 10000 });
    
    // Verify dataset still exists
    await expect(page.getByText(originalDatasetName).first()).toBeVisible({ timeout: 5000 });
  });

  test('should successfully change dataset logo', async ({ page }) => {
    // Open edit dialog
    await openEditDialog(page, originalDatasetName);
    const editDialog = page.getByRole('dialog');
    
    // Upload new logo
    const logoPath = path.join(__dirname, '../../fixtures/test-logo.png');
    const fileInput = editDialog.locator('input[type="file"]').first();
    await fileInput.setInputFiles(logoPath);
    
    // Wait for preview to appear
    await expect(editDialog.locator('img[alt="Logo preview"]')).toBeVisible({ timeout: 5000 });
    
    // Click Save Changes button
    const saveButton = editDialog.locator('button:has-text("Save Changes")');
    await saveButton.evaluate((btn) => (btn as HTMLElement).click());
    
    // Wait for dialog to close (indicates success)
    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 10000 });
    
    // Verify dataset still exists
    await expect(page.getByText(originalDatasetName).first()).toBeVisible({ timeout: 5000 });
  });

  test('should cancel changes without saving', async ({ page }) => {
    // Open edit dialog
    await openEditDialog(page, originalDatasetName);
    const editDialog = page.getByRole('dialog');
    
    // Make some changes
    await editDialog.locator('input').first().fill('Changed Name That Should Not Be Saved');
    
    // Click Cancel button
    const cancelButton = editDialog.locator('button:has-text("Cancel")');
    await cancelButton.evaluate((btn) => (btn as HTMLElement).click());
    
    // Wait for dialog to close
    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 5000 });
    
    // Wait for page to settle
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);
    
    // Verify the changed name is NOT visible anywhere on the page
    // (if the changes were saved, this name would appear)
    const changedNameVisible = await page.getByText('Changed Name That Should Not Be Saved').isVisible().catch(() => false);
    expect(changedNameVisible).toBe(false);
  });

  test('should update multiple fields at once', async ({ page }) => {
    const newName = `Multi Update Dataset ${timestamp}`;
    const newDescription = 'Updated description with multiple field changes';
    const newTag = 'multi-update';
    
    // Open edit dialog
    await openEditDialog(page, originalDatasetName);
    const editDialog = page.getByRole('dialog');
    
    // Change name
    await editDialog.locator('input').first().fill(newName);
    await page.waitForTimeout(300);
    
    // Change description
    await editDialog.locator('textarea').first().fill(newDescription);
    await page.waitForTimeout(300);
    
    // Add a new tag
    const tagInput = editDialog.locator('input[placeholder*="Add tags"]');
    await tagInput.fill(newTag);
    await page.waitForTimeout(300);
    
    const addButton = editDialog.locator('button:has-text("Add")');
    await addButton.waitFor({ state: 'visible', timeout: 5000 });
    await addButton.click({ force: true });
    await page.waitForTimeout(500);
    
    // Use keyboard to submit instead of clicking Save button
    // Press Enter on a form field to submit
    await editDialog.locator('input').first().press('Enter');
    
    // Wait for dialog to close
    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 10000 });
    
    // Verify the new name appears
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(newName).first()).toBeVisible({ timeout: 10000 });
  });
});
