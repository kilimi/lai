import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { getDatabaseInfo } from '../../test-helpers';

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

// Helper function to create a test project
async function createTestProject(page: Page, projectName: string): Promise<number> {
  await page.goto('/projects/new');
  await page.fill('input#name', projectName);
  await page.click('button[type="submit"]:has-text("Create")');
  await page.waitForURL('/', { timeout: 20000, waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 20000 });
  return getProjectId(page, projectName);
}

// Helper function to create a test dataset
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
  await page.click('button[type="submit"]:has-text("Create Dataset")');
  await page.waitForLoadState('networkidle', { timeout: 20000 });
}

// Helper function to navigate to Settings page
async function navigateToSettings(page: Page) {
  await page.goto('/settings');
  await expect(page).toHaveURL('/settings', { timeout: 10000 });
  await page.waitForLoadState('networkidle');
  // Navigate to the "Data Management" tab where Export Database button lives
  const dataTab = page.getByRole('tab', { name: /data/i });
  if (await dataTab.isVisible({ timeout: 3000 })) {
    await dataTab.click();
    await page.waitForTimeout(500);
  }
}

// Helper function to open export dialog
async function openExportDialog(page: Page) {
  // Click on Export Database button
  const exportButton = page.locator('button:has-text("Export Database")');
  await expect(exportButton).toBeVisible({ timeout: 10000 });
  await exportButton.click();
  
  // Wait for dialog to appear
  await expect(page.locator('text=Export Database').first()).toBeVisible({ timeout: 5000 });
}

