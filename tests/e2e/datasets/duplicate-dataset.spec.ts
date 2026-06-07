import { test, expect, Page } from '@playwright/test';

// Run tests serially to avoid parallel project creation conflicts
test.describe.configure({ mode: 'serial' });

// Increase timeout for all tests in this file
test.setTimeout(60000);

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

// Helper to get dataset ID from API
async function getDatasetId(page: Page, projectId: number, datasetName: string): Promise<number> {
  return page.evaluate(async ({ pid, dname }) => {
    const r = await fetch(`http://localhost:9999/projects/${pid}`);
    const p = await r.json();
    const d = p.datasets?.find((d: any) => d.name === dname);
    return d ? d.id : 0;
  }, { pid: projectId, dname: datasetName });
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
  await createButton.click();
  await page.waitForTimeout(500);
  await page.getByRole('menuitem', { name: 'Dataset', exact: true }).click();
  await page.waitForURL('**/projects/new/dataset', { timeout: 10000 });
  
  await page.fill('input[placeholder*="Vehicle Detection"]', datasetName);
  await page.fill('textarea[placeholder*="Describe"]', 'Test dataset for duplication testing');
  
  // Add tags
  await page.fill('input[placeholder*="Add tags"]', 'test-tag');
  await page.click('button:has-text("Add")');
  await expect(page.getByText('test-tag').first()).toBeVisible();
  
  await page.fill('input[placeholder*="Add tags"]', 'another-tag');
  await page.click('button:has-text("Add")');
  await expect(page.getByText('another-tag').first()).toBeVisible();
  
  await page.click('button[type="submit"]:has-text("Create Dataset")');
  await page.waitForLoadState('networkidle', { timeout: 20000 });
}

// Helper to navigate to a specific dataset's detail page
async function navigateToDatasetDetail(page: Page, projectId: number, datasetName: string) {
  const datasetId = await getDatasetId(page, projectId, datasetName);
  if (!datasetId) throw new Error(`Dataset not found: ${datasetName}`);
  await page.goto(`/projects/${projectId}/datasets/${datasetId}`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);
}

