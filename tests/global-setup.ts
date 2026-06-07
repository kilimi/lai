import { chromium, FullConfig } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';

const apiUrl = () => process.env.TEST_API_URL || 'http://localhost:9999';
const SEED_FILE = path.join(process.cwd(), 'tests', '.seed-segmentation.json');

/**
 * Global setup - runs once before all tests.
 * Clears the test database, then creates a seed project + dataset + image
 * for the segmentation e2e spec so it does not need to create them (avoids 404 race).
 */
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
    console.log('🧹 Clearing test database before running tests...');
    const clearRes = await page.request.delete(`${base}/database/clear`, { timeout: 120_000 });
    if (clearRes.ok()) {
      const data = await clearRes.json();
      console.log('✅ Test database cleared successfully');
      console.log(`   - Records deleted: ${data.total_records_deleted}`);
      console.log(`   - Files removed: ${data.files_removed}`);
    } else {
      console.warn('⚠️  Failed to clear test database:', clearRes.status());
    }

    console.log('🌱 Creating seed dataset for segmentation e2e...');
    const projectRes = await page.request.post(`${base}/projects/`, {
      multipart: { name: 'E2E Segmentation Project', description: '', tags: '[]' },
    });
    if (!projectRes.ok()) {
      console.warn('⚠️  Failed to create seed project:', projectRes.status());
      return;
    }
    const projectBody = await projectRes.json();
    const projectId = projectBody?.data?.id ?? projectBody?.id;
    if (!projectId) {
      console.warn('⚠️  Seed project response missing id');
      return;
    }

    const datasetRes = await page.request.post(`${base}/datasets/`, {
      multipart: {
        name: 'E2E Segmentation Dataset',
        description: '',
        project_id: String(projectId),
        tags: '[]',
      },
    });
    if (!datasetRes.ok()) {
      console.warn('⚠️  Failed to create seed dataset:', datasetRes.status());
      return;
    }
    const datasetBody = await datasetRes.json();
    const datasetId = datasetBody?.id ?? datasetBody?.data?.id;
    if (datasetId == null) {
      console.warn('⚠️  Seed dataset response missing id');
      return;
    }

    // Wait for dataset to be visible to avoid 404 on upload (commit visibility)
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const getRes = await page.request.get(`${base}/datasets/${datasetId}`);
      if (getRes.ok()) break;
      if (i === 9) {
        console.warn('⚠️  Seed dataset not visible after 5s, upload may fail');
      }
    }

    const fixturePath = path.join(process.cwd(), 'tests', 'fixtures', 'test-logo.png');
    const pngBuffer = fs.existsSync(fixturePath) ? fs.readFileSync(fixturePath) : Buffer.alloc(0);
    if (pngBuffer.length === 0) {
      console.warn('⚠️  tests/fixtures/test-logo.png not found; segmentation spec will create its own data');
      return;
    }
    {
      const uploadRes = await page.request.post(`${base}/datasets/${datasetId}/images`, {
        multipart: {
          files: { name: 'test-image.png', mimeType: 'image/png', buffer: pngBuffer },
        },
      });
      if (!uploadRes.ok()) {
        console.warn('⚠️  Failed to upload seed image:', uploadRes.status(), await uploadRes.text());
        return;
      }
      const uploadBody = await uploadRes.json();
      const images = uploadBody?.images ?? uploadBody?.data?.images ?? [];
      const first = images[0];
      const seed = {
        projectId: Number(projectId),
        datasetId: Number(datasetId),
        imageFileName: first?.fileName ?? first?.file_name ?? 'test-image.png',
        width: first?.width ?? 200,
        height: first?.height ?? 200,
      };
      fs.mkdirSync(path.dirname(SEED_FILE), { recursive: true });
      fs.writeFileSync(SEED_FILE, JSON.stringify(seed, null, 2), 'utf-8');
      console.log('✅ Seed dataset created:', seed.datasetId);
    }
  } catch (error) {
    console.error('❌ Error in global setup:', error);
    console.warn('   Segmentation e2e may create its own data or fail');
  } finally {
    await browser.close();
  }
}

export default globalSetup;
