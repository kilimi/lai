import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Brain,
  TrendingUp,
  Activity,
  Settings,
  ChevronDown,
  ChevronUp,
  Images,
  Database,
  FileBox,
  LineChart as LineChartIcon,
  LayoutGrid,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useApi } from "@/hooks/use-api";

// recharts is heavy (~90 KB gzip) — load it only when the dialog is opened.
const TrainingMetricsCharts = lazy(
  () => import("@/components/TrainingMetricsCharts")
);
import { TrainingExamplesGallery } from "@/components/TrainingExamplesGallery";
import { formatDuration } from "@/utils/formatDuration";
import { StatusBadge } from "@/components/StatusBadge";
import { getApiBaseUrl } from "@/config/api";

interface TrainingDetailsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taskId: number;
}

interface TrainingMetrics {
  epoch: number;
  box_loss?: number;
  cls_loss?: number;
  dfl_loss?: number;
  seg_loss?: number;
  precision?: number;
  recall?: number;
  mAP50?: number;
  mAP50_95?: number;
  lr0?: number;
  lr1?: number;
  lr2?: number;
}

interface TaskDetails {
  id: number;
  name: string;
  status: string;
  task_type?: string;
  progress: number;
  created_at: string;
  completed_at?: string;
  error_message?: string;
  task_metadata?: {
    current_epoch?: number;
    epochs?: number;
    total_epochs?: number;
    current_batch?: number;
    total_batches?: number;
    epoch_progress_pct?: number;
    epoch_eta_seconds?: number;
    latest_metrics?: TrainingMetrics;
    metrics_history?: TrainingMetrics[];
    training_params?: any;
    model_config?: any;
    stage?: string;
    pause_requested_at?: string | null;
    best_model?: string;
    results_dir?: string;
    class_names?: string[];
    image_size?: number;
    image_counts?: { train: number; val: number; test: number };
    dataset_count?: number;
    dataset_ids?: number[];
    examples_path?: string;
    example_images?: Record<string, string>;
    dataset_stats?: {
      total_images?: { train: number; val: number; test: number };
      total_annotations?: { train: number; val: number; test: number };
      annotations_per_class?: Record<string, { train: number; val: number; test: number }>;
      images_filtered?: number;
      images_processed?: number;
    };
    dataset_configs?: Array<{
      dataset_id: number;
      dataset_name?: string;
      annotation_file_id: string;
      annotation_file_name?: string;
      image_collection?: string;
      split?: { train: number; val: number; test: number };
    }>;
  };
}

const STATUS_ACCENT: Record<string, string> = {
  completed: "border-l-emerald-500",
  running: "border-l-primary",
  pending: "border-l-muted-foreground",
  failed: "border-l-destructive",
  stopped: "border-l-amber-500",
  cancelled: "border-l-amber-500",
  paused: "border-l-yellow-500",
};

function metricColor(v: number | undefined | null): string {
  if (v === null || v === undefined) return "text-muted-foreground";
  if (v >= 0.85) return "text-emerald-500";
  if (v >= 0.6) return "text-amber-500";
  return "text-destructive";
}

