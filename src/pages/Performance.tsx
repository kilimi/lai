import { useState, useEffect, useCallback, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { Play, RefreshCw, Clock, Wifi, WifiOff, ChevronDown, ChevronRight } from 'lucide-react';

// ---------------------------------------------------------------------------
// Types matching perf-profile.ts output
// ---------------------------------------------------------------------------
interface RouteResult {
  name: string;
  dataContext: string | null;
  dcl: number;
  load: number;
  fcp: number | null;
  lcp: number | null;
  jsBytesKB: number;
  jsRequests: number;
}

interface PerfSnapshot {
  filename: string;
  date: string;
  baseUrl: string;
  runs: number;
  routes: RouteResult[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const PERF_SERVER = 'http://localhost:4444';

const LCP_THRESHOLDS = { good: 2500, needs_improvement: 4000 };

function lcpColor(ms: number | null): string {
  if (ms === null) return '#94a3b8';
  if (ms <= LCP_THRESHOLDS.good) return '#22c55e';
  if (ms <= LCP_THRESHOLDS.needs_improvement) return '#f59e0b';
  return '#ef4444';
}

function lcpLabel(ms: number | null): string {
  if (ms === null) return '–';
  if (ms <= LCP_THRESHOLDS.good) return 'Good';
  if (ms <= LCP_THRESHOLDS.needs_improvement) return 'Needs work';
  return 'Poor';
}

function fmt(ms: number | null): string {
  if (ms === null || ms === 0) return '–';
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------
function MetricBadge({ ms, label }: { ms: number | null; label: string }) {
  const color = lcpColor(ms);
  return (
    <div className="flex flex-col items-center gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-mono text-sm font-semibold" style={{ color }}>
        {fmt(ms)}
      </span>
    </div>
  );
}

function RouteRow({ route }: { route: RouteResult }) {
  const [open, setOpen] = useState(false);
  const lcp = route.lcp;
  const color = lcpColor(lcp);

  return (
    <div className="border rounded-lg overflow-hidden">
      <button
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/40 transition-colors"
        onClick={() => setOpen(o => !o)}
      >
        {open ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
        <span className="flex-1 font-medium text-sm truncate">{route.name}</span>
        {route.dataContext && (
          <span className="text-xs text-muted-foreground hidden sm:block mr-2">{route.dataContext}</span>
        )}
        <Badge
          variant="outline"
          className="text-xs shrink-0"
          style={{ borderColor: color, color }}
        >
          LCP {fmt(lcp)} · {lcpLabel(lcp)}
        </Badge>
      </button>
      {open && (
        <div className="px-4 pb-4 pt-1 bg-muted/20 border-t grid grid-cols-3 sm:grid-cols-6 gap-4">
          <MetricBadge ms={route.dcl} label="DCL" />
          <MetricBadge ms={route.load} label="Load" />
          <MetricBadge ms={route.fcp} label="FCP" />
          <MetricBadge ms={route.lcp} label="LCP" />
          <div className="flex flex-col items-center gap-0.5">
            <span className="text-xs text-muted-foreground">JS KB</span>
            <span className="font-mono text-sm font-semibold">
              {route.jsBytesKB > 0 ? `${Math.round(route.jsBytesKB)}` : '–'}
            </span>
          </div>
          <div className="flex flex-col items-center gap-0.5">
            <span className="text-xs text-muted-foreground">JS Reqs</span>
            <span className="font-mono text-sm font-semibold">{route.jsRequests || '–'}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function LcpChart({ snapshot }: { snapshot: PerfSnapshot }) {
  const data = snapshot.routes
    .filter(r => r.lcp !== null || r.fcp !== null)
    .map(r => ({
      name: r.name.replace(/^(Project |Dataset )/, '').slice(0, 22),
      LCP: r.lcp ?? undefined,
      FCP: r.fcp ?? undefined,
    }));

  if (data.length === 0) return null;

  return (
    <div className="mt-6">
      <h3 className="text-sm font-semibold mb-3 text-muted-foreground uppercase tracking-wide">
        LCP / FCP per route (ms)
      </h3>
      <ResponsiveContainer width="100%" height={280}>
        <BarChart data={data} margin={{ top: 4, right: 16, left: 0, bottom: 60 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis
            dataKey="name"
            angle={-35}
            textAnchor="end"
            tick={{ fontSize: 11 }}
            interval={0}
          />
          <YAxis tick={{ fontSize: 11 }} unit="ms" width={56} />
          <Tooltip formatter={(v: number) => `${v}ms`} />
          <Legend verticalAlign="top" />
          <ReferenceLine y={2500} stroke="#22c55e" strokeDasharray="4 2" label={{ value: 'Good 2.5s', position: 'insideTopRight', fontSize: 10, fill: '#22c55e' }} />
          <ReferenceLine y={4000} stroke="#f59e0b" strokeDasharray="4 2" label={{ value: 'Needs work 4s', position: 'insideTopRight', fontSize: 10, fill: '#f59e0b' }} />
          <Bar dataKey="LCP" fill="#6366f1" radius={[3, 3, 0, 0]} maxBarSize={40} />
          <Bar dataKey="FCP" fill="#a5b4fc" radius={[3, 3, 0, 0]} maxBarSize={40} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function JsChart({ snapshot }: { snapshot: PerfSnapshot }) {
  const data = snapshot.routes.map(r => ({
    name: r.name.replace(/^(Project |Dataset )/, '').slice(0, 22),
    jsBytesKB: r.jsBytesKB || undefined,
  }));

  return (
    <div className="mt-6">
      <h3 className="text-sm font-semibold mb-3 text-muted-foreground uppercase tracking-wide">
        JS transferred per route (KB)
      </h3>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data} margin={{ top: 4, right: 16, left: 0, bottom: 60 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="name" angle={-35} textAnchor="end" tick={{ fontSize: 11 }} interval={0} />
          <YAxis tick={{ fontSize: 11 }} unit="KB" width={56} />
          <Tooltip formatter={(v: number) => `${v} KB`} />
          <Bar dataKey="jsBytesKB" name="JS KB" fill="#8b5cf6" radius={[3, 3, 0, 0]} maxBarSize={40} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function SnapshotView({ snapshot }: { snapshot: PerfSnapshot }) {
  const worst = [...snapshot.routes]
    .filter(r => r.lcp !== null)
    .sort((a, b) => (b.lcp ?? 0) - (a.lcp ?? 0))
    .slice(0, 3);

  return (
    <div>
      {/* Summary row */}
      <div className="flex flex-wrap gap-6 mb-6 p-4 bg-muted/30 rounded-lg">
        <div>
          <div className="text-xs text-muted-foreground mb-1">Run at</div>
          <div className="text-sm font-medium">{fmtDate(snapshot.date)}</div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground mb-1">Base URL</div>
          <div className="text-sm font-mono">{snapshot.baseUrl}</div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground mb-1">Runs/route</div>
          <div className="text-sm font-semibold">{snapshot.runs}</div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground mb-1">Routes</div>
          <div className="text-sm font-semibold">{snapshot.routes.length}</div>
        </div>
        {worst.length > 0 && (
          <div>
            <div className="text-xs text-muted-foreground mb-1">Slowest LCP</div>
            <div className="text-sm font-semibold" style={{ color: lcpColor(worst[0].lcp) }}>
              {worst[0].name.slice(0, 30)} — {fmt(worst[0].lcp)}
            </div>
          </div>
        )}
      </div>

      <LcpChart snapshot={snapshot} />
      <JsChart snapshot={snapshot} />

      {/* Route list */}
      <div className="mt-8 space-y-2">
        <h3 className="text-sm font-semibold mb-3 text-muted-foreground uppercase tracking-wide">
          All routes
        </h3>
        {snapshot.routes.map(r => (
          <RouteRow key={r.name} route={r} />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Run log panel
// ---------------------------------------------------------------------------
function RunLog({ log, running }: { log: string[]; running: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [log]);

  if (log.length === 0 && !running) return null;

  return (
    <div
      ref={ref}
      className="mt-4 bg-black/90 text-green-400 font-mono text-xs rounded-lg p-3 max-h-56 overflow-y-auto"
    >
      {running && <div className="text-yellow-300 mb-1">● Running…</div>}
      {log.map((line, i) => (
        <div key={i} className="leading-5 whitespace-pre-wrap break-all">{line}</div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export default function Performance() {
  const [snapshots, setSnapshots] = useState<PerfSnapshot[]>([]);
  const [selected, setSelected] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [serverOnline, setServerOnline] = useState<boolean | null>(null);
  const [running, setRunning] = useState(false);
  const [runs, setRuns] = useState(1);
  const [runLog, setRunLog] = useState<string[]>([]);
  const [runError, setRunError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchResults = useCallback(async () => {
    try {
      const res = await fetch(`${PERF_SERVER}/results`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: PerfSnapshot[] = await res.json();
      setSnapshots(data);
      setServerOnline(true);
    } catch {
      setServerOnline(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchResults();
  }, [fetchResults]);

  // Poll run status while running
  const pollStatus = useCallback(async () => {
    try {
      const res = await fetch(`${PERF_SERVER}/run/status`, { signal: AbortSignal.timeout(2000) });
      const data = await res.json();
      setRunLog(data.log ?? []);
      if (!data.running) {
        setRunning(false);
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
        // Refresh results after run completes
        await fetchResults();
        setSelected(0); // jump to newest
      }
    } catch {
      // server went away mid-run
    }
  }, [fetchResults]);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const handleRun = async () => {
    setRunError(null);
    setRunLog([]);
    try {
      const res = await fetch(`${PERF_SERVER}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runs }),
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) {
        const err = await res.json();
        setRunError(err.error ?? 'Failed to start run');
        return;
      }
      setRunning(true);
      pollRef.current = setInterval(pollStatus, 1500);
    } catch (e: any) {
      setRunError('Cannot connect to perf server. Run: npx tsx tests/perf-server.ts');
    }
  };

  const snapshot = snapshots[selected] ?? null;

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-5xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold">Performance</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Browser LCP / FCP / JS weight per route
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {serverOnline === null ? null : serverOnline ? (
                <><Wifi className="h-3.5 w-3.5 text-green-500" /> perf-server online</>
              ) : (
                <><WifiOff className="h-3.5 w-3.5 text-destructive" /> perf-server offline</>
              )}
            </div>
            <Button variant="ghost" size="icon" onClick={fetchResults} title="Refresh list">
              <RefreshCw className="h-4 w-4" />
            </Button>
            <div className="flex items-center gap-1 border rounded-md px-2 h-9 text-sm">
              <Clock className="h-3.5 w-3.5 text-muted-foreground" />
              <input
                type="number"
                min={1}
                max={5}
                value={runs}
                onChange={e => setRuns(Math.max(1, Math.min(5, Number(e.target.value))))}
                className="w-8 bg-transparent text-center outline-none"
                title="Runs per route"
              />
              <span className="text-muted-foreground text-xs">runs</span>
            </div>
            <Button onClick={handleRun} disabled={running || !serverOnline} className="gap-2">
              <Play className="h-4 w-4" />
              {running ? 'Running…' : 'Run'}
            </Button>
          </div>
        </div>

        {/* Server offline warning */}
        {serverOnline === false && (
          <div className="mb-4 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/30 text-sm text-yellow-600 dark:text-yellow-400">
            <strong>Perf server not running.</strong> Start it with:{' '}
            <code className="font-mono bg-black/10 px-1 rounded">npx tsx tests/perf-server.ts</code>
          </div>
        )}

        {/* Run log */}
        {(running || runLog.length > 0) && (
          <RunLog log={runLog} running={running} />
        )}
        {runError && (
          <div className="mt-2 text-sm text-destructive">{runError}</div>
        )}

        {/* Snapshot selector */}
        {snapshots.length > 0 && (
          <div className="flex gap-2 flex-wrap mt-6 mb-6">
            {snapshots.map((s, i) => (
              <button
                key={s.filename}
                onClick={() => setSelected(i)}
                className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors border ${
                  i === selected
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-muted/40 border-border hover:bg-muted text-muted-foreground'
                }`}
              >
                {fmtDate(s.date)}
              </button>
            ))}
          </div>
        )}

        {/* Content */}
        {loading ? (
          <div className="flex items-center justify-center h-40 text-muted-foreground text-sm">
            Loading…
          </div>
        ) : snapshots.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-56 gap-3 text-muted-foreground text-sm">
            <p>No performance snapshots yet.</p>
            <p>
              Start the server and click <strong>Run</strong>, or run{' '}
              <code className="font-mono bg-muted px-1 rounded">npx tsx tests/perf-profile.ts</code>.
            </p>
          </div>
        ) : snapshot ? (
          <SnapshotView snapshot={snapshot} />
        ) : null}
      </div>
    </div>
  );
}
