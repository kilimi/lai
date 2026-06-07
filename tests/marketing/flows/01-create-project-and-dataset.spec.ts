import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { caption, installCaptionOverlay, installCursor, mockTraining, shot, step } from '../helpers';

/**
 * Marketing flow:
 *   Home → Create Project → Create Dataset → Upload a small drone dataset.
 *
 * The drone images live in tests/fixtures/drone-dataset/ and are downloaded
 * on demand by tests/marketing/global-setup.ts (cached after first run).
 *
 * Each meaningful step is captioned and screenshotted so the resulting
 * video doubles as a narrated walkthrough.
 */

const PROJECT_NAME = `Drone Crop Survey ${Date.now()}`;
const DATASET_NAME = 'Field Survey 2025-05';
const DRONE_DIR = path.join(process.cwd(), 'tests', 'fixtures', 'drone-dataset');

function listDroneImages(): string[] {
  if (!fs.existsSync(DRONE_DIR)) return [];
  return fs
    .readdirSync(DRONE_DIR)
    .filter((f) => /\.(jpe?g|png)$/i.test(f))
    .map((f) => path.join(DRONE_DIR, f))
    .sort();
}

test.describe('Marketing tour', () => {
  test.beforeEach(async ({ page }) => {
    await installCursor(page);
    await installCaptionOverlay(page);
    await mockTraining(page);
  });

  test('Create project and dataset', async ({ page }, testInfo) => {
    // ── 1. Home ───────────────────────────────────────────────────────────
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await step(
      page,
      testInfo,
      'home',
      'Welcome to LAI — let’s build a computer-vision project from scratch.',
    );

    // ── 2. Open "New Project" ─────────────────────────────────────────────
    // The home page only surfaces a "New project" link in the empty-state
    // onboarding card or the auto-hide sidebar. To keep the tour robust
    // whether or not other projects already exist, navigate directly.
    await caption(page, 'Start by creating a new project from the home screen.');
    await page.goto('/projects/new');
    await expect(page).toHaveURL(/\/projects\/new$/);
    await page.waitForLoadState('networkidle');
    await step(
      page,
      testInfo,
      'create-project-empty',
      'Give your project a name, description, and a few tags.',
    );

    // ── 3. Fill project form ──────────────────────────────────────────────
    await page.fill('input#name', PROJECT_NAME);
    await page.fill(
      'textarea#description',
      'Detect pest damage in field crops from drone imagery.',
    );
    for (const tag of ['drone', 'agriculture', 'detection']) {
      await page.fill('input[placeholder*="Add tags"]', tag);
      await page.press('input[placeholder*="Add tags"]', 'Enter');
    }

    // Use the first drone image as the project logo so the card has a face.
    const droneImages = listDroneImages();
    if (droneImages.length > 0) {
      const logoInput = page.locator('input#project-logo');
      if (await logoInput.count()) {
        await logoInput.setInputFiles(droneImages[0]);
        await expect(page.locator('img[alt="Logo preview"]')).toBeVisible({ timeout: 5_000 });
      }
    }

    await step(
      page,
      testInfo,
      'create-project-filled',
      `Project: “${PROJECT_NAME}” — tagged and with a cover image.`,
    );

    // ── 4. Submit project ─────────────────────────────────────────────────
    await caption(page, 'Click Create to spin up the project.');
    await page.click('button[type="submit"]:has-text("Create")');
    await page.waitForURL('/', { timeout: 20_000, waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(PROJECT_NAME).first()).toBeVisible({ timeout: 15_000 });
    await step(
      page,
      testInfo,
      'project-created-home',
      'Project created — it now appears on your home dashboard.',
    );

    // ── 5. Open the project ───────────────────────────────────────────────
    const projectCard = page.locator('main').getByText(PROJECT_NAME, { exact: false }).first();
    await projectCard.waitFor({ state: 'visible', timeout: 20_000 });
    await projectCard.click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(800);
    await step(
      page,
      testInfo,
      'project-page',
      'Inside the project — datasets, models and exports all live here.',
    );

    // ── 6. Open "Create → Dataset" dropdown ───────────────────────────────
    await caption(page, 'Now add a dataset to hold your drone imagery.');
    const createButton = page.locator('button:has-text("Create")').first();
    await createButton.click();
    await page.waitForTimeout(400);
    await shot(page, testInfo, 'create-dropdown-open');
    await page.getByRole('menuitem', { name: 'Dataset', exact: true }).click();
    await page.waitForURL('**/projects/**/dataset', { timeout: 10_000 });
    await page.waitForLoadState('networkidle');
    await step(
      page,
      testInfo,
      'create-dataset-empty',
      'Datasets bundle your images and annotations into one workspace.',
    );

    // ── 7. Fill dataset form ──────────────────────────────────────────────
    await page.fill('input[placeholder*="Vehicle Detection"]', DATASET_NAME);
    const datasetDesc = page.locator('textarea[placeholder*="Describe"]').first();
    if (await datasetDesc.isVisible().catch(() => false)) {
      await datasetDesc.fill('May 2025 drone survey — six aerial frames over crop fields.');
    }

    // Attach a cover image to the dataset (uses one of the drone frames).
    // The CreateDataset form has a single file input (the dataset logo).
    const droneImagesForDataset = listDroneImages();
    if (droneImagesForDataset.length > 0) {
      const datasetLogoInput = page.locator('input[type="file"][accept*="image"]').first();
      if (await datasetLogoInput.count()) {
        await datasetLogoInput.setInputFiles(droneImagesForDataset[1] ?? droneImagesForDataset[0]);
        await expect(page.locator('img[alt="Logo preview"]')).toBeVisible({ timeout: 5_000 });
      }
    }

    await step(
      page,
      testInfo,
      'create-dataset-filled',
      `Dataset: “${DATASET_NAME}” — named, described, and with a cover image.`,
    );

    // ── 8. Submit dataset ─────────────────────────────────────────────────
    await caption(page, 'Create the dataset to get an upload workspace.');
    await page.click('button[type="submit"]:has-text("Create Dataset")');
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(DATASET_NAME).first()).toBeVisible({ timeout: 15_000 });
    await step(
      page,
      testInfo,
      'dataset-created',
      'Dataset ready — next we need an image collection to hold the frames.',
    );

    // ── 9. Open the dataset ───────────────────────────────────────────────
    const datasetCard = page.locator('main').getByText(DATASET_NAME, { exact: false }).first();
    await datasetCard.waitFor({ state: 'visible', timeout: 20_000 });
    await datasetCard.click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(800);
    await step(
      page,
      testInfo,
      'dataset-page-empty',
      'A fresh dataset has no image collections yet — let’s add one.',
    );

    // ── 10. Create an image collection ────────────────────────────────────
    // Image collections are sub-groups within a dataset (e.g. "RGB", "Depth",
    // "Masks"). A dataset can hold many of them, and each one can be uploaded
    // to and exported independently.
    await caption(
      page,
      'Image collections group related frames inside a dataset — RGB, depth, masks. A dataset can have many.',
    );
    const addCollectionBtn = page
      .getByRole('button', { name: /create image layer|add collection/i })
      .first();
    await expect(addCollectionBtn).toBeVisible({ timeout: 20_000 });
    await addCollectionBtn.click();

    const collectionNameInput = page.locator('input#tab-name');
    await expect(collectionNameInput).toBeVisible({ timeout: 10_000 });
    await collectionNameInput.fill('RGB Frames');
    await step(
      page,
      testInfo,
      'add-collection-dialog',
      'Name the collection — e.g. “RGB Frames”. You can add more later for depth, masks, etc.',
    );
    await page.getByRole('button', { name: /add tab/i }).click();
    await expect(collectionNameInput).toBeHidden({ timeout: 10_000 });
    await page.waitForTimeout(800);
    await step(
      page,
      testInfo,
      'collection-created',
      'Collection “RGB Frames” is ready — now we can upload images into it.',
    );

    // ── 11. Open the Upload menu → Upload Images ──────────────────────────
    await caption(page, 'Open the Upload menu to add images or extract frames from a video.');
    const uploadButton = page.getByRole('button', { name: /^upload$/i }).first();
    await expect(uploadButton).toBeVisible({ timeout: 10_000 });
    await uploadButton.click();
    await page.waitForTimeout(300);
    await shot(page, testInfo, 'upload-menu-open');
    await page.getByRole('menuitem', { name: /upload images/i }).click();
    await expect(page.getByRole('heading', { name: /upload images to/i })).toBeVisible({
      timeout: 10_000,
    });
    await step(
      page,
      testInfo,
      'upload-dialog',
      'Pick the image files (or a whole folder) you want to add to this collection.',
    );

    // ── 12. Pick files and upload ─────────────────────────────────────────
    const images = listDroneImages();
    if (images.length > 0) {
      // The upload dialog renders two hidden file inputs (files + folder).
      // The first one is the plain "Select Files" input.
      const dialogFileInput = page.locator('input[type="file"]:not([webkitdirectory])').last();
      await dialogFileInput.setInputFiles(images);
      await page.waitForTimeout(600);
      await step(
        page,
        testInfo,
        'files-selected',
        `${images.length} aerial drone images queued — review then upload.`,
      );

      await caption(page, 'Start the upload — it runs in chunks in the background.');
      await page.getByRole('button', { name: new RegExp(`upload ${images.length} images`, 'i') }).click();
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(2500); // let thumbnails render
      await step(
        page,
        testInfo,
        'images-uploaded',
        `${images.length} drone images now live in the “RGB Frames” collection.`,
      );
    } else {
      await caption(page, 'No sample images found — skipping upload step.');
      await page.waitForTimeout(800);
    }

    // ── 13. Outro ─────────────────────────────────────────────────────────
    await caption(page, 'Next up: annotate, train, and evaluate. ✨');
    await page.waitForTimeout(1800);

    await expect(page).toHaveURL(/.*/);
  });
});