function MetricTile({
  label,
  value,
  format = "percent",
  hint,
}: {
  label: string;
  value: number | undefined | null;
  format?: "percent" | "decimal" | "raw";
  hint?: string;
}) {
  const display =
    value === null || value === undefined
      ? "—"
      : format === "percent"
      ? `${(value * 100).toFixed(1)}%`
      : format === "decimal"
      ? value.toFixed(4)
      : String(value);
  const colored = format === "percent" ? metricColor(value) : "text-foreground";
  return (
    <Card className="p-4">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
        {label}
      </div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums leading-tight ${value == null ? "text-muted-foreground" : colored}`}>
        {display}
      </div>
      {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
    </Card>
  );
}

function KV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="text-sm">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-foreground font-medium tabular-nums truncate">{value ?? "—"}</div>
    </div>
  );
}

function formatEpochEta(seconds?: number | null): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  const totalSeconds = Math.round(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${totalSeconds}s`;
}

function SectionHeading({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <div className="text-primary">{icon}</div>
      <h3 className="text-base font-semibold text-foreground">{children}</h3>
    </div>
  );
}

export function TrainingDetailsModal({ open, onOpenChange, taskId }: TrainingDetailsModalProps) {
  const { api } = useApi();
  const [task, setTask] = useState<TaskDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAllSettings, setShowAllSettings] = useState(false);
  const [showStatusReason, setShowStatusReason] = useState(false);
  const [tab, setTab] = useState("overview");

  const fetchTaskDetails = useCallback(async (signal?: AbortSignal) => {
    if (!api) {
      setLoading(false);
      setError('API not available');
      return;
    }
    try {
      setError(null);
      const base = getApiBaseUrl();
      const response = await fetch(`${base}/tasks/${taskId}`, { signal });
      if (!response.ok) throw new Error(`Failed to fetch task details: ${response.status}`);
      if (signal?.aborted) return;
      const data = await response.json();
      if (signal?.aborted) return;
      setTask(data);
    } catch (err) {
      if (signal?.aborted || (err instanceof DOMException && err.name === "AbortError")) return;
      console.error('Error fetching task details:', err);
      setError(err instanceof Error ? err.message : 'Failed to load training details');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [api, taskId]);

  useEffect(() => {
    if (!open || !taskId) return;
    setLoading(true);
    const ac = new AbortController();
    void fetchTaskDetails(ac.signal);
    return () => ac.abort();
  }, [open, taskId, fetchTaskDetails]);

  useEffect(() => {
    if (!open) {
      setShowStatusReason(false);
      setTab("overview");
      setShowAllSettings(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open || !taskId) return;
    if (task?.status !== 'running') return;
    const interval = setInterval(() => { void fetchTaskDetails(); }, 3000);
    return () => clearInterval(interval);
  }, [open, taskId, task?.status, fetchTaskDetails]);

  const metadata = task?.task_metadata;
  const metricsHistory = metadata?.metrics_history || [];
  const isMmyoloTraining = task?.task_type === 'mmyolo_training';

  const latestMetrics = useMemo(() => {
    const raw = metadata?.latest_metrics;
    const lastHist = metricsHistory.length ? metricsHistory[metricsHistory.length - 1] : null;
    const lastVal = [...metricsHistory]
      .reverse()
      .find((m) => m.mAP50 != null || m.mAP50_95 != null);

    const merged: TrainingMetrics = {
      ...(lastHist || {}),
      ...(raw || {}),
    };
    if (lastVal) {
      if (lastVal.mAP50 != null) merged.mAP50 = lastVal.mAP50;
      if (lastVal.mAP50_95 != null) merged.mAP50_95 = lastVal.mAP50_95;
      if (lastVal.precision != null) merged.precision = lastVal.precision;
      if (lastVal.recall != null) merged.recall = lastVal.recall;
    }
    if (merged.epoch == null) {
      merged.epoch =
        raw?.epoch ??
        metadata?.current_epoch ??
        lastVal?.epoch ??
        lastHist?.epoch;
    }
    const hasData =
      merged.epoch != null ||
      merged.mAP50 != null ||
      merged.mAP50_95 != null ||
      merged.box_loss != null ||
      merged.cls_loss != null;
    return hasData ? merged : null;
  }, [metadata, metricsHistory]);
  const statusReason =
    task?.error_message
    || (metadata as any)?.error
    || (metadata as any)?.failure_reason
    || (metadata as any)?.failureReason
    || null;

  // Best epoch (highest mAP50) for the hero tile
  const bestEpoch = useMemo(() => {
    if (!metricsHistory.length) return null;
    let best: TrainingMetrics | null = null;
    for (const m of metricsHistory) {
      const v = m.mAP50 ?? 0;
      if (!best || (best.mAP50 ?? 0) < v) best = m;
    }
    return best;
  }, [metricsHistory]);

  const modelName = metadata?.model_config?.model || metadata?.training_params?.model || (metadata as any)?.model_type || '—';
  const epochsTotal = metadata?.total_epochs || metadata?.epochs || metadata?.training_params?.epochs;
  const currentEpoch = Math.min(
    metadata?.current_epoch || 0,
    Number(epochsTotal) || metadata?.current_epoch || 0,
  );
  const currentBatch = metadata?.current_batch;
  const totalBatches = metadata?.total_batches;
  const epochProgressPct = metadata?.epoch_progress_pct;
  const epochEta = formatEpochEta(metadata?.epoch_eta_seconds);
  const pauseRequested = task?.status === 'running' && metadata?.stage === 'pause_requested';
  const isFinal = task?.status === 'failed' || task?.status === 'stopped' || task?.status === 'cancelled';
  const accent = STATUS_ACCENT[task?.status ?? ''] ?? "border-l-border";

  const augs = metadata?.model_config?.augmentations;
  const enabledAugChips = useMemo(() => {
    if (!augs) return [];
    const out: string[] = [];
    if (augs.enable_color) out.push("Color");
    if (augs.enable_geometric) out.push("Geometric");
    if (augs.enable_advanced) out.push("Advanced");
    if (augs.mosaic) out.push("Mosaic");
    if (augs.mixup) out.push("MixUp");
    if (augs.fliplr) out.push("Flip LR");
    if (augs.flipud) out.push("Flip UD");
    return out;
  }, [augs]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-6xl max-h-[92vh] overflow-hidden p-0 flex flex-col">
        {/* Sticky header with status accent */}
        <DialogHeader className={`px-6 pt-5 pb-4 border-b border-border border-l-4 ${accent} shrink-0`}>
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="min-w-0">
              <DialogTitle className="flex items-center gap-2 text-xl">
                <Brain className="w-5 h-5 text-primary" />
                <span className="truncate">{task?.name || `Task #${taskId}`}</span>
              </DialogTitle>
              <div className="mt-2 flex items-center gap-2 flex-wrap text-sm text-muted-foreground">
                {task && <StatusBadge status={task.status} />}
                <Badge variant="outline" className="text-xs">{modelName}</Badge>
                <span>·</span>
                <span>#{taskId}</span>
                <span>·</span>
                <span>{task ? formatDuration(task.created_at, task.completed_at) : "—"}</span>
                {epochsTotal && (
                  <>
                    <span>·</span>
                    <span className="tabular-nums">{currentEpoch}/{epochsTotal} epochs</span>
                  </>
                )}
                {isFinal && statusReason && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    onClick={() => setShowStatusReason(p => !p)}
                  >
                    {showStatusReason ? 'Hide reason' : 'Why?'}
                  </Button>
                )}
              </div>
            </div>
          </div>

          {/* Running progress bar */}
          {task && (task.status === 'running' || task.status === 'pending') && (
            <div className="mt-3">
              <div className="flex items-center gap-3">
                <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{ width: `${task.progress || 0}%` }}
                  />
                </div>
                <span className="text-xs text-muted-foreground tabular-nums w-10 text-right">
                  {task.progress || 0}%
                </span>
              </div>
              {(currentBatch || pauseRequested) && (
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  {currentEpoch > 0 && epochsTotal && <span>Epoch {currentEpoch}/{epochsTotal}</span>}
                  {currentBatch && totalBatches && <span>Batch {currentBatch}/{totalBatches}</span>}
                  {typeof epochProgressPct === 'number' && <span>{epochProgressPct}% of current epoch</span>}
                  {epochEta && <span>~{epochEta} left in epoch</span>}
                  {pauseRequested && <span className="text-yellow-500">Pause requested — current epoch will finish first</span>}
                </div>
              )}
            </div>
          )}

          {isFinal && showStatusReason && statusReason && (
            <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 p-3">
              <div className="mb-1 text-xs uppercase tracking-wide text-destructive">Failure reason</div>
              <div className="whitespace-pre-wrap text-sm text-destructive-foreground">{statusReason}</div>
            </div>
          )}
        </DialogHeader>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {loading && !task ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24" />)}
              </div>
              <Skeleton className="h-48" />
              <Skeleton className="h-64" />
            </div>
          ) : error ? (
            <div className="text-center py-12 text-destructive">{error}</div>
          ) : task ? (
            <Tabs value={tab} onValueChange={setTab} className="w-full">
              <TabsList className="grid grid-cols-5 w-full max-w-2xl mb-4">
                <TabsTrigger value="overview"><LayoutGrid className="w-3.5 h-3.5 mr-1.5" />Overview</TabsTrigger>
                <TabsTrigger value="metrics"><LineChartIcon className="w-3.5 h-3.5 mr-1.5" />Metrics</TabsTrigger>
                <TabsTrigger value="config"><Settings className="w-3.5 h-3.5 mr-1.5" />Config</TabsTrigger>
                <TabsTrigger value="dataset"><Database className="w-3.5 h-3.5 mr-1.5" />Dataset</TabsTrigger>
                <TabsTrigger value="artifacts"><FileBox className="w-3.5 h-3.5 mr-1.5" />Artifacts</TabsTrigger>
              </TabsList>

              {/* OVERVIEW */}
              <TabsContent value="overview" className="space-y-6 mt-0">
                {/* Hero metric tiles */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <MetricTile label="mAP@50" value={latestMetrics?.mAP50} />
                  <MetricTile label="mAP@50–95" value={latestMetrics?.mAP50_95} />
                  <MetricTile
                    label="Best epoch"
                    value={bestEpoch?.epoch}
                    format="raw"
                    hint={bestEpoch?.mAP50 != null ? `mAP@50 ${(bestEpoch.mAP50 * 100).toFixed(1)}%` : undefined}
                  />
                  <MetricTile
                    label={task.status === 'running' ? 'Progress' : 'Duration'}
                    value={task.status === 'running' ? task.progress / 100 : null}
                    format="percent"
                    hint={formatDuration(task.created_at, task.completed_at)}
                  />
                </div>

                {/* Latest metrics breakdown */}
                {latestMetrics && latestMetrics.epoch != null && (
                  <div>
                    <SectionHeading icon={<TrendingUp className="w-4 h-4" />}>
                      Latest metrics — epoch {latestMetrics.epoch}
                    </SectionHeading>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      <MetricTile label="Precision" value={latestMetrics.precision} />
                      <MetricTile label="Recall" value={latestMetrics.recall} />
                      <MetricTile label="Box loss" value={latestMetrics.box_loss} format="decimal" />
                      <MetricTile label="Class loss" value={latestMetrics.cls_loss} format="decimal" />
                      {latestMetrics.dfl_loss != null && <MetricTile label="DFL loss" value={latestMetrics.dfl_loss} format="decimal" />}
                      {latestMetrics.seg_loss != null && <MetricTile label="Seg loss" value={latestMetrics.seg_loss} format="decimal" />}
                      {latestMetrics.lr0 != null && <MetricTile label="LR (pg0)" value={latestMetrics.lr0} format="decimal" />}
                    </div>
                    {isMmyoloTraining &&
                      latestMetrics.precision == null &&
                      latestMetrics.recall == null && (
                        <p className="mt-2 text-xs text-muted-foreground">
                          MMYOLO validation reports mAP during training (see tiles above). Run a project
                          evaluation for per-class precision and recall.
                        </p>
                      )}
                  </div>
                )}

                {/* Compact summary */}
                <Card className="p-4">
                  <SectionHeading icon={<Activity className="w-4 h-4" />}>Summary</SectionHeading>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <KV label="Model" value={modelName} />
                    <KV label="Epochs" value={epochsTotal ?? "—"} />
                    <KV label="Batch size" value={metadata?.training_params?.batch_size ?? metadata?.training_params?.batch ?? "—"} />
                    <KV label="Image size" value={metadata?.training_params?.image_size ?? metadata?.training_params?.imgsz ?? (metadata as any)?.training_config?.image_size ?? metadata?.image_size ?? "—"} />
                    <KV label="Optimizer" value={metadata?.training_params?.optimizer ?? "auto"} />
                    <KV label="Learning rate" value={metadata?.training_params?.lr0 ?? 0.01} />
                    <KV label="Patience" value={metadata?.training_params?.patience ?? 50} />
                    <KV label="Device" value={metadata?.training_params?.device ?? "0"} />
                    {currentBatch && totalBatches && <KV label="Current batch" value={`${currentBatch}/${totalBatches}`} />}
                    {typeof epochProgressPct === 'number' && <KV label="Epoch progress" value={`${epochProgressPct}%`} />}
                    {epochEta && <KV label="Epoch ETA" value={epochEta} />}
                  </div>
                  {enabledAugChips.length > 0 && (
                    <div className="mt-4 pt-3 border-t border-border">
                      <div className="text-xs text-muted-foreground mb-2">Augmentations</div>
                      <div className="flex flex-wrap gap-1.5">
                        {enabledAugChips.map(a => (
                          <Badge key={a} variant="secondary" className="text-xs">{a}</Badge>
                        ))}
                      </div>
                    </div>
                  )}
                  {metadata?.class_names && metadata.class_names.length > 0 && (
                    <div className="mt-4 pt-3 border-t border-border">
                      <div className="text-xs text-muted-foreground mb-2">Classes ({metadata.class_names.length})</div>
                      <div className="flex flex-wrap gap-1.5">
                        {metadata.class_names.slice(0, 16).map((c, i) => (
                          <Badge key={i} variant="outline" className="text-xs">{c}</Badge>
                        ))}
                        {metadata.class_names.length > 16 && (
                          <Badge variant="outline" className="text-xs">+{metadata.class_names.length - 16} more</Badge>
                        )}
                      </div>
                    </div>
                  )}
                </Card>
              </TabsContent>

              {/* METRICS */}
              <TabsContent value="metrics" className="mt-0">
                {metricsHistory.length > 0 ? (
                  <Card className="p-4">
                    <SectionHeading icon={<LineChartIcon className="w-4 h-4" />}>Training progress</SectionHeading>
                    <Suspense
                      fallback={
                        <div className="flex items-center justify-center py-12">
                          <Skeleton className="h-64 w-full" />
                        </div>
                      }
                    >
                      <TrainingMetricsCharts metricsHistory={metricsHistory} />
                    </Suspense>
                  </Card>
                ) : (
                  <Card className="p-8 text-center text-sm text-muted-foreground">
                    No metrics history available yet.
                  </Card>
                )}
              </TabsContent>

              {/* CONFIG */}
              <TabsContent value="config" className="space-y-4 mt-0">
                <div className="flex items-center justify-between">
                  <SectionHeading icon={<Settings className="w-4 h-4" />}>Training configuration</SectionHeading>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowAllSettings(s => !s)}
                    className="h-8"
                  >
                    {showAllSettings ? <ChevronUp className="w-4 h-4 mr-1.5" /> : <ChevronDown className="w-4 h-4 mr-1.5" />}
                    {showAllSettings ? 'Hide advanced' : 'Show all settings'}
                  </Button>
                </div>

                <Card className="p-4">
                  <h4 className="text-xs font-semibold text-muted-foreground mb-3 uppercase tracking-wider">Basic parameters</h4>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                    <KV label="Model" value={modelName} />
                    <KV label="Epochs" value={epochsTotal ?? "—"} />
                    <KV label="Batch size" value={metadata?.training_params?.batch_size ?? metadata?.training_params?.batch ?? "—"} />
                    <KV label="Image size" value={metadata?.training_params?.image_size ?? metadata?.training_params?.imgsz ?? "—"} />
                    <KV label="Device" value={metadata?.training_params?.device ?? "0"} />
                    <KV label="Workers" value={metadata?.training_params?.workers ?? 8} />
                    <KV label="Save period" value={metadata?.training_params?.save_period ?? metadata?.model_config?.save_period ?? "—"} />
                    <KV label="Patience" value={metadata?.training_params?.patience ?? 100} />
                    <KV label="Cache" value={String(metadata?.training_params?.cache ?? false)} />
                  </div>
                </Card>

                {showAllSettings && (
                  <>
                    <Card className="p-4">
                      <h4 className="text-xs font-semibold text-muted-foreground mb-3 uppercase tracking-wider">Optimizer</h4>
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                        <KV label="Optimizer" value={metadata?.training_params?.optimizer ?? "auto"} />
                        <KV label="LR (lr0)" value={metadata?.training_params?.lr0 ?? 0.01} />
                        <KV label="Final LR (lrf)" value={metadata?.training_params?.lrf ?? 0.01} />
                        <KV label="Momentum" value={metadata?.training_params?.momentum ?? 0.937} />
                        <KV label="Weight decay" value={metadata?.training_params?.weight_decay ?? 0.0005} />
                        <KV label="Warmup epochs" value={metadata?.training_params?.warmup_epochs ?? 3} />
                        <KV label="Warmup momentum" value={metadata?.training_params?.warmup_momentum ?? 0.8} />
                        <KV label="Warmup bias LR" value={metadata?.training_params?.warmup_bias_lr ?? 0.1} />
                      </div>
                    </Card>

                    <Card className="p-4">
                      <h4 className="text-xs font-semibold text-muted-foreground mb-3 uppercase tracking-wider">Loss & advanced</h4>
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                        <KV label="Box loss gain" value={metadata?.training_params?.box ?? 7.5} />
                        <KV label="Cls loss gain" value={metadata?.training_params?.cls ?? 0.5} />
                        <KV label="DFL loss gain" value={metadata?.training_params?.dfl ?? 1.5} />
                        <KV label="Label smoothing" value={metadata?.training_params?.label_smoothing ?? 0.0} />
                        <KV label="Dropout" value={metadata?.training_params?.dropout ?? 0.0} />
                        <KV label="Val" value={String(metadata?.training_params?.val ?? true)} />
                      </div>
                    </Card>

                    {augs && (
                      <Card className="p-4">
                        <h4 className="text-xs font-semibold text-muted-foreground mb-3 uppercase tracking-wider">Augmentations</h4>
                        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                          {Object.entries(augs).map(([k, v]) => (
                            <KV key={k} label={k.replace(/_/g, ' ')} value={String(v)} />
                          ))}
                        </div>
                      </Card>
                    )}
                  </>
                )}
              </TabsContent>

              {/* DATASET */}
              <TabsContent value="dataset" className="space-y-4 mt-0">
                {metadata?.dataset_configs && metadata.dataset_configs.length > 0 && (
                  <Card className="p-4">
                    <SectionHeading icon={<Database className="w-4 h-4" />}>Training datasets</SectionHeading>
                    <div className="space-y-2">
                      {metadata.dataset_configs.map((c, i) => (
                        <div key={i} className="rounded-md border border-border bg-muted/30 p-3">
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <KV label="Dataset" value={`#${c.dataset_id}${c.dataset_name ? ` · ${c.dataset_name}` : ''}`} />
                            <KV label="Annotation file" value={<span className="font-mono text-xs text-primary">{c.annotation_file_name || c.annotation_file_id}</span>} />
                            {c.image_collection && <KV label="Image collection" value={c.image_collection} />}
                            {c.split && <KV label="Split" value={`Train ${c.split.train}% · Val ${c.split.val}% · Test ${c.split.test}%`} />}
                          </div>
                        </div>
                      ))}
                    </div>
                  </Card>
                )}

                {metadata?.image_counts && (
                  <Card className="p-4">
                    <SectionHeading icon={<LayoutGrid className="w-4 h-4" />}>Dataset split</SectionHeading>
                    <div className="grid grid-cols-3 gap-3">
                      {(['train', 'val', 'test'] as const).map(k => (
                        <div key={k} className="rounded-md bg-muted/30 p-3 text-center">
                          <div className="text-2xl font-semibold text-foreground tabular-nums">
                            {metadata.image_counts?.[k] ?? 0}
                          </div>
                          <div className="text-xs uppercase tracking-wider text-muted-foreground mt-1">{k}</div>
                        </div>
                      ))}
                    </div>
                  </Card>
                )}

                {metadata?.dataset_stats && (
                  <Card className="p-4">
                    <SectionHeading icon={<Activity className="w-4 h-4" />}>Dataset statistics</SectionHeading>
                    {metadata.dataset_stats.total_images && (
                      <div className="mb-4">
                        <div className="text-xs text-muted-foreground mb-2">Images per split</div>
                        <div className="grid grid-cols-3 gap-3">
                          {(['train', 'val', 'test'] as const).map(k => (
                            <div key={k} className="rounded-md bg-muted/30 p-3 text-center">
                              <div className="text-xl font-semibold tabular-nums text-foreground">
                                {metadata.dataset_stats?.total_images?.[k] ?? 0}
                              </div>
                              <div className="text-xs text-muted-foreground mt-1 capitalize">{k}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {metadata.dataset_stats.total_annotations && (
                      <div className="mb-4">
                        <div className="text-xs text-muted-foreground mb-2">Annotations per split</div>
                        <div className="grid grid-cols-3 gap-3">
                          {(['train', 'val', 'test'] as const).map(k => (
                            <div key={k} className="rounded-md bg-muted/30 p-3 text-center">
                              <div className="text-xl font-semibold tabular-nums text-foreground">
                                {metadata.dataset_stats?.total_annotations?.[k] ?? 0}
                              </div>
                              <div className="text-xs text-muted-foreground mt-1 capitalize">{k}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {(metadata.dataset_stats.images_processed !== undefined || metadata.dataset_stats.images_filtered !== undefined) && (
                      <div className="grid grid-cols-2 gap-4 pt-3 border-t border-border">
                        {metadata.dataset_stats.images_processed !== undefined && <KV label="Images processed" value={metadata.dataset_stats.images_processed} />}
                        {metadata.dataset_stats.images_filtered !== undefined && <KV label="Images filtered" value={metadata.dataset_stats.images_filtered} />}
                      </div>
                    )}
                    {metadata.dataset_stats.annotations_per_class && Object.keys(metadata.dataset_stats.annotations_per_class).length > 0 && (
                      <div className="mt-4">
                        <div className="text-xs text-muted-foreground mb-2">Annotations per class</div>
                        <div className="rounded-md bg-muted/20 p-3 max-h-48 overflow-y-auto space-y-1 text-sm">
                          {Object.entries(metadata.dataset_stats.annotations_per_class).map(([cls, counts]) => (
                            <div key={cls} className="flex justify-between items-center">
                              <span className="text-foreground">{cls}</span>
                              <span className="text-muted-foreground tabular-nums text-xs">
                                T {(counts as any).train} · V {(counts as any).val} · Te {(counts as any).test || 0}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </Card>
                )}

                {metadata?.example_images && Object.keys(metadata.example_images).length > 0 && (
                  <Card className="p-4">
                    <SectionHeading icon={<Images className="w-4 h-4" />}>Training examples</SectionHeading>
                    <TrainingExamplesGallery
                      taskId={taskId}
                      exampleImages={metadata.example_images}
                      imageCounts={metadata.image_counts}
                    />
                  </Card>
                )}
              </TabsContent>

              {/* ARTIFACTS */}
              <TabsContent value="artifacts" className="space-y-4 mt-0">
                <Card className="p-4">
                  <SectionHeading icon={<FileBox className="w-4 h-4" />}>Output files</SectionHeading>
                  {metadata?.best_model || metadata?.results_dir ? (
                    <div className="space-y-3">
                      {metadata?.best_model && (
                        <div>
                          <div className="text-xs text-muted-foreground mb-1">Best model</div>
                          <code className="block text-xs text-primary bg-muted/40 px-2 py-1.5 rounded break-all">{metadata.best_model}</code>
                        </div>
                      )}
                      {metadata?.results_dir && (
                        <div>
                          <div className="text-xs text-muted-foreground mb-1">Results directory</div>
                          <code className="block text-xs text-primary bg-muted/40 px-2 py-1.5 rounded break-all">{metadata.results_dir}</code>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="text-sm text-muted-foreground">No output files available yet.</div>
                  )}
                </Card>
              </TabsContent>
            </Tabs>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
