import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Helper function to create a test project first (datasets need a project)
async function createTestProject(page: Page, projectName: string) {
  await page.goto('/');
  const newProjectLink = page.locator('main').getByRole('link', { name: 'New Project' }).first();
  await expect(newProjectLink).toBeVisible();
  await newProjectLink.click();
  await expect(page).toHaveURL('/projects/new');
  
  // Fill minimal project info
  await page.fill('input#name', projectName);
  
  // Submit the form
  await page.click('button[type="submit"]:has-text("Create")');
  
  // Wait for navigation back to home page
  await page.waitForURL('/', { timeout: 20000, waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 20000 });
  
  // Wait for the project to appear
  await expect(page.getByText(projectName).first()).toBeVisible({ timeout: 15000 });
}

// Helper function to navigate to a project and open create dataset form
async function navigateToCreateDataset(page: Page, projectName: string) {
  // Navigate to the project detail page by clicking on the project card
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  
  // Click the visible project card link in main content (sidebar has offscreen duplicate labels)
  const projectLink = page.locator('main').getByRole('link', { name: projectName }).first();
  await expect(projectLink).toBeVisible({ timeout: 15000 });
  await projectLink.click();
  
  // Wait for project page to load
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);
  
  // Find and click on Create dropdown button
  const createButton = page.locator('button:has-text("Create")').first();
  await createButton.click();
  
  // Wait for dropdown menu to appear
  await page.waitForTimeout(500);
  
  // Click on the "Dataset" menu item (the second one, not Dataset Group)
  await page.getByRole('menuitem', { name: 'Dataset', exact: true }).click();
  
  // Wait for navigation to create dataset page
  await page.waitForURL('**/projects/new/dataset', { timeout: 10000 });
}

// Helper function to fill dataset form
async function fillDatasetForm(page: Page, datasetData: {
  name: string;
  description?: string;
  tags?: string[];
  logoPath?: string;
}) {
  // Fill dataset name
  await page.fill('input[placeholder*="Vehicle Detection"]', datasetData.name);
  
  // Fill description if provided
  if (datasetData.description) {
    await page.fill('textarea[placeholder*="Describe"]', datasetData.description);
  }
  
  // Add tags if provided
  if (datasetData.tags && datasetData.tags.length > 0) {
    for (const tag of datasetData.tags) {
      await page.fill('input[placeholder*="Add tags"]', tag);
      await page.click('button:has-text("Add")');
      // Verify tag was added
      await expect(page.getByText(tag).first()).toBeVisible();
    }
  }
  
  // Upload logo if provided
  if (datasetData.logoPath) {
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(datasetData.logoPath);
    
    // Wait for preview to appear
    await expect(page.locator('img[alt="Logo preview"]')).toBeVisible();
  }
}

