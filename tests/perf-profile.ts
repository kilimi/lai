/**
 * Standalone performance profiling script.
 *
 * Measures real browser timings for each page/route using the Web Performance
 * API (Navigation Timing, Resource Timing, and paint entries).
 *
 * Routes are built dynamically from the live backend database so the script
 * tests real pages that contain actual projects, datasets, images and
 * annotations — not just empty shell pages.
 *
 * Run with:
 *   npx tsx tests/perf-profile.ts
 *   npx tsx tests/perf-profile.ts --url http://localhost:8080
 *   npx tsx tests/perf-profile.ts --api http://localhost:9999
 *   npx tsx tests/perf-profile.ts --runs 3   # average over N runs
 *
 * Does NOT modify the database — read-only.
 */

import { chromium, type Browser, type Page } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { spawn, type ChildProcess } from 'child_process';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const BASE_URL = (() => {
  const idx = process.argv.indexOf('--url');
  return idx !== -1 ? process.argv[idx + 1] : process.env.TEST_WEB_URL ?? 'http://localhost:8080';
})();

const API_URL = (() => {
  const idx = process.argv.indexOf('--api');
  return idx !== -1 ? process.argv[idx + 1] : process.env.TEST_API_URL ?? 'http://localhost:9999';
})();

const RUNS = (() => {
  const idx = process.argv.indexOf('--runs');
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) : 2;
})();

// ---------------------------------------------------------------------------
// Discover real routes from the backend API
// ---------------------------------------------------------------------------
interface Route { name: string; path: string; waitFor?: string; dataContext?: string }

async function discoverRoutes(): Promise<Route[]> {
  const routes: Route[] = [
    // Static pages always included
    { name: 'Home / Projects list', path: '/',             waitFor: 'h1, main' },
    { name: 'New Project form',     path: '/projects/new', waitFor: 'form, h1' },
    { name: 'New Dataset form',     path: '/datasets/new', waitFor: 'form, h1' },
    { name: 'Settings',             path: '/settings',     waitFor: 'h1, form' },
    { name: 'Help',                 path: '/help',         waitFor: 'h1, article' },
  ];

  try {
    // API returns a plain array of projects, each embedding its datasets[]
    const projRes = await fetch(`${API_URL}/projects`, { signal: AbortSignal.timeout(4000) });
    if (!projRes.ok) return routes;
    const projects: any[] = await projRes.json();
    if (!Array.isArray(projects) || projects.length === 0) return routes;

    for (const project of projects.slice(0, 3)) {
      const pid = project.id;
      const pname = (project.name ?? `Project ${pid}`).slice(0, 20);

      routes.push({
        name: `Project datasets (${pname})`,
        path: `/projects/${pid}/datasets`,
        waitFor: 'h1, main',
        dataContext: `${(project.datasets ?? []).length} datasets`,
      });

      const datasets: any[] = project.datasets ?? [];
      for (const ds of datasets.slice(0, 2)) {
        const did = ds.id;
        const dname = (ds.name ?? `Dataset ${did}`).slice(0, 20);
        const imageCount: number = ds.image_count ?? 0;
        const annotCount: number = ds.annotation_count ?? 0;
        const dataCtx = `${imageCount} imgs, ${annotCount} annots`;

        routes.push({
          name: `Dataset view – ${dname}`,
          path: `/datasets/${did}`,
          waitFor: 'h1, main',
          dataContext: dataCtx,
        });

        if (imageCount > 0) {
          routes.push({
            name: `Edit dataset – ${dname}`,
            path: `/datasets/${did}/edit`,
            waitFor: 'img, canvas, main',
            dataContext: dataCtx,
          });
        }
      }
    }
  } catch (e: any) {
    console.warn(`  ⚠  Could not reach backend at ${API_URL}: ${e.message}`);
    console.warn('     Only static routes will be profiled.\n');
  }

  return routes;
}

