/**
 * Tiny local dev server for the /performance page.
 *
 * Runs on port 4444 and exposes:
 *   GET  /results          – list all performances/*.json files (newest first)
 *   GET  /results/:file    – return one file's content
 *   POST /run              – spawn a new profiler run (non-blocking)
 *   GET  /run/status       – { running: bool, startedAt: string|null }
 *
 * Start with:
 *   npx tsx tests/perf-server.ts
 *
 * The /performance page in the React app talks to http://localhost:4444.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';

const PORT = 4444;
const PERF_DIR = path.join(process.cwd(), 'performances');

// ---------------------------------------------------------------------------
// Run state
// ---------------------------------------------------------------------------
let runProcess: ChildProcess | null = null;
let runStartedAt: string | null = null;
let runLog: string[] = [];
let runExitCode: number | null = null;

function isRunning(): boolean {
  return runProcess !== null && runExitCode === null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function cors(res: http.ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res: http.ServerResponse, data: unknown, status = 200) {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function listResultFiles(): string[] {
  if (!fs.existsSync(PERF_DIR)) return [];
  return fs
    .readdirSync(PERF_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse(); // newest first
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  const url = req.url ?? '/';

  // GET /results
  if (req.method === 'GET' && url === '/results') {
    const files = listResultFiles();
    const results = files.map(filename => {
      try {
        const raw = fs.readFileSync(path.join(PERF_DIR, filename), 'utf8');
        return { filename, ...JSON.parse(raw) };
      } catch {
        return { filename, error: 'parse error' };
      }
    });
    return json(res, results);
  }

  // GET /results/:filename
  const fileMatch = url.match(/^\/results\/([^/]+\.json)$/);
  if (req.method === 'GET' && fileMatch) {
    const filename = fileMatch[1];
    const filePath = path.join(PERF_DIR, filename);
    if (!fs.existsSync(filePath)) return json(res, { error: 'Not found' }, 404);
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      return json(res, JSON.parse(raw));
    } catch {
      return json(res, { error: 'parse error' }, 500);
    }
  }

  // GET /run/status
  if (req.method === 'GET' && url === '/run/status') {
    return json(res, {
      running: isRunning(),
      startedAt: runStartedAt,
      exitCode: runExitCode,
      log: runLog.slice(-100), // last 100 lines
    });
  }

  // POST /run
  if (req.method === 'POST' && url === '/run') {
    if (isRunning()) {
      return json(res, { error: 'Already running', startedAt: runStartedAt }, 409);
    }

    runLog = [];
    runExitCode = null;
    runStartedAt = new Date().toISOString();

    // Read runs param from request body
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let runs = 1;
      try {
        const parsed = JSON.parse(body || '{}');
        if (parsed.runs && typeof parsed.runs === 'number') runs = parsed.runs;
      } catch { /* ignore */ }

      runProcess = spawn(
        'npx',
        ['tsx', 'tests/perf-profile.ts', '--runs', String(runs)],
        { cwd: process.cwd(), shell: true, stdio: 'pipe' }
      );

      runProcess.stdout?.on('data', (d: Buffer) => {
        const lines = d.toString().split('\n').filter(Boolean);
        runLog.push(...lines);
      });
      runProcess.stderr?.on('data', (d: Buffer) => {
        const lines = d.toString().split('\n').filter(Boolean);
        runLog.push(...lines.map(l => `[stderr] ${l}`));
      });
      runProcess.on('close', (code) => {
        runExitCode = code ?? 0;
        runProcess = null;
      });

      json(res, { ok: true, startedAt: runStartedAt, runs });
    });
    return;
  }

  json(res, { error: 'Not found' }, 404);
});

server.listen(PORT, () => {
  console.log(`\nPerf server running at http://localhost:${PORT}`);
  console.log(`  GET  /results           – list all performance snapshots`);
  console.log(`  POST /run               – start a new profiler run`);
  console.log(`  GET  /run/status        – check run progress\n`);
});
