import { test, expect, Page } from '@playwright/test';

// Run tests serially to avoid parallel project creation conflicts
test.describe.configure({ mode: 'serial' });

// Increase timeout for all tests in this file
test.setTimeout(60000);

// Helper function to create a test project first (datasets need a project)
async function createTestProject(page: Page, projectName: string): Promise<number> {
  await page.goto('/projects/new');
  await page.fill('input#name', projectName);
  await page.click('button[type="submit"]:has-text("Create")');
  await page.waitForURL('/', { timeout: 20000, waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 20000 });
  // Get project ID via API - find newest project with this name
  const projectId = await page.evaluate(async (name) => {
    const r = await fetch('http://localhost:9999/projects');
    const projects = await r.json();
    const sorted = [...projects].sort((a: any, b: any) => b.id - a.id);
    const p = sorted.find((p: any) => p.name === name);
    return p ? p.id : 0;
  }, projectName);
  return projectId;
}

// Helper function to create a test dataset within a project
async function createTestDataset(page: Page, projectId: number, datasetName: string) {
  await page.goto(`/projects/${projectId}/datasets`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
  
  const createButton = page.locator('button:has-text("Create")').first();
  await createButton.click();
  await page.waitForTimeout(500);
  await page.getByRole('menuitem', { name: 'Dataset', exact: true }).click();
  await page.waitForURL('**/projects/new/dataset', { timeout: 10000 });
  
  await page.fill('input[placeholder*="Vehicle Detection"]', datasetName);
  await page.fill('textarea[placeholder*="Describe"]', 'Test dataset for deletion testing');
  await page.click('button[type="submit"]:has-text("Create Dataset")');
  await page.waitForLoadState('networkidle', { timeout: 20000 });
}

// Helper to navigate to project datasets page
async function navigateToProjectDatasets(page: Page, projectId: number) {
  await page.goto(`/projects/${projectId}/datasets`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
}

// Helper to navigate to a specific dataset's detail page
async function navigateToDatasetDetail(page: Page, projectId: number, datasetName: string) {
  // Get dataset ID via API
  const datasetId = await page.evaluate(async ({ pid, dname }) => {
    const r = await fetch(`http://localhost:9999/projects/${pid}`);
    const p = await r.json();
    const d = p.datasets?.find((d: any) => d.name === dname);
    return d ? d.id : 0;
  }, { pid: projectId, dname: datasetName });
  if (!datasetId) throw new Error(`Dataset not found: ${datasetName}`);
  await page.goto(`/projects/${projectId}/datasets/${datasetId}`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);
}

test.describe('Delete Dataset', () => {
  const timestamp = Date.now();
  const testProjectName = `Project for Delete Test ${timestamp}`;
  let projectId: number;
  
  test.beforeEach(async ({ page }) => {
    // Create a test project before each test
    projectId = await createTestProject(page, testProjectName);
  });

  test('should delete dataset from dataset card dropdown menu', async ({ page }) => {
    const datasetName = `Dataset to Delete Card ${timestamp}`;
    
    // Create a test dataset
    await createTestDataset(page, projectId, datasetName);
    
    // Navigate to project datasets page
    await navigateToProjectDatasets(page, projectId);
    
    // Wait for the dataset to be visible
    await expect(page.getByText(datasetName).first()).toBeVisible({ timeout: 15000 });
    
    // Find and click the MoreHorizontal dropdown trigger on the dataset card (h-7 w-7 icon button)
    const dropdownTrigger = page.locator('button.h-7.w-7').first();
    await dropdownTrigger.waitFor({ state: 'visible', timeout: 10000 });
    await dropdownTrigger.click();
    
    // Wait for dropdown menu to appear
    await page.waitForTimeout(500);
    
    // Click on Delete option
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    
    // Wait for confirmation dialog to appear
    await page.waitForTimeout(500);
    
    // Verify confirmation dialog is visible
    const confirmDialog = page.getByRole('alertdialog');
    await expect(confirmDialog).toBeVisible({ timeout: 5000 });
    console.log('✓ Confirmation dialog is visible');
    
    // Click the confirm delete button in the dialog
    const confirmDeleteButton = confirmDialog.locator('button:has-text("Delete")');
    await confirmDeleteButton.click();
    
    // Wait for deletion to complete
    await page.waitForLoadState('networkidle', { timeout: 10000 });
    
    // Verify success toast appears
    const successToast = page.getByText(/Dataset Deleted/i);
    await expect(successToast).toBeVisible({ timeout: 5000 });
    console.log('✓ Delete success toast is visible');
    
    // Verify the dataset is no longer visible
    await page.waitForTimeout(1000);
    await expect(page.getByText(datasetName)).not.toBeVisible({ timeout: 10000 });
    console.log('✓ Dataset is no longer visible after deletion');
  });

  test('should delete dataset from dataset detail page', async ({ page }) => {
    const datasetName = `Dataset to Delete Detail ${timestamp}`;
    
    // Create a test dataset
    await createTestDataset(page, projectId, datasetName);
    
    // Navigate to dataset detail page
    await navigateToDatasetDetail(page, projectId, datasetName);
    
    // Open Actions dropdown and click Delete Dataset
    const actionsButton = page.locator('button:has-text("Actions")');
    await expect(actionsButton).toBeVisible({ timeout: 10000 });
    await actionsButton.click();
    await page.waitForTimeout(300);
    await page.getByRole('menuitem', { name: 'Delete Dataset' }).click();
    
    // Wait for confirmation dialog to appear
    await page.waitForTimeout(500);
    
    // Verify confirmation dialog is visible
    const confirmDialog = page.getByRole('dialog');
    await expect(confirmDialog).toBeVisible({ timeout: 5000 });
    console.log('✓ Confirmation dialog is visible');
    
    // Verify dialog contains warning text
    await expect(page.getByText(/permanently delete/i)).toBeVisible();
    console.log('✓ Warning text is visible in dialog');
    
    // Click the confirm delete button in the dialog
    const confirmDeleteButton = confirmDialog.locator('button:has-text("Delete Dataset")');
    await confirmDeleteButton.click();
    
    // Wait for deletion to complete and navigation
    await page.waitForLoadState('networkidle', { timeout: 15000 });
    
    // Verify we're navigated back to project datasets page
    await expect(page).toHaveURL(/\/projects\/\d+\/datasets/, { timeout: 10000 });
    console.log('✓ Navigated back to project datasets page');
    
    // Verify the dataset is no longer visible
    await page.waitForTimeout(1000);
    await expect(page.getByText(datasetName)).not.toBeVisible({ timeout: 10000 });
    console.log('✓ Dataset is no longer visible after deletion');
  });

  test('should cancel dataset deletion from confirmation dialog', async ({ page }) => {
    const datasetName = `Dataset Cancel Delete ${timestamp}`;
    
    // Create a test dataset
    await createTestDataset(page, projectId, datasetName);
    
    // Navigate to dataset detail page
    await navigateToDatasetDetail(page, projectId, datasetName);
    
    // Open Actions dropdown and click Delete Dataset
    const actionsButton = page.locator('button:has-text("Actions")');
    await expect(actionsButton).toBeVisible({ timeout: 10000 });
    await actionsButton.click();
    await page.waitForTimeout(300);
    await page.getByRole('menuitem', { name: 'Delete Dataset' }).click();
    
    // Wait for confirmation dialog to appear
    await page.waitForTimeout(500);
    
    // Verify confirmation dialog is visible
    const confirmDialog = page.getByRole('dialog');
    await expect(confirmDialog).toBeVisible({ timeout: 5000 });
    
    // Click the cancel button
    const cancelButton = confirmDialog.locator('button:has-text("Cancel")');
    await cancelButton.click();
    
    // Wait for dialog to close
    await page.waitForTimeout(500);
    
    // Verify dialog is closed
    await expect(confirmDialog).not.toBeVisible({ timeout: 5000 });
    console.log('✓ Confirmation dialog is closed after cancel');
    
    // Verify we're still on the dataset detail page
    await expect(page.getByText(datasetName)).toBeVisible({ timeout: 5000 });
    console.log('✓ Still on dataset detail page - deletion was cancelled');
  });

  test('should show confirmation dialog with dataset deletion warning', async ({ page }) => {
    const datasetName = `Dataset Confirm Dialog ${timestamp}`;
    
    // Create a test dataset
    await createTestDataset(page, projectId, datasetName);
    
    // Navigate to dataset detail page
    await navigateToDatasetDetail(page, projectId, datasetName);
    
    // Open Actions dropdown and click Delete Dataset
    const actionsButton = page.locator('button:has-text("Actions")');
    await expect(actionsButton).toBeVisible({ timeout: 10000 });
    await actionsButton.click();
    await page.waitForTimeout(300);
    await page.getByRole('menuitem', { name: 'Delete Dataset' }).click();
    
    // Wait for confirmation dialog to appear
    await page.waitForTimeout(500);
    
    // Verify confirmation dialog components
    const confirmDialog = page.getByRole('dialog');
    await expect(confirmDialog).toBeVisible({ timeout: 5000 });
    
    // Verify dialog title
    await expect(page.getByText('Delete Dataset', { exact: true })).toBeVisible();
    console.log('✓ Dialog title is visible');
    
    // Verify warning message about permanent deletion
    await expect(page.getByText(/permanently delete this dataset/i)).toBeVisible();
    console.log('✓ Permanent deletion warning is visible');
    
    // Verify warning about associated data (images and annotations)
    await expect(page.getByText(/images and annotations/i)).toBeVisible();
    console.log('✓ Warning about associated data is visible');
    
    // Verify Cancel button is present
    await expect(confirmDialog.locator('button:has-text("Cancel")')).toBeVisible();
    console.log('✓ Cancel button is visible');
    
    // Verify Delete Dataset confirm button is present
    await expect(confirmDialog.locator('button:has-text("Delete Dataset")')).toBeVisible();
    console.log('✓ Confirm delete button is visible');
  });
});