// ---------------------------------------------------------------------------
// Timing helpers
// ---------------------------------------------------------------------------
interface NavMetrics {
  /** ms from navigationStart to first contentful paint */
  fcp: number | null;
  /** ms from navigationStart to DOMContentLoaded */
  dcl: number;
  /** ms from navigationStart to load event */
  load: number;
  /** ms from navigationStart to largest contentful paint */
  lcp: number | null;
  /** total JS bytes transferred for this navigation */
  jsBytesKB: number;
  /** number of JS requests */
  jsRequests: number;
  /** number of blocking (sync) scripts */
  blockingScripts: number;
}

async function measurePage(page: Page, path: string, waitFor?: string): Promise<NavMetrics> {
  // Capture LCP via PerformanceObserver injected before navigation
  await page.addInitScript(() => {
    (window as any).__lcpValue = null;
    try {
      new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const last = entries[entries.length - 1] as any;
        if (last) (window as any).__lcpValue = last.startTime;
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    } catch { /* LCP not supported */ }
  });

  const t0 = Date.now();
  await page.goto(BASE_URL + path, { waitUntil: 'domcontentloaded' });

  if (waitFor) {
    try {
      await page.waitForSelector(waitFor, { timeout: 8000 });
    } catch { /* element may not exist on empty DB */ }
  }

  // Wait a tick for LCP/FCP to settle
  await page.waitForTimeout(400);

  const metrics: NavMetrics = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    const paintEntries = performance.getEntriesByType('paint');
    const fcp = paintEntries.find(e => e.name === 'first-contentful-paint')?.startTime ?? null;
    const lcp = (window as any).__lcpValue ?? null;

    const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const jsRes = resources.filter(r => r.initiatorType === 'script' || r.name.match(/\.[cm]?js(\?|$)/));
    const jsBytesKB = jsRes.reduce((sum, r) => sum + (r.transferSize ?? 0), 0) / 1024;

    // A "blocking" script is one that started before DCL (heuristic)
    const dcl = nav ? nav.domContentLoadedEventEnd : 0;
    const blocking = jsRes.filter(r => r.responseEnd < dcl).length;

    return {
      fcp: fcp !== undefined ? fcp : null,
      dcl: nav ? Math.round(nav.domContentLoadedEventEnd) : Math.round(Date.now() - performance.timeOrigin),
      load: nav ? Math.round(nav.loadEventEnd) : 0,
      lcp: lcp !== null ? Math.round(lcp) : null,
      jsBytesKB: Math.round(jsBytesKB),
      jsRequests: jsRes.length,
      blockingScripts: blocking,
    };
  });

  return metrics;
}