// Helper to navigate to project datasets page
async function navigateToProjectDatasets(page: Page, projectId: number) {
  await page.goto(`/projects/${projectId}/datasets`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
}

// Helper to duplicate dataset using the Actions dropdown on dataset detail page
async function duplicateDatasetFromDetailPage(page: Page) {
  // Open the Actions dropdown
  const actionsButton = page.locator('button:has-text("Actions")');
  await expect(actionsButton).toBeVisible({ timeout: 10000 });
  await actionsButton.click();
  await page.waitForTimeout(300);
  // Click the Duplicate Dataset menu item
  await page.getByRole('menuitem', { name: 'Duplicate Dataset' }).click();
}

// Helper to wait for duplication to complete
async function waitForDuplicationComplete(page: Page) {
  // Wait for success notification or navigation
  await page.waitForTimeout(5000);
  await page.waitForLoadState('networkidle', { timeout: 30000 });
}

test.describe('Duplicate Dataset', () => {
  const timestamp = Date.now();
  const testProjectName = `Project for Duplicate Test ${timestamp}`;
  const testDatasetName = `Dataset to Duplicate ${timestamp}`;
  let projectId: number;
  
  test.beforeEach(async ({ page }) => {
    // Create a test project and dataset before each test
    projectId = await createTestProject(page, testProjectName);
    await createTestDataset(page, projectId, testDatasetName);
    
    // Navigate to project datasets page
    await navigateToProjectDatasets(page, projectId);
  });

  test('should show duplication started notification when duplicating from detail page', async ({ page }) => {
    // Navigate to dataset detail
    await navigateToDatasetDetail(page, projectId, testDatasetName);
    
    // Click on "Duplicate Dataset" button
    await duplicateDatasetFromDetailPage(page);
    
    // Wait a brief moment for the toast to render
    await page.waitForTimeout(500);
    
    // Verify the "Duplication Started" notification appears
    const startNotification = page.getByText(/Duplication Started/i).first();
    await expect(startNotification).toBeVisible({ timeout: 5000 });
    console.log('✓ Start notification is visible');
    
    // Verify the descriptive text about background task
    const backgroundText = page.getByText(/duplication.*running.*background/i).first();
    await expect(backgroundText).toBeVisible({ timeout: 3000 });
    console.log('✓ Background task description is visible');
  });

  test('should navigate to project datasets page after duplication completes', async ({ page }) => {
    // Navigate to dataset detail
    await navigateToDatasetDetail(page, projectId, testDatasetName);
    
    // Click on "Duplicate Dataset" button
    await duplicateDatasetFromDetailPage(page);
    
    // Wait for duplication to complete and navigation
    await waitForDuplicationComplete(page);
    
    // Verify we're on the project datasets page (not the specific duplicated dataset)
    const currentUrl = page.url();
    expect(currentUrl).toMatch(/\/projects\/\d+\/datasets$/);
    console.log('✓ Navigated to project datasets page:', currentUrl);
    
    // Verify both original and duplicated datasets are visible
    await expect(page.getByText(testDatasetName).first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(`${testDatasetName} (Copy)`).first()).toBeVisible({ timeout: 10000 });
    console.log('✓ Both original and duplicated datasets visible');
  });

  test('should preserve dataset name with (Copy) suffix after duplication', async ({ page }) => {
    // Navigate to dataset detail
    await navigateToDatasetDetail(page, projectId, testDatasetName);
    
    // Duplicate the dataset
    await duplicateDatasetFromDetailPage(page);
    
    // Wait for duplication to complete
    await waitForDuplicationComplete(page);
    
    // Navigate to project datasets if not already there
    await navigateToProjectDatasets(page, projectId);
    
    // Verify the duplicated dataset has "(Copy)" in the name
    await expect(page.getByText(`${testDatasetName} (Copy)`).first()).toBeVisible({ timeout: 10000 });
    console.log('✓ Duplicated dataset has (Copy) suffix');
  });

  test('should preserve dataset description after duplication', async ({ page }) => {
    // Navigate to dataset detail
    await navigateToDatasetDetail(page, projectId, testDatasetName);
    
    // Duplicate the dataset
    await duplicateDatasetFromDetailPage(page);
    
    // Wait for duplication to complete
    await waitForDuplicationComplete(page);
    
    // Navigate to the duplicated dataset
    await navigateToProjectDatasets(page, projectId);
    const copyLink = page.getByText(`${testDatasetName} (Copy)`).first();
    await copyLink.waitFor({ state: 'visible', timeout: 15000 });
    await copyLink.click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
    
    // Open edit dialog to verify description is preserved
    const actionsBtn1 = page.locator('button:has-text("Actions")');
    await actionsBtn1.click();
    await page.getByRole('menuitem', { name: 'Edit Dataset' }).click();
    await page.waitForTimeout(500);
    
    // Check the description in the edit dialog
    const descriptionField = page.locator('textarea').first();
    await expect(descriptionField).toHaveValue('Test dataset for duplication testing');
    console.log('✓ Description preserved in duplicated dataset');
  });

  test('should preserve all dataset tags after duplication', async ({ page }) => {
    // Navigate to dataset detail
    await navigateToDatasetDetail(page, projectId, testDatasetName);
    
    // Duplicate the dataset
    await duplicateDatasetFromDetailPage(page);
    
    // Wait for duplication to complete
    await waitForDuplicationComplete(page);
    
    // Navigate to the duplicated dataset
    await navigateToProjectDatasets(page, projectId);
    const copyLink = page.getByText(`${testDatasetName} (Copy)`).first();
    await copyLink.waitFor({ state: 'visible', timeout: 15000 });
    await copyLink.click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
    
    // Open edit dialog to verify tags are preserved
    const actionsBtn2 = page.locator('button:has-text("Actions")');
    await actionsBtn2.click();
    await page.getByRole('menuitem', { name: 'Edit Dataset' }).click();
    await page.waitForTimeout(500);
    
    // Check both tags are present in the edit dialog
    const editDialog = page.getByRole('dialog');
    await expect(editDialog.getByText('test-tag')).toBeVisible({ timeout: 5000 });
    await expect(editDialog.getByText('another-tag')).toBeVisible({ timeout: 5000 });
    console.log('✓ All tags preserved in duplicated dataset');
  });

  test('should create independent copy that can be edited separately', async ({ page }) => {
    // Navigate to dataset detail
    await navigateToDatasetDetail(page, projectId, testDatasetName);
    
    // Duplicate the dataset
    await duplicateDatasetFromDetailPage(page);
    
    // Wait for duplication to complete
    await waitForDuplicationComplete(page);
    
    // Navigate to project to verify both datasets exist
    await navigateToProjectDatasets(page, projectId);
    
    // Both original and copy should be visible in the project
    await expect(page.getByText(testDatasetName).first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(`${testDatasetName} (Copy)`).first()).toBeVisible({ timeout: 10000 });
    console.log('✓ Both original and duplicated datasets exist independently');
    
    // Edit the duplicated dataset to verify independence
    const copyLink = page.getByText(`${testDatasetName} (Copy)`).first();
    await copyLink.click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
    
    const actionsBtn3 = page.locator('button:has-text("Actions")');
    await actionsBtn3.click();
    await page.getByRole('menuitem', { name: 'Edit Dataset' }).click();
    await page.waitForTimeout(500);
    
    // Change the description
    const descriptionField = page.locator('textarea').first();
    await descriptionField.fill('Modified description for the copy');
    
    // Use keyboard to submit the form (more reliable than clicking save button)
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
    
    // Navigate back to original dataset and verify its description is unchanged
    await navigateToDatasetDetail(page, projectId, testDatasetName);
    
    const actionsBtn4 = page.locator('button:has-text("Actions")');
    await actionsBtn4.click();
    await page.getByRole('menuitem', { name: 'Edit Dataset' }).click();
    await page.waitForTimeout(500);
    
    const originalDescriptionField = page.locator('textarea').first();
    await expect(originalDescriptionField).toHaveValue('Test dataset for duplication testing');
    console.log('✓ Original dataset unchanged after editing the copy');
  });

  test('should duplicate dataset from 3-dot menu on dataset card', async ({ page }) => {
    // Navigate to project datasets page
    await navigateToProjectDatasets(page, projectId);
    
    // Wait for dataset cards to load
    await page.waitForTimeout(1500);
    
    // Find the 3-dot menu button on the dataset card
    // Look for button with the MoreHorizontal icon (size icon h-7 w-7)
    const moreButton = page.locator('button.h-7.w-7').first();
    await moreButton.waitFor({ state: 'visible', timeout: 15000 });
    await moreButton.click();
    await page.waitForTimeout(500);
    
    // Click on "Duplicate" menu item
    const duplicateMenuItem = page.getByRole('menuitem', { name: 'Duplicate' });
    await duplicateMenuItem.waitFor({ state: 'visible', timeout: 5000 });
    await duplicateMenuItem.click();
    
    // Wait a brief moment for the toast to render
    await page.waitForTimeout(500);
    
    // Verify the "Duplication Started" notification appears
    const startNotification = page.getByText(/Duplication Started/i).first();
    await expect(startNotification).toBeVisible({ timeout: 5000 });
    console.log('✓ Duplication started from 3-dot menu');
    
    // Wait for duplication to complete
    await waitForDuplicationComplete(page);
    
    // Refresh to see the duplicated dataset
    await page.reload();
    await page.waitForLoadState('networkidle');
    
    // Verify both datasets exist
    await expect(page.getByText(testDatasetName).first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(`${testDatasetName} (Copy)`).first()).toBeVisible({ timeout: 10000 });
    console.log('✓ Duplicated dataset appears in project after using 3-dot menu');
  });

  test('should show duplicate button only on dataset detail page', async ({ page }) => {
    // On project page, "Actions" dropdown with Duplicate Dataset should not be visible
    await navigateToProjectDatasets(page, projectId);
    await expect(page.locator('button:has-text("Actions")')).not.toBeVisible();
    console.log('✓ Actions button not visible on project page');
    
    // Navigate to dataset detail
    await navigateToDatasetDetail(page, projectId, testDatasetName);
    
    // Now Actions dropdown should be visible with Duplicate Dataset option
    const actionsButton = page.locator('button:has-text("Actions")');
    await expect(actionsButton).toBeVisible({ timeout: 10000 });
    await actionsButton.click();
    await expect(page.getByRole('menuitem', { name: 'Duplicate Dataset' })).toBeVisible({ timeout: 5000 });
    await page.keyboard.press('Escape'); // Close dropdown
    console.log('✓ Duplicate Dataset option visible in Actions dropdown on dataset detail page');
  });

  test('duplicated dataset should have same project association', async ({ page }) => {
    // Navigate to dataset detail
    await navigateToDatasetDetail(page, projectId, testDatasetName);
    
    // Duplicate the dataset
    await duplicateDatasetFromDetailPage(page);
    
    // Wait for duplication to complete
    await waitForDuplicationComplete(page);
    
    // Navigate to project
    await navigateToProjectDatasets(page, projectId);
    
    // Both datasets should be under the same project
    await expect(page.getByText(testDatasetName).first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(`${testDatasetName} (Copy)`).first()).toBeVisible({ timeout: 10000 });
    console.log('✓ Both datasets under the same project');
  });

  test('should show success notification when duplication completes', async ({ page }) => {
    // Navigate to dataset detail
    await navigateToDatasetDetail(page, projectId, testDatasetName);
    
    // Duplicate the dataset
    await duplicateDatasetFromDetailPage(page);
    
    // Wait for the success notification to appear
    await page.waitForTimeout(5000);
    
    // Verify the success notification appears
    const successNotification = page.getByText(/Dataset Duplicated/i).first();
    await expect(successNotification).toBeVisible({ timeout: 15000 });
    console.log('✓ Success notification shown');
  });
});
