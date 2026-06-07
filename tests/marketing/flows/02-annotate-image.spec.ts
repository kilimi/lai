import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { caption, installCaptionOverlay, installCursor, mockTraining, shot, step } from '../helpers';

/**
 * Marketing flow:
 *   Project → Dataset → Collection → Upload → Annotate (Segmentation).
 *
 * Demonstrates the manual annotation experience:
 *   - Create a class on the fly
 *   - Draw a polygon around a region
 *   - Switch to the pencil tool for a free-hand outline
 *
 * Setup steps are abbreviated (no captions) so the bulk of the recording
 * is the annotation experience itself.
 */

const PROJECT_NAME = `Aerial Annotation Demo ${Date.now()}`;
const DATASET_NAME = 'Brighton Beach Aerial';
const COLLECTION_NAME = 'RGB Frames';
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

  test('Annotate an image with polygon and pencil', async ({ page }, testInfo) => {
    test.setTimeout(180_000);

    const images = listDroneImages();
    expect(images.length, 'drone fixtures must be downloaded by global-setup').toBeGreaterThan(0);

    // ── Setup: project + dataset + collection + 1 image (quick, no captions) ──
    await page.goto('/projects/new');
    await page.waitForLoadState('networkidle');
    await page.fill('input#name', PROJECT_NAME);
    await page.fill('textarea#description', 'Annotation demo project.');
    await page.click('button[type="submit"]:has-text("Create")');
    await page.waitForURL('/', { timeout: 20_000, waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle');

    await page.locator('main').getByText(PROJECT_NAME, { exact: false }).first().click();
    await page.waitForLoadState('networkidle');

    await page.locator('button:has-text("Create")').first().click();
    await page.getByRole('menuitem', { name: 'Dataset', exact: true }).click();
    await page.waitForURL('**/projects/**/dataset', { timeout: 10_000 });
    await page.fill('input[placeholder*="Vehicle Detection"]', DATASET_NAME);
    await page.click('button[type="submit"]:has-text("Create Dataset")');
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(DATASET_NAME).first()).toBeVisible({ timeout: 15_000 });

    await page.locator('main').getByText(DATASET_NAME, { exact: false }).first().click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    // Create a collection (empty state shows "Create image layer";
    // once at least one exists the button becomes "Add Collection").
    const addCollectionBtn = page
      .getByRole('button', { name: /create image layer|add collection/i })
      .first();
    await expect(addCollectionBtn).toBeVisible({ timeout: 20_000 });
    await addCollectionBtn.click();
    const collectionNameInput = page.locator('input#tab-name');
    await expect(collectionNameInput).toBeVisible({ timeout: 10_000 });
    await collectionNameInput.fill(COLLECTION_NAME);
    await page.getByRole('button', { name: /add tab/i }).click();
    await expect(collectionNameInput).toBeHidden({ timeout: 10_000 });
    await page.waitForTimeout(500);

    // Upload a couple of images
    await page.getByRole('button', { name: /^upload$/i }).first().click();
    await page.waitForTimeout(200);
    await page.getByRole('menuitem', { name: /upload images/i }).click();
    await expect(page.getByRole('heading', { name: /upload images to/i })).toBeVisible({
      timeout: 10_000,
    });
    const uploadFiles = images.slice(0, 3);
    await page.locator('input[type="file"]:not([webkitdirectory])').last().setInputFiles(uploadFiles);
    await page.waitForTimeout(400);
    await page
      .getByRole('button', { name: new RegExp(`upload ${uploadFiles.length} images`, 'i') })
      .click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2500);

    // ── 1. Launch annotation ──────────────────────────────────────────────
    await step(
      page,
      testInfo,
      'dataset-ready',
      'Images uploaded — time to annotate. Open the segmentation workspace.',
    );

    const annotateBtn = page.getByRole('button', { name: /^annotate$/i }).first();
    const annotateLink = page.getByRole('link', { name: /^annotate$/i }).first();
    if (await annotateBtn.count()) {
      await annotateBtn.click();
    } else {
      await annotateLink.click();
    }
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    // If we land on the choice page, pick Segmentation
    const segLink = page.getByRole('link', { name: /start segmentation/i });
    if (await segLink.count()) {
      await step(
        page,
        testInfo,
        'annotation-choice',
        'Classification labels whole images — Segmentation outlines objects pixel by pixel.',
      );
      await segLink.first().click();
    }
    await page.waitForURL(/\/annotate\/segmentation/, { timeout: 15_000 });
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);

    // Wait for canvas to be ready
    const canvas = page.locator('canvas').first();
    await expect(canvas).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(1500); // image bitmap settles
    await step(
      page,
      testInfo,
      'annotation-workspace',
      'The annotation workspace — image canvas in the centre, tools on the right, classes on the left.',
    );

    // ── 2. Create a class ─────────────────────────────────────────────────
    await caption(page, 'First, define a class so every shape you draw gets a label.');
    await page.getByRole('button', { name: /add new class/i }).click();
    const classInput = page.locator('input[placeholder="Class name"]');
    await expect(classInput).toBeVisible({ timeout: 5_000 });
    await classInput.fill('Building');
    await step(
      page,
      testInfo,
      'class-name-typed',
      'Name the class — e.g. “Building”. Each class gets its own colour automatically.',
    );
    await classInput.press('Enter');
    await page.waitForTimeout(600);
    await step(
      page,
      testInfo,
      'class-created',
      'Class “Building” is ready and selected — anything drawn next belongs to it.',
    );

    // ── 3. Draw a polygon ─────────────────────────────────────────────────
    await caption(page, 'Pick the Polygon tool to click point-by-point around an object.');
    await page.getByRole('button', { name: /^polygon/i }).first().click();
    await page.waitForTimeout(300);
    await shot(page, testInfo, 'polygon-tool-active');

    const box = await canvas.boundingBox();
    if (!box) throw new Error('Canvas has no bounding box');

    // Build a roughly hexagonal polygon roughly centred on the canvas.
    const cx = box.x + box.width * 0.5;
    const cy = box.y + box.height * 0.55;
    const rx = Math.min(box.width, box.height) * 0.18;
    const ry = rx * 0.85;
    const points: Array<[number, number]> = [
      [cx - rx, cy - ry * 0.4],
      [cx - rx * 0.5, cy - ry],
      [cx + rx * 0.5, cy - ry * 0.95],
      [cx + rx, cy + ry * 0.1],
      [cx + rx * 0.6, cy + ry],
      [cx - rx * 0.4, cy + ry * 0.95],
    ];

    await caption(page, 'Click around the object to drop polygon vertices — one by one.');
    for (let i = 0; i < points.length; i++) {
      const [x, y] = points[i];
      await page.mouse.move(x, y, { steps: 10 });
      await page.waitForTimeout(150);
      await page.mouse.click(x, y);
      await page.waitForTimeout(350);
    }
    await shot(page, testInfo, 'polygon-points-placed');

    await caption(page, 'Double-click to close the polygon and commit the shape.');
    const [fx, fy] = points[0];
    await page.mouse.move(fx, fy, { steps: 8 });
    await page.mouse.dblclick(fx, fy);
    await page.waitForTimeout(800);
    await step(
      page,
      testInfo,
      'polygon-committed',
      'Polygon saved — it shows up coloured and tagged with the “Building” label.',
    );

    // ── 4. Second class + pencil free-hand ────────────────────────────────
    await caption(page, 'Add a second class for a different kind of region.');
    await page.getByRole('button', { name: /add new class/i }).click();
    await expect(classInput).toBeVisible({ timeout: 5_000 });
    await classInput.fill('Vegetation');
    await classInput.press('Enter');
    await page.waitForTimeout(500);
    await step(
      page,
      testInfo,
      'second-class-created',
      'Second class “Vegetation” — selected and ready to draw.',
    );

    await caption(page, 'Switch to the Pencil tool for fast, free-hand outlines.');
    await page.getByRole('button', { name: /^pencil/i }).first().click();
    await page.waitForTimeout(300);
    await shot(page, testInfo, 'pencil-tool-active');

    // Free-hand drag: sweep along a wavy path on the lower half of the image.
    const sx = box.x + box.width * 0.22;
    const sy = box.y + box.height * 0.78;
    const segments = 30;
    const length = box.width * 0.55;
    const amplitude = box.height * 0.05;

    await caption(page, 'Click and drag to trace the edge — release to close the shape.');
    await page.mouse.move(sx, sy, { steps: 8 });
    await page.mouse.down();
    for (let i = 1; i <= segments; i++) {
      const t = i / segments;
      const x = sx + length * t;
      const y = sy + Math.sin(t * Math.PI * 2) * amplitude - amplitude * 0.6 * t;
      await page.mouse.move(x, y, { steps: 4 });
      await page.waitForTimeout(40);
    }
    // Close the loop back toward the start so the area looks like a shape.
    const back = 10;
    for (let i = 1; i <= back; i++) {
      const t = i / back;
      const x = sx + length * (1 - t);
      const y = sy + amplitude * 1.2 + (1 - t) * amplitude * 0.4;
      await page.mouse.move(x, y, { steps: 4 });
      await page.waitForTimeout(40);
    }
    await page.mouse.up();
    await page.waitForTimeout(800);
    await step(
      page,
      testInfo,
      'pencil-stroke-committed',
      'Free-hand stroke captured as a polygon — labelled “Vegetation”.',
    );

    // ── 5. Outro ──────────────────────────────────────────────────────────
    await caption(page, 'Two shapes, two classes — repeat across your dataset and export. ✨');
    await page.waitForTimeout(1800);

    await expect(page).toHaveURL(/\/annotate\/segmentation/);
  });
});