// ---------------------------------------------------------------------------
// Reporter
// ---------------------------------------------------------------------------
function avg(values: number[]): number {
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

function col(s: string | number | null, width: number): string {
  const str = s === null ? 'n/a' : String(s);
  return str.padStart(width);
}

function printTable(results: Array<{ name: string; dataContext?: string; runs: NavMetrics[] }>) {
  const hr = '─'.repeat(120);
  console.log('\n' + hr);
  console.log(
    'Route'.padEnd(42) +
    'Data'.padEnd(26) +
    col('DCL ms', 9) +
    col('Load ms', 9) +
    col('FCP ms', 9) +
    col('LCP ms', 9) +
    col('JS KB', 9) +
    col('JS reqs', 9),
  );
  console.log(hr);

  for (const { name, dataContext, runs } of results) {
    const dcl  = avg(runs.map(r => r.dcl));
    const load = avg(runs.map(r => r.load));
    const fcp  = runs.some(r => r.fcp !== null) ? avg(runs.filter(r => r.fcp !== null).map(r => r.fcp!)) : null;
    const lcp  = runs.some(r => r.lcp !== null) ? avg(runs.filter(r => r.lcp !== null).map(r => r.lcp!)) : null;
    const js   = avg(runs.map(r => r.jsBytesKB));
    const reqs = avg(runs.map(r => r.jsRequests));

    console.log(
      name.slice(0, 41).padEnd(42) +
      (dataContext ?? '–').slice(0, 25).padEnd(26) +
      col(dcl, 9) +
      col(load, 9) +
      col(fcp, 9) +
      col(lcp, 9) +
      col(js, 9) +
      col(reqs, 9),
    );
  }

  console.log(hr);
  console.log(`Averaged over ${RUNS} run(s) per route. All times in milliseconds.\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Dev server lifecycle
// ---------------------------------------------------------------------------
async function waitForServer(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok || res.status < 500) return;
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`Server at ${url} did not become ready within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function run() {
  console.log(`\nPerformance profile — ${BASE_URL}  (${RUNS} run(s) per route)`);
  console.log(`Backend API       — ${API_URL}\n`);

  // Auto-start dev server if nothing is listening on BASE_URL
  let devServer: ChildProcess | null = null;
  let serverStarted = false;
  try {
    await fetch(BASE_URL, { signal: AbortSignal.timeout(1500) });
  } catch {
    console.log('Dev server not running — starting "npm run dev" ...');
    devServer = spawn('npm', ['run', 'dev'], {
      cwd: process.cwd(),
      shell: true,
      stdio: 'pipe',
    });
    devServer.stdout?.on('data', (d: Buffer) => {
      if (d.toString().includes('Local')) process.stdout.write('  ' + d.toString().trim() + '\n');
    });
    await waitForServer(BASE_URL);
    serverStarted = true;
    console.log('Dev server ready.\n');
  }

  console.log('Discovering routes from live database...');
  const ROUTES = await discoverRoutes();
  console.log(`  ${ROUTES.length} routes found.\n`);

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });

    const results: Array<{ name: string; dataContext?: string; runs: NavMetrics[] }> = [];

    for (const route of ROUTES) {
      const runMetrics: NavMetrics[] = [];
      const ctx_label = route.dataContext ? ` [${route.dataContext}]` : '';
      process.stdout.write(`  Profiling "${route.name}"${ctx_label} ...`);

      for (let i = 0; i < RUNS; i++) {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        try {
          const m = await measurePage(page, route.path, route.waitFor);
          runMetrics.push(m);
          process.stdout.write(` run${i + 1}(${m.dcl}ms)`);
        } catch (e: any) {
          console.error(`\n    ERROR on ${route.path}: ${e.message}`);
        } finally {
          await ctx.close();
        }
      }

      results.push({ name: route.name, dataContext: route.dataContext, runs: runMetrics });
      console.log();
    }

    printTable(results);

    // Save to performances/<date>-<time>.json
    const now = new Date();
    const stamp = now.toISOString().replace(/T/, '_').replace(/:/g, '-').replace(/\..+/, '');
    const outDir = join(process.cwd(), 'performances');
    mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, `${stamp}.json`);
    const json = {
      date: now.toISOString(),
      baseUrl: BASE_URL,
      runs: RUNS,
      routes: results.map(({ name, dataContext, runs }) => ({
        name,
        dataContext: dataContext ?? null,
        dcl:  avg(runs.map(r => r.dcl)),
        load: avg(runs.map(r => r.load)),
        fcp:  runs.some(r => r.fcp !== null) ? avg(runs.filter(r => r.fcp !== null).map(r => r.fcp!)) : null,
        lcp:  runs.some(r => r.lcp !== null) ? avg(runs.filter(r => r.lcp !== null).map(r => r.lcp!)) : null,
        jsBytesKB: avg(runs.map(r => r.jsBytesKB)),
        jsRequests: avg(runs.map(r => r.jsRequests)),
      })),
    };
    writeFileSync(outPath, JSON.stringify(json, null, 2));
    console.log(`Results saved to ${outPath}\n`);

  } finally {
    await browser?.close();
    if (devServer && serverStarted) {
      devServer.kill();
    }
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
