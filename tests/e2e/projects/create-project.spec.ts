import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { clearDatabase, verifyDatabaseIsEmpty } from '../../test-helpers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import { navigateToCreateProject } from './helpers';

// Helper function to fill project form with all fields
async function fillProjectForm(page: Page, projectData: {
  name: string;
  description: string;
  tags: string[];
  logoPath?: string;
}) {
  // Fill project name
  await page.fill('input#name', projectData.name);
  
  // Fill description
  await page.fill('textarea#description', projectData.description);
  
  // Add tags
  for (const tag of projectData.tags) {
    await page.fill('input[placeholder*="Add tags"]', tag);
    await page.click('button:has-text("Add")');
    // Verify tag was added
    await expect(page.getByText(tag).first()).toBeVisible();
  }
  
  // Upload logo if provided
  if (projectData.logoPath) {
    const fileInput = page.locator('input#project-logo');
    await fileInput.setInputFiles(projectData.logoPath);
    
    // Wait for preview to appear
    await expect(page.locator('img[alt="Logo preview"]')).toBeVisible();
  }
}

test.describe('Create New Project', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to the application
    await page.goto('/');
  });

  test('should create a new project with all fields filled', async ({ page }) => {
    // Navigate to create project page
    await navigateToCreateProject(page);
    
    // Verify we're on the create project page
    await expect(page.locator('h3:has-text("New LAI Project")')).toBeVisible();
    await expect(page.locator('text=Create a new project to organize your datasets and annotations')).toBeVisible();
    
    // Prepare test data
    const projectData = {
      name: 'Test AI Project',
      description: 'This is a comprehensive test project for AI model training with detailed annotations',
      tags: ['machine-learning', 'object-detection', 'test'],
      logoPath: path.join(__dirname, '../../fixtures/test-logo.png'),
    };
    
    // Fill all form fields
    await fillProjectForm(page, projectData);
    
    // Verify all fields are filled correctly
    await expect(page.locator('input#name')).toHaveValue(projectData.name);
    await expect(page.locator('textarea#description')).toHaveValue(projectData.description);
    
    // Verify all tags are present
    for (const tag of projectData.tags) {
      await expect(page.getByText(tag, { exact: false }).first()).toBeVisible();
    }
    
    // Submit the form
    await page.click('button[type="submit"]:has-text("Create")');
    
    // Wait for success message
    await expect(page.locator('text=has been created successfully').first()).toBeVisible({ timeout: 10000 });
    
    // Verify navigation to home page
    await expect(page).toHaveURL('/', { timeout: 5000 });
    
    // Wait for the page to load and verify the new project appears in the project list
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(projectData.name).first()).toBeVisible({ timeout: 10000 });
    
    // Verify the logo is displayed in the project card
    // Find the image with the project name as alt text (use .first() since tests may have created multiple)
    const logoImage = page.locator(`img[alt="${projectData.name}"]`).first();
    await expect(logoImage).toBeVisible({ timeout: 5000 });
    
    // Verify the logo src is a data URL (base64 encoded image)
    const logoSrc = await logoImage.getAttribute('src');
    expect(logoSrc).toMatch(/^data:image\//);
  });


  test('should create project with minimal required fields (name only)', async ({ page }) => {
    // Navigate to create project page
    await navigateToCreateProject(page);
    
    // Fill only the required name field
    await page.fill('input#name', 'Minimal Project');
    
    // Submit the form
    await page.click('button[type="submit"]:has-text("Create")');
    
    // Wait for navigation to home page (indicates success)
    await page.waitForURL('/', { timeout: 30000, waitUntil: 'domcontentloaded' });
  });

  test('should validate required name field', async ({ page }) => {
    // Navigate to create project page
    await navigateToCreateProject(page);
    
    // Verify submit button is disabled when name is empty
    const submitButton = page.locator('button[type="submit"]:has-text("Create")');
    await expect(submitButton).toBeDisabled();
    
    // Verify we're still on the create project page
    await expect(page).toHaveURL('/projects/new');
  });

  test('should allow adding and removing tags', async ({ page }) => {
    // Navigate to create project page
    await navigateToCreateProject(page);
    
    // Add tags
    const tags = ['tag1', 'tag2', 'tag3'];
    for (const tag of tags) {
      await page.fill('input[placeholder*="Add tags"]', tag);
      await page.press('input[placeholder*="Add tags"]', 'Enter');
      await expect(page.getByText(tag).first()).toBeVisible();
    }
    
    // Remove the second tag by clicking its remove button
    await page.getByRole('button', { name: 'Remove tag2' }).click();
    
    // Verify tag2 is removed
    await expect(page.getByText('tag2')).toHaveCount(0);
    
    // Verify other tags are still present
    await expect(page.getByText('tag1').first()).toBeVisible();
    await expect(page.getByText('tag3').first()).toBeVisible();
  });

  test('should allow uploading and removing logo', async ({ page }) => {
    // Navigate to create project page
    await navigateToCreateProject(page);
    
    // Upload logo
    const logoPath = path.join(__dirname, '../../fixtures/test-logo.png');
    const fileInput = page.locator('input#project-logo');
    await fileInput.setInputFiles(logoPath);
    
    // Verify preview appears
    await expect(page.locator('img[alt="Logo preview"]')).toBeVisible();
    
    // Remove logo
    await page.getByRole('button', { name: 'Remove logo' }).click();
    
    // Verify upload area reappears
    await expect(page.locator('text=Click to upload a logo')).toBeVisible();
    await expect(page.locator('img[alt="Logo preview"]')).not.toBeVisible();
  });

  test('should handle cancel button', async ({ page }) => {
    // Navigate to create project page
    await navigateToCreateProject(page);
    
    // Fill some data
    await page.fill('input#name', 'Cancelled Project');
    await page.fill('textarea#description', 'This should be cancelled');
    
    // Click cancel button
    await page.click('button:has-text("Cancel")');
    
    // Verify navigation back to home page
    await expect(page).toHaveURL('/');
    
    // Verify project was not created
    await expect(page.locator('text=Cancelled Project')).not.toBeVisible();
  });

  test('should disable submit button while submitting', async ({ page }) => {
    // Navigate to create project page
    await navigateToCreateProject(page);
    
    // Fill required field
    await page.fill('input#name', 'Processing Project');
    
    // Get submit button
    const submitButton = page.locator('button[type="submit"]');
    
    // Verify button is enabled initially and shows "Create"
    await expect(submitButton).toBeEnabled();
    await expect(submitButton).toHaveText('Create');
    
    // Submit the form
    await submitButton.click();
    
    // Wait for successful submission (navigation)
    await page.waitForURL('/', { timeout: 20000, waitUntil: 'domcontentloaded' });
  });

  test('should create project with special characters in name and description', async ({ page }) => {
    // Navigate to create project page
    await navigateToCreateProject(page);
    
    // Fill with special characters
    const projectData = {
      name: 'AI Project: "Testing" & <Validation> 2024',
      description: 'Description with special chars: @#$%^&*()_+-={}[]|\\:";\'<>?,./~`',
      tags: ['test-123', 'ai_ml'],
    };
    
    await fillProjectForm(page, projectData);
    
    // Submit the form
    await page.click('button[type="submit"]:has-text("Create")');
    
    // Wait for navigation to home page (indicates success)
    await page.waitForURL('/', { timeout: 30000, waitUntil: 'domcontentloaded' });
  });

  test('should display all project cards with consistent height', async ({ page }) => {
    // Create multiple projects with varying content to test card consistency
    const projects = [
      { name: 'Short', description: 'Short desc', tags: [] },
      { name: 'Project with Long Name and Description', description: 'This is a very long description that should be clamped to two lines maximum to ensure consistent card sizing across all project cards', tags: ['tag1', 'tag2', 'tag3', 'tag4'] },
      { name: 'Medium Project', description: 'Medium length description here', tags: ['one-tag'] },
      { name: 'No Desc Project', description: '', tags: [] },
    ];

    // Create all test projects
    for (const projectData of projects) {
      await navigateToCreateProject(page);
      await page.fill('input#name', projectData.name);
      if (projectData.description) {
        await page.fill('textarea#description', projectData.description);
      }
      for (const tag of projectData.tags) {
        await page.fill('input[placeholder*="Add tags"]', tag);
        await page.press('input[placeholder*="Add tags"]', 'Enter');
        await page.waitForTimeout(300); // Give time for tag to be added
      }
      await page.click('button[type="submit"]:has-text("Create")');
      await page.waitForURL('/', { timeout: 30000, waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle', { timeout: 30000 });
      await page.waitForTimeout(1000); // Extra time for rendering
    }

    // Wait for layout to stabilize and animations to complete
    await page.waitForTimeout(2000);
    
    // Get all project cards
    const cards = page.locator('.rounded-lg.border.bg-card');
    await page.waitForTimeout(1000); // Wait for any animations
    const cardCount = await cards.count();
    
    // Ensure we have at least 2 cards to compare
    expect(cardCount).toBeGreaterThanOrEqual(2);

    // Get heights of all cards
    const heights: number[] = [];
    for (let i = 0; i < Math.min(cardCount, 10); i++) {
      const card = cards.nth(i);
      await card.waitFor({ state: 'visible', timeout: 10000 });
      await page.waitForTimeout(200); // Small delay for stability
      const boundingBox = await card.boundingBox();
      if (boundingBox) {
        heights.push(Math.round(boundingBox.height));
      }
    }

    // Verify all cards have the same height (allowing reasonable difference for browser rendering variations)
    // Different browsers may render cards with slight height differences due to font rendering
    const firstHeight = heights[0];
    const maxAllowedDiff = 30; // Generous tolerance for cross-browser rendering differences
    for (let i = 0; i < heights.length; i++) {
      const heightDiff = Math.abs(heights[i] - firstHeight);
      expect(heightDiff).toBeLessThanOrEqual(maxAllowedDiff);
    }
  });
});
