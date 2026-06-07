import { test, expect, Page } from '@playwright/test';

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

// Helper function to create a source dataset for augmentation
async function createSourceDataset(page: Page, projectId: number, datasetName: string) {
  await page.goto(`/projects/${projectId}/datasets`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
  
  const createButton = page.locator('button:has-text("Create")').first();
  await createButton.click();
  await page.waitForTimeout(500);
  await page.getByRole('menuitem', { name: 'Dataset', exact: true }).click();
  await page.waitForURL('**/projects/new/dataset', { timeout: 10000 });
  
  await page.fill('input[placeholder*="Vehicle Detection"]', datasetName);
  await page.click('button[type="submit"]:has-text("Create")');
  await page.waitForLoadState('networkidle', { timeout: 20000 });
}

// Helper to open the augmented dataset modal
async function openAugmentedDatasetModal(page: Page, projectId: number) {
  await page.goto(`/projects/${projectId}/datasets`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
  
  const createButton = page.locator('button:has-text("Create")').first();
  await createButton.click();
  await page.waitForTimeout(500);
  
  await page.getByText('Augmented Dataset').click();
  
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5000 });
  await expect(page.getByRole('heading', { name: 'Create Augmented Dataset' })).toBeVisible();
}

test.describe('Create Augmented Dataset', () => {
  const timestamp = Date.now();
  const testProjectName = `Augmented Test Project ${timestamp}`;
  const sourceDatasetName = `Source Dataset ${timestamp}`;
  let projectId: number;
  
  test.beforeEach(async ({ page }) => {
    // Create a test project first
    projectId = await createTestProject(page, testProjectName);
    
    // Create a source dataset to use for augmentation
    await createSourceDataset(page, projectId, sourceDatasetName);
  });

  test('should open augmented dataset modal without crashing', async ({ page }) => {
    // This test is specifically designed to catch the infinite loop error
    // If there's a maximum update depth exceeded error, this test will fail
    
    // Set up a listener for console errors
    const consoleErrors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });
    
    // Set up a listener for page errors
    const pageErrors: Error[] = [];
    page.on('pageerror', error => {
      pageErrors.push(error);
    });
    
    // Open the augmented dataset modal
    await openAugmentedDatasetModal(page, projectId);
    
    // Wait a moment for any potential infinite loops to manifest
    await page.waitForTimeout(2000);
    
    // Check for the infinite loop error
    const hasInfiniteLoopError = consoleErrors.some(error => 
      error.includes('Maximum update depth exceeded')
    ) || pageErrors.some(error => 
      error.message.includes('Maximum update depth exceeded')
    );
    
    expect(hasInfiniteLoopError).toBe(false);
    
    // Verify the modal is still visible and not crashed
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Create Augmented Dataset' })).toBeVisible();
    
    // Verify essential elements are present
    await expect(page.getByText('Dataset Name')).toBeVisible();
    await expect(page.getByText('Source Datasets')).toBeVisible();
    await expect(page.getByText('Select Augmentation Methods')).toBeVisible();
  });

  test('should toggle augmentation method without infinite loop', async ({ page }) => {
    // Set up error listeners
    const consoleErrors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });
    
    const pageErrors: Error[] = [];
    page.on('pageerror', error => {
      pageErrors.push(error);
    });
    
    // Open the augmented dataset modal
    await openAugmentedDatasetModal(page, projectId);
    
    // Wait for modal to fully load
    await page.waitForTimeout(1000);
    
    // Find and click on an augmentation method (e.g., Rotation)
    // The geometric category should be expanded by default
    const rotationCheckbox = page.locator('text=Rotation').first();
    await expect(rotationCheckbox).toBeVisible({ timeout: 5000 });
    
    // Click to select the augmentation method
    await rotationCheckbox.click();
    
    // Wait for potential state updates
    await page.waitForTimeout(1000);
    
    // Log errors for debugging
    if (consoleErrors.length > 0) {
      console.log('Console errors after first click:', consoleErrors);
    }
    if (pageErrors.length > 0) {
      console.log('Page errors after first click:', pageErrors.map(e => e.message));
    }
    
    // Check for infinite loop error
    const hasInfiniteLoopError = consoleErrors.some(error => 
      error.includes('Maximum update depth exceeded')
    ) || pageErrors.some(error => 
      error.message.includes('Maximum update depth exceeded')
    );
    
    expect(hasInfiniteLoopError).toBe(false);
    
    // Verify the modal is still responsive
    await expect(page.getByRole('dialog')).toBeVisible();
    
    // Try clicking again to toggle off
    await rotationCheckbox.click();
    await page.waitForTimeout(1000);
    
    // Check again for errors
    const hasInfiniteLoopErrorAfterToggle = consoleErrors.some(error => 
      error.includes('Maximum update depth exceeded')
    ) || pageErrors.some(error => 
      error.message.includes('Maximum update depth exceeded')
    );
    
    expect(hasInfiniteLoopErrorAfterToggle).toBe(false);
  });

  test('should select source dataset without crashing', async ({ page }) => {
    // Set up error listeners
    const consoleErrors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });
    
    const pageErrors: Error[] = [];
    page.on('pageerror', error => {
      pageErrors.push(error);
    });
    
    // Open the augmented dataset modal
    await openAugmentedDatasetModal(page, projectId);
    
    // Wait for modal to fully load
    await page.waitForTimeout(1000);
    
    // Find the source dataset in the modal's list and click it
    // The modal should show datasets - look inside the dialog
    const dialog = page.getByRole('dialog');
    const sourceDataset = dialog.getByText(sourceDatasetName).first();
    
    // If the source dataset is visible in the modal, click it
    if (await sourceDataset.isVisible({ timeout: 3000 }).catch(() => false)) {
      await sourceDataset.click();
    } else {
      // If no datasets are shown, just check we can interact with the checkbox area
      const firstCheckbox = dialog.locator('input[type="checkbox"]').first();
      if (await firstCheckbox.isVisible({ timeout: 3000 }).catch(() => false)) {
        await firstCheckbox.click();
      }
    }
    
    // Wait for potential state updates
    await page.waitForTimeout(1000);
    
    // Check for infinite loop error
    const hasInfiniteLoopError = consoleErrors.some(error => 
      error.includes('Maximum update depth exceeded')
    ) || pageErrors.some(error => 
      error.message.includes('Maximum update depth exceeded')
    );
    
    expect(hasInfiniteLoopError).toBe(false);
    
    // Verify the modal is still visible
    await expect(page.getByRole('dialog')).toBeVisible();
  });

  test('should be able to close modal without error', async ({ page }) => {
    // Set up error listeners
    const consoleErrors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });
    
    const pageErrors: Error[] = [];
    page.on('pageerror', error => {
      pageErrors.push(error);
    });
    
    // Open the augmented dataset modal
    await openAugmentedDatasetModal(page, projectId);
    
    // Wait for modal to appear
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.waitForTimeout(500);
    
    // Close the modal by clicking the X button
    const closeButton = page.locator('[role="dialog"] button').filter({ has: page.locator('svg') }).first();
    await closeButton.click();
    
    // Wait for modal to close
    await page.waitForTimeout(1000);
    
    // Check for infinite loop error
    const hasInfiniteLoopError = consoleErrors.some(error => 
      error.includes('Maximum update depth exceeded')
    ) || pageErrors.some(error => 
      error.message.includes('Maximum update depth exceeded')
    );
    
    expect(hasInfiniteLoopError).toBe(false);
    
    // Verify the modal is closed
    await expect(page.getByRole('dialog')).not.toBeVisible();
  });

  test('should interact with multiple checkboxes without crashing', async ({ page }) => {
    // Set up error listeners
    const consoleErrors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });
    
    const pageErrors: Error[] = [];
    page.on('pageerror', error => {
      pageErrors.push(error);
    });
    
    // Open the augmented dataset modal
    await openAugmentedDatasetModal(page, projectId);
    
    // Wait for modal to fully load
    await page.waitForTimeout(1000);
    
    const dialog = page.getByRole('dialog');
    
    // Try to select source dataset if available
    const sourceDataset = dialog.getByText(sourceDatasetName).first();
    if (await sourceDataset.isVisible({ timeout: 2000 }).catch(() => false)) {
      await sourceDataset.click();
      await page.waitForTimeout(500);
    }
    
    // Try clicking multiple augmentation methods rapidly
    const augmentationMethods = ['Rotation', 'Horizontal Flip', 'Brightness'];
    
    for (const method of augmentationMethods) {
      const methodElement = dialog.getByText(method, { exact: true }).first();
      if (await methodElement.isVisible().catch(() => false)) {
        await methodElement.click();
        await page.waitForTimeout(300);
      }
    }
    
    // Wait for all state updates
    await page.waitForTimeout(1000);
    
    // Check for infinite loop error
    const hasInfiniteLoopError = consoleErrors.some(error => 
      error.includes('Maximum update depth exceeded')
    ) || pageErrors.some(error => 
      error.message.includes('Maximum update depth exceeded')
    );
    
    expect(hasInfiniteLoopError).toBe(false);
    
    // Verify the modal is still responsive
    await expect(page.getByRole('dialog')).toBeVisible();
    
    // Log any errors for debugging
    if (consoleErrors.length > 0) {
      console.log('Console errors:', consoleErrors);
    }
    if (pageErrors.length > 0) {
      console.log('Page errors:', pageErrors.map(e => e.message));
    }
  });
});
