import { chromium, FullConfig } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';

/**
 * Marketing global setup:
 *  1. (Optionally) clear a TEST DB so flows start clean.
 *  2. Download a small "drone" sample dataset to tests/fixtures/drone-dataset/
 *     so the marketing tour can upload real-looking aerial imagery.
 *  3. Ensure docs/flows/ exists for screenshots/videos.
 */

const apiUrl = () => process.env.TEST_API_URL || 'http://localhost:9999';

// Public aerial / drone Unsplash photos (stable CDN URLs, free to use).
// Real drone imagery from the public Brighton Beach drone dataset:
//   https://github.com/pierotofy/drone_dataset_brighton_beach
// We fetch the file list from the GitHub Contents API on first run,
// then download a small subset (cached under tests/fixtures/drone-dataset/).
const DRONE_REPO_OWNER = 'pierotofy';
const DRONE_REPO_NAME = 'drone_dataset_brighton_beach';
const DRONE_REPO_PATH = 'images';
const DRONE_MAX_IMAGES = 8; // keep upload time bounded for the marketing tour

export const DRONE_DATASET_DIR = path.join(process.cwd(), 'tests', 'fixtures', 'drone-dataset');

function httpGet(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'lai-marketing-tour', ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }),
        );
      },
    );
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error(`timeout: ${url}`)));
  });
}

function download(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'lai-marketing-tour' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        download(res.headers.location, dest).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
      file.on('error', (err) => fs.unlink(dest, () => reject(err)));
    });
    req.on('error', reject);
    req.setTimeout(60_000, () => req.destroy(new Error(`timeout downloading ${url}`)));
  });
}

async function listDroneRepoImages(): Promise<Array<{ name: string; url: string }>> {
  const api = `https://api.github.com/repos/${DRONE_REPO_OWNER}/${DRONE_REPO_NAME}/contents/${DRONE_REPO_PATH}`;
  const res = await httpGet(api, { Accept: 'application/vnd.github+json' });
  if (res.status !== 200) {
    throw new Error(`GitHub API ${res.status} for ${api}`);
  }
  const entries = JSON.parse(res.body.toString('utf-8')) as Array<{
    name: string;
    download_url: string;
    type: string;
  }>;
  return entries
    .filter((e) => e.type === 'file' && /\.(jpe?g|png)$/i.test(e.name))
    .map((e) => ({ name: e.name, url: e.download_url }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, DRONE_MAX_IMAGES);
}

async function ensureDroneDataset() {
  fs.mkdirSync(DRONE_DATASET_DIR, { recursive: true });

  // Reuse cache if it already has enough images.
  const existing = fs
    .readdirSync(DRONE_DATASET_DIR)
    .filter((f) => /\.(jpe?g|png)$/i.test(f))
    .filter((f) => fs.statSync(path.join(DRONE_DATASET_DIR, f)).size > 10_000);
  if (existing.length >= DRONE_MAX_IMAGES) {
    console.log(`✅ [marketing] cached drone dataset (${existing.length} images)`);
    return;
  }

  let dataset: Array<{ name: string; url: string }> = [];
  try {
    dataset = await listDroneRepoImages();
    console.log(
      `🛰️  [marketing] Brighton Beach drone dataset: ${dataset.length} images selected`,
    );
  } catch (err) {
    console.warn('⚠️  [marketing] failed to list drone repo:', (err as Error).message);
    return;
  }

  for (const item of dataset) {
    const dest = path.join(DRONE_DATASET_DIR, item.name);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 10_000) continue;
    try {
      console.log(`⬇️  [marketing] downloading ${item.name}`);
      await download(item.url, dest);
    } catch (err) {
      console.warn(`⚠️  [marketing] could not download ${item.name}:`, (err as Error).message);
    }
  }
}

async function globalSetup(_config: FullConfig) {
  const customChromiumPath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  const launchOptions =
    customChromiumPath && fs.existsSync(customChromiumPath)
      ? { executablePath: customChromiumPath }
      : undefined;
  const browser = await chromium.launch(launchOptions);
  const page = await browser.newPage();

  try {
    const base = apiUrl();

    // SAFETY: refuse to wipe the dev database. Require an explicit opt-in env var
    // AND a non-default API URL (test backend on a different port).
    const explicitOptIn = process.env.MARKETING_ALLOW_DB_CLEAR === '1';
    const looksLikeDevApi = base.includes('localhost:9999') || base.includes('127.0.0.1:9999');
    if (!explicitOptIn || looksLikeDevApi) {
      console.warn(
        '⛔ [marketing] Skipping DB clear. To wipe, set TEST_API_URL to a test backend ' +
          '(NOT localhost:9999) and MARKETING_ALLOW_DB_CLEAR=1. Current API:', base,
      );
    } else {
      console.log('🧹 [marketing] Clearing database at', base);
      const clearRes = await page.request.delete(`${base}/database/clear`);
      if (!clearRes.ok()) {
        console.warn('⚠️  [marketing] DB clear failed:', clearRes.status());
      } else {
        console.log('✅ [marketing] DB cleared');
      }
    }

    // Download the drone sample dataset (cached).
    await ensureDroneDataset();

    // Make sure output dir exists
    const out = path.join(process.cwd(), 'docs', 'flows');
    fs.mkdirSync(out, { recursive: true });
  } finally {
    await browser.close();
  }
}

export default globalSetup;