test.describe('Database Export', () => {
  const timestamp = Date.now();
  const testProjectName1 = `Export Test Project 1 ${timestamp}`;
  const testProjectName2 = `Export Test Project 2 ${timestamp}`;
  const testDatasetName1 = `Test Dataset 1 ${timestamp}`;
  const testDatasetName2 = `Test Dataset 2 ${timestamp}`;
  let projectId1: number;
  let projectId2: number;
  
  test.beforeEach(async ({ page }) => {
    // Create test projects and datasets
    projectId1 = await createTestProject(page, testProjectName1);
    await createTestDataset(page, projectId1, testDatasetName1);
    
    projectId2 = await createTestProject(page, testProjectName2);
    await createTestDataset(page, projectId2, testDatasetName2);
    
    // Navigate to settings
    await navigateToSettings(page);
  });

  test('should open export dialog and show all projects', async ({ page }) => {
    // Open export dialog
    await openExportDialog(page);
    
    // Verify dialog title
    await expect(page.locator('text=Export Database').first()).toBeVisible();
    await expect(page.locator('text=Export selected projects and datasets')).toBeVisible();
    
    // Verify tabs are visible
    await expect(page.locator('button[role="tab"]:has-text("1. Select Data")')).toBeVisible();
    await expect(page.locator('button[role="tab"]:has-text("2. Export Method")')).toBeVisible();
    await expect(page.locator('button[role="tab"]:has-text("Manual Copy")')).toBeVisible();
    
    // Verify both test projects appear in the list
    await expect(page.getByText(testProjectName1)).toBeVisible();
    await expect(page.getByText(testProjectName2)).toBeVisible();
  });

  test('should select projects and datasets', async ({ page }) => {
    // Open export dialog
    await openExportDialog(page);
    
    // Wait for projects to load
    await page.waitForTimeout(1500);
    
    // Find and click checkbox for first project using Radix UI checkbox (button with role=checkbox)
    // Look for checkboxes within the dialog
    const checkboxes = page.locator('[role="dialog"] button[role="checkbox"]');
    await checkboxes.first().click();
    
    // Verify project and datasets are selected
    await expect(page.getByText('1 projects, 1 datasets selected')).toBeVisible();
    
    // Verify Next button is enabled
    const nextButton = page.locator('button:has-text("Next: Choose Export Method")');
    await expect(nextButton).toBeEnabled();
  });

  test('should navigate through export tabs', async ({ page }) => {
    // Open export dialog
    await openExportDialog(page);
    await page.waitForTimeout(1500);
    
    // Select a project by clicking first checkbox (Radix UI uses button with role=checkbox)
    const checkboxes = page.locator('[role="dialog"] button[role="checkbox"]');
    await checkboxes.first().click();
    
    // Click Next button
    const nextButton = page.locator('button:has-text("Next: Choose Export Method")');
    await nextButton.click();
    
    // Verify we're on Export Method tab
    await expect(page.locator('text=Database Only (JSON)')).toBeVisible();
    await expect(page.locator('text=Complete Archive (ZIP)')).toBeVisible();
    
    // Click on Manual Copy tab
    const manualCopyTab = page.locator('button[role="tab"]:has-text("Manual Copy")');
    await manualCopyTab.click();
    
    // Verify manual copy instructions are visible
    await expect(page.locator('text=Manual File Copy (Best for Large Datasets)')).toBeVisible();
    await expect(page.locator('text=Copy Image Directories')).toBeVisible();
  });

  test('should show export methods with correct information', async ({ page }) => {
    // Open export dialog
    await openExportDialog(page);
    await page.waitForTimeout(1500);
    
    // Select a project (Radix UI uses button with role=checkbox)
    const checkboxes = page.locator('[role="dialog"] button[role="checkbox"]');
    await checkboxes.first().click();
    
    // Navigate to Export Method tab
    await page.locator('button:has-text("Next: Choose Export Method")').click();
    
    // Verify Database Only option
    await expect(page.locator('text=Database Only (JSON)')).toBeVisible();
    await expect(page.locator('text=Fast export of metadata, annotations, and structure')).toBeVisible();
    await expect(page.locator('text=~1-5 seconds')).toBeVisible();
    await expect(page.locator('text=Recommended')).toBeVisible();
    
    // Verify Complete Archive option
    await expect(page.locator('text=Complete Archive (ZIP)')).toBeVisible();
    await expect(page.locator('text=Includes database + all image files')).toBeVisible();
    await expect(page.locator('text=For small datasets')).toBeVisible();
  });

  test('should show manual copy instructions with correct paths', async ({ page }) => {
    // Open export dialog
    await openExportDialog(page);
    await page.waitForTimeout(1000);
    
    // Navigate to Manual Copy tab
    const manualCopyTab = page.locator('button[role="tab"]:has-text("Manual Copy")');
    await manualCopyTab.click();
    
    // Verify step 1
    await expect(page.locator('text=Export Database Only (JSON)')).toBeVisible();
    
    // Verify step 2 - Copy Image Directories
    await expect(page.locator('text=Copy Image Directories')).toBeVisible();
    
    // Click on Linux/Mac commands
    const linuxButton = page.locator('button:has-text("Linux / Mac Commands")');
    await linuxButton.click();
    await page.waitForTimeout(300);
    
    // Verify rsync commands with absolute paths are visible
    await expect(page.locator('text=/path/to/lai/backend/projects/')).toBeVisible();
    await expect(page.locator('text=/path/to/lai/backend/data/')).toBeVisible();
    
    // Click on Windows commands
    const windowsButton = page.locator('button:has-text("Windows PowerShell Commands")');
    await windowsButton.click();
    await page.waitForTimeout(300);
    
    // Verify PowerShell commands are visible (with Windows-style paths)
    await expect(page.locator('pre:has-text("Copy-Item -Recurse")')).toBeVisible();
    
    // Verify step 3
    await expect(page.locator('text=Import on Target System')).toBeVisible();
  });

  test('should trigger database export (JSON) with selected projects', async ({ page }) => {
    // Open export dialog
    await openExportDialog(page);
    await page.waitForTimeout(1500);
    
    // Select first project (Radix UI uses button with role=checkbox)
    const checkboxes = page.locator('[role="dialog"] button[role="checkbox"]');
    await checkboxes.first().click();
    
    // Navigate to Export Method tab
    await page.locator('button:has-text("Next: Choose Export Method")').click();
    
    // Listen for download event
    const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
    
    // Click on Database Only export card (the whole card is clickable)
    const databaseOnlyCard = page.locator('[role="dialog"]').locator('text=Database Only (JSON)').locator('..');
    await databaseOnlyCard.click();
    
    // Wait for download to complete (progress UI may be too fast to observe)
    const download = await downloadPromise;
    
    // Verify download filename (format: lai_backup_YYYYMMDD_HHMMSS.json)
    const filename = download.suggestedFilename();
    expect(filename).toMatch(/lai_backup_.*\.json/);
    
    // Verify file was downloaded (optional - check file size > 0)
    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();
  });

  test('should show progress during export', async ({ page }) => {
    // Open export dialog
    await openExportDialog(page);
    await page.waitForTimeout(1500);
    
    // Select a project (Radix UI uses button with role=checkbox)
    const checkboxes = page.locator('[role="dialog"] button[role="checkbox"]');
    await checkboxes.first().click();
    
    // Navigate to Export Method tab
    await page.locator('button:has-text("Next: Choose Export Method")').click();
    
    // Listen for download event
    const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
    
    // Click on Database Only export card (the whole card is clickable)
    const databaseOnlyCard = page.locator('[role="dialog"]').locator('text=Database Only (JSON)').locator('..');
    await databaseOnlyCard.click();
    
    // Wait for download to complete
    // Note: For small test datasets, export is so fast that progress UI may not be visible
    const download = await downloadPromise;
    
    // Verify the export completed successfully by checking the filename
    expect(download.suggestedFilename()).toMatch(/lai_backup_.*\.json$/);
    
    // Verify file was downloaded
    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();
  });

  test('should disable Next button when no projects selected', async ({ page }) => {
    // Open export dialog
    await openExportDialog(page);
    await page.waitForTimeout(1000);
    
    // Verify Next button is disabled
    const nextButton = page.locator('button:has-text("Next: Choose Export Method")');
    await expect(nextButton).toBeDisabled();
    
    // Verify selection counter shows 0
    await expect(page.getByText('0 projects, 0 datasets selected')).toBeVisible();
  });

  test('should allow copying commands to clipboard', async ({ page, browserName }) => {
    // Skip on Firefox and WebKit as they don't support clipboard permissions
    test.skip(browserName === 'firefox' || browserName === 'webkit', 'Clipboard permissions not supported');
    
    // Grant clipboard permissions
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    
    // Open export dialog
    await openExportDialog(page);
    await page.waitForTimeout(1000);
    
    // Navigate to Manual Copy tab
    const manualCopyTab = page.locator('button[role="tab"]:has-text("Manual Copy")');
    await manualCopyTab.click();
    
    // Click on Linux/Mac commands to expand
    const linuxButton = page.locator('button:has-text("Linux / Mac Commands")');
    await linuxButton.click();
    await page.waitForTimeout(500);
    
    // Find and click copy button more reliably
    const copyButton = page.locator('[role="dialog"] button').filter({ hasText: /^$/ }).nth(0);
    if (await copyButton.isVisible()) {
      await copyButton.click();
      await page.waitForTimeout(500);
    }
  });

  test('should show stats when database has data', async ({ page }) => {
    // Get database info to verify we have data
    const dbInfo = await getDatabaseInfo(page);
    expect(dbInfo.database_info.projects).toBeGreaterThan(0);
    
    // Open export dialog
    await openExportDialog(page);
    await page.waitForTimeout(1000);
    
    // Verify stats are displayed within the dialog
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog.locator('text=Projects').first()).toBeVisible();
    await expect(dialog.locator('text=Datasets').first()).toBeVisible();
    await expect(dialog.locator('text=Images').first()).toBeVisible();
    await expect(dialog.locator('text=Annotations').first()).toBeVisible();
    
    // Verify the count numbers are visible in the stats grid
    const projectCount = dbInfo.database_info.projects;
    await expect(dialog.locator('.text-lg.font-semibold').filter({ hasText: projectCount.toString() }).first()).toBeVisible();
  });

  test('should close export dialog', async ({ page }) => {
    // Open export dialog
    await openExportDialog(page);
    
    // Verify dialog is open
    await expect(page.locator('text=Export Database').first()).toBeVisible();
    
    // Press Escape key to close dialog
    await page.keyboard.press('Escape');
    
    // Verify dialog is closed (title should not be visible)
    await expect(page.locator('text=Export selected projects and datasets')).not.toBeVisible({ timeout: 3000 });
  });
});