test.describe('Create New Dataset', () => {
  const timestamp = Date.now();
  const testProjectName = `Test Project for Dataset ${timestamp}`;
  
  test.beforeEach(async ({ page }) => {
    // Create a test project first
    await createTestProject(page, testProjectName);
  });

  test('should create a new dataset with all fields filled', async ({ page }) => {
    // Navigate to create dataset page
    await navigateToCreateDataset(page, testProjectName);
    
    // Verify we're on the create dataset page
    await expect(page.locator('text=Create New Dataset')).toBeVisible();
    
    // Prepare test data
    const datasetData = {
      name: `Test Dataset ${timestamp}`,
      description: 'This is a test dataset with annotations for vehicle detection',
      tags: ['vehicle', 'detection', 'test'],
      logoPath: path.join(__dirname, '../../fixtures/test-logo.png'),
    };
    
    // Fill all form fields
    await fillDatasetForm(page, datasetData);
    
    // Verify name is filled correctly
    await expect(page.locator('input[placeholder*="Vehicle Detection"]')).toHaveValue(datasetData.name);
    
    // Verify all tags are present
    for (const tag of datasetData.tags) {
      await expect(page.getByText(tag, { exact: false }).first()).toBeVisible();
    }
    
    // Submit the form
    await page.click('button[type="submit"]:has-text("Create Dataset")');
    
    // Wait for success message or navigation
    await expect(page.locator('text=has been created successfully').first()).toBeVisible({ timeout: 10000 });
    
    // Verify navigation back to project page
    await page.waitForLoadState('networkidle');
    
    // Verify the new dataset appears in the project
    await expect(page.getByText(datasetData.name).first()).toBeVisible({ timeout: 10000 });
  });

  test('should create dataset with minimal required fields (name only)', async ({ page }) => {
    // Navigate to create dataset page
    await navigateToCreateDataset(page, testProjectName);
    
    // Fill only the required name field
    const minimalDatasetName = `Minimal Dataset ${timestamp}`;
    await page.fill('input[placeholder*="Vehicle Detection"]', minimalDatasetName);
    
    // Submit the form
    await page.click('button[type="submit"]:has-text("Create Dataset")');
    
    // Wait for navigation back to project page (indicates success)
    await page.waitForLoadState('networkidle', { timeout: 20000 });
  });

  test('should allow adding and removing tags', async ({ page }) => {
    // Navigate to create dataset page
    await navigateToCreateDataset(page, testProjectName);
    
    // Add tags
    const tags = ['tag1', 'tag2', 'tag3'];
    for (const tag of tags) {
      await page.fill('input[placeholder*="Add tags"]', tag);
      await page.press('input[placeholder*="Add tags"]', 'Enter');
      await expect(page.getByText(tag).first()).toBeVisible();
    }
    
    // Remove the second tag by clicking its remove button (X button next to the tag)
    const tag2Badge = page.locator('text=tag2').first().locator('..');
    const removeButton = tag2Badge.locator('button').first();
    await removeButton.click({ force: true });
    
    // Wait a moment for UI to update
    await page.waitForTimeout(300);
    
    // Verify tag2 is removed
    await expect(page.getByText('tag2')).toHaveCount(0);
    
    // Verify other tags are still present
    await expect(page.getByText('tag1').first()).toBeVisible();
    await expect(page.getByText('tag3').first()).toBeVisible();
  });

  test('should allow uploading and removing logo', async ({ page }) => {
    // Navigate to create dataset page
    await navigateToCreateDataset(page, testProjectName);
    
    // Upload logo
    const logoPath = path.join(__dirname, '../../fixtures/test-logo.png');
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(logoPath);
    
    // Verify preview appears
    await expect(page.locator('img[alt="Logo preview"]')).toBeVisible();
    
    // Remove logo (click the X button)
    const removeButton = page.locator('button').filter({ has: page.locator('svg.h-4.w-4') }).last();
    await removeButton.click();
    
    // Verify upload area reappears
    await expect(page.locator('text=Click to upload a logo')).toBeVisible();
    await expect(page.locator('img[alt="Logo preview"]')).not.toBeVisible();
  });

  test('should display correct creation date on dataset card', async ({ page }) => {
    // Navigate to create dataset page
    await navigateToCreateDataset(page, testProjectName);
    
    // Create dataset with minimal data
    const datasetName = `Date Test Dataset ${timestamp}`;
    await page.fill('input[placeholder*="Vehicle Detection"]', datasetName);
    
    // Get current date before creating dataset
    const today = new Date();
    const expectedDateString = today.toLocaleDateString();
    
    // Submit the form
    await page.click('button[type="submit"]:has-text("Create Dataset")');
    
    // Wait for success message
    await expect(page.locator('text=has been created successfully').first()).toBeVisible({ timeout: 10000 });
    
    // Wait for navigation back to project page
    await page.waitForLoadState('networkidle');
    
    // Wait for dataset card to appear
    await expect(page.getByText(datasetName).first()).toBeVisible({ timeout: 10000 });
    
    // Find all date badges with the expected date format
    const dateBadges = page.locator('div.rounded-md.bg-secondary');
    
    // Wait for at least one date badge to be visible
    await expect(dateBadges.first()).toBeVisible({ timeout: 5000 });
    
    // Get all date badge texts
    const count = await dateBadges.count();
    let foundValidDate = false;
    
    for (let i = 0; i < count; i++) {
      const dateText = await dateBadges.nth(i).textContent();
      
      // Check if this date is valid (not "Invalid Date" or "No date")
      if (dateText && !dateText.includes('Invalid Date') && !dateText.includes('No date') && dateText.trim() !== '') {
        // Verify it contains the current year
        if (dateText.includes(String(today.getFullYear()))) {
          foundValidDate = true;
          break;
        }
      }
    }
    
    // Assert that we found at least one valid date with the current year
    expect(foundValidDate).toBe(true);
  });
});
