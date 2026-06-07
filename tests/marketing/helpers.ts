import { Page, TestInfo } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Helpers for marketing/demo capture.
 */

export const FLOWS_ROOT = path.join(process.cwd(), 'docs', 'flows');

/**
 * Inject the caption overlay container + styles. Call once after page.goto.
 * Creates a fixed bottom-center "lower third" banner used by `caption()`.
 */
export async function installCaptionOverlay(page: Page) {
  await page.addInitScript(() => {
    const ensure = () => {
      if (document.getElementById('__demo_caption__')) return;
      const style = document.createElement('style');
      style.textContent = `
        #__demo_caption_wrap__ {
          position: fixed; left: 0; right: 0; bottom: 48px;
          display: flex; justify-content: center; pointer-events: none;
          z-index: 2147483646; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        }
        #__demo_caption__ {
          max-width: min(80vw, 900px);
          padding: 14px 26px;
          background: rgba(15, 23, 42, 0.88);
          color: #fff;
          font-size: 22px; font-weight: 600; letter-spacing: 0.2px;
          border-radius: 14px;
          box-shadow: 0 12px 40px rgba(0,0,0,0.35), 0 0 0 1px rgba(255,255,255,0.06) inset;
          backdrop-filter: blur(6px);
          opacity: 0; transform: translateY(16px);
          transition: opacity 320ms ease, transform 320ms ease;
          text-align: center; line-height: 1.35;
        }
        #__demo_caption__.show { opacity: 1; transform: translateY(0); }
        #__demo_caption__ .step {
          display: inline-block; margin-right: 10px;
          padding: 2px 10px; border-radius: 999px;
          background: rgba(59,130,246,0.9); color: #fff;
          font-size: 14px; font-weight: 700; letter-spacing: 0.6px;
          vertical-align: middle;
        }
      `;
      const wrap = document.createElement('div');
      wrap.id = '__demo_caption_wrap__';
      const cap = document.createElement('div');
      cap.id = '__demo_caption__';
      wrap.appendChild(cap);
      const mount = () => {
        if (document.body) {
          document.head.appendChild(style);
          document.body.appendChild(wrap);
        } else {
          window.addEventListener('DOMContentLoaded', mount, { once: true });
        }
      };
      mount();
    };
    ensure();
    window.addEventListener('DOMContentLoaded', ensure);
  });
}

/**
 * Show an animated caption banner at the bottom of the page.
 * Stays visible until `caption()` is called again or `clearCaption()` is used.
 */
export async function caption(page: Page, text: string, opts: { step?: number | string } = {}) {
  await page.evaluate(({ text, step }) => {
    const el = document.getElementById('__demo_caption__');
    if (!el) return;
    const stepHtml = step != null ? `<span class="step">STEP ${step}</span>` : '';
    el.classList.remove('show');
    setTimeout(() => {
      el.innerHTML = `${stepHtml}${text}`;
      requestAnimationFrame(() => el.classList.add('show'));
    }, 200);
  }, { text, step: opts.step ?? null });
  await page.waitForTimeout(600);
}

export async function clearCaption(page: Page) {
  await page.evaluate(() => {
    const el = document.getElementById('__demo_caption__');
    if (el) el.classList.remove('show');
  });
  await page.waitForTimeout(300);
}

/**
 * Combined helper: show a caption, wait a beat so it's readable in the video,
 * then take a screenshot. Use as the main rhythm of a marketing tour.
 */
export async function step(
  page: Page,
  testInfo: TestInfo,
  label: string,
  caption_text: string,
  opts: { hold?: number; stepNumber?: number } = {},
) {
  const idx = (((testInfo as unknown as { _stepIdx?: number })._stepIdx ?? 0) + 1);
  (testInfo as unknown as { _stepIdx?: number })._stepIdx = idx;
  await caption(page, caption_text, { step: opts.stepNumber ?? idx });
  await page.waitForTimeout(opts.hold ?? 2400);
  await shot(page, testInfo, label);
}

/**
 * Save a screenshot under docs/flows/<flow-slug>/<NN>-<label>.png.
 * Call between meaningful user actions.
 */
export async function shot(
  page: Page,
  testInfo: TestInfo,
  label: string,
  opts: { fullPage?: boolean } = {},
) {
  const flowSlug = slugify(testInfo.title);
  const dir = path.join(FLOWS_ROOT, flowSlug);
  fs.mkdirSync(dir, { recursive: true });

  // Auto-incrementing step counter per test
  const count = ((testInfo as unknown as { _shotIdx?: number })._shotIdx ?? 0) + 1;
  (testInfo as unknown as { _shotIdx?: number })._shotIdx = count;
  const idx = String(count).padStart(2, '0');

  const file = path.join(dir, `${idx}-${slugify(label)}.png`);
  await page.screenshot({ path: file, fullPage: opts.fullPage ?? false });
  console.log(`📸  ${path.relative(process.cwd(), file)}`);
}

/**
 * Inject a visible cursor ring so videos show where the user is "clicking".
 * Playwright's real cursor is not recorded by default.
 */
export async function installCursor(page: Page) {
  await page.addInitScript(() => {
    const id = '__demo_cursor__';
    const ensure = () => {
      if (document.getElementById(id)) return;
      const dot = document.createElement('div');
      dot.id = id;
      Object.assign(dot.style, {
        position: 'fixed',
        top: '0',
        left: '0',
        width: '22px',
        height: '22px',
        marginLeft: '-11px',
        marginTop: '-11px',
        borderRadius: '50%',
        background: 'rgba(59,130,246,0.35)',
        border: '2px solid rgba(59,130,246,0.9)',
        pointerEvents: 'none',
        zIndex: '2147483647',
        transition: 'transform 60ms linear',
        boxShadow: '0 0 12px rgba(59,130,246,0.6)',
      } as CSSStyleDeclaration);
      document.body.appendChild(dot);
    };
    const onMove = (e: MouseEvent) => {
      ensure();
      const dot = document.getElementById(id);
      if (dot) dot.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
    };
    const onDown = () => {
      ensure();
      const dot = document.getElementById(id);
      if (dot) dot.style.background = 'rgba(59,130,246,0.7)';
    };
    const onUp = () => {
      const dot = document.getElementById(id);
      if (dot) dot.style.background = 'rgba(59,130,246,0.35)';
    };
    window.addEventListener('DOMContentLoaded', ensure);
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('mouseup', onUp, true);
  });
}

/**
 * Mock the training endpoints so flows can show "train a model" without
 * actually running training. Intercepts the backend API directly.
 */
export async function mockTraining(page: Page) {
  const apiBase = process.env.TEST_API_URL || 'http://localhost:9999';
  let taskId = 9001;

  await page.route(`${apiBase}/api/training/**`, async (route) => {
    const url = route.request().url();
    const method = route.request().method();

    if (method === 'POST' && /\/start$|\/rtdetr$|\/yolo/.test(url)) {
      taskId += 1;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          task_id: taskId,
          status: 'queued',
          message: 'Training queued (mocked)',
        }),
      });
    }

    if (method === 'GET' && /\/status$/.test(url)) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          task_id: taskId,
          status: 'completed',
          progress: 100,
          metrics: { mAP50: 0.91, mAP5095: 0.74, precision: 0.93, recall: 0.88 },
        }),
      });
    }

    return route.continue();
  });
}

function slugify(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