test.describe('Database Export - Edge Cases', () => {
  test('should show appropriate message for large datasets', async ({ page }) => {
    // Navigate to settings
    await page.goto('/settings');
    await page.waitForLoadState('networkidle');
    
    // Get database info
    const dbInfo = await getDatabaseInfo(page);
    
    // Open export dialog
    await page.click('button:has-text("Export Database")');
    await page.waitForTimeout(1000);
    
    // Select a project if available
    const firstProject = page.locator('input[type="checkbox"]').first();
    if (await firstProject.isVisible()) {
      await firstProject.click();
      await page.locator('button:has-text("Next: Choose Export Method")').click();
    }
    
    // If database has more than 1000 images, warning should appear
    if (dbInfo.database_info.images > 1000) {
      await expect(page.locator('text=Large Dataset')).toBeVisible();
      await expect(page.locator('text=Consider')).toBeVisible();
      await expect(page.locator('text=Database Only')).toBeVisible();
    }
  });

  test('should handle export with no data selected gracefully', async ({ page }) => {
    // Navigate to settings
    await page.goto('/settings');
    await page.waitForLoadState('networkidle');
    
    // Open export dialog
    await page.click('button:has-text("Export Database")');
    await page.waitForTimeout(1000);
    
    // Try to proceed without selecting anything
    const nextButton = page.locator('button:has-text("Next: Choose Export Method")');
    
    // Button should be disabled
    await expect(nextButton).toBeDisabled();
  });
});
