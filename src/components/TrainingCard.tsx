import React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  CopyPlus,
  Download,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  RotateCw,
  TestTube,
  Trash2,
  X,
} from "lucide-react";

const STATUS_BORDER: Record<string, string> = {
  completed: "border-l-green-500",
  running: "border-l-blue-500",
  pending: "border-l-gray-500",
  failed: "border-l-red-500",
  stopped: "border-l-amber-500",
  cancelled: "border-l-amber-500",
  paused: "border-l-yellow-500",
};

const STATUS_PILL: Record<string, string> = {
  completed: "bg-green-500/15 text-green-400 border border-green-500/30",
  running: "bg-blue-500/15 text-blue-400 border border-blue-500/30",
  pending: "bg-gray-500/15 text-gray-400 border border-gray-500/30",
  failed: "bg-red-500/15 text-red-400 border border-red-500/30",
  stopped: "bg-amber-500/15 text-amber-400 border border-amber-500/30",
  cancelled: "bg-amber-500/15 text-amber-400 border border-amber-500/30",
  paused: "bg-yellow-500/15 text-yellow-400 border border-yellow-500/30",
};

const STATUS_LABEL: Record<string, string> = {
  completed: "Completed",
  running: "Running",
  pending: "Pending",
  failed: "Failed",
  stopped: "Stopped",
  cancelled: "Cancelled",
  paused: "Paused",
};

/** Merge metrics from Ultralytics/tensorboard-shaped dicts and epoch snapshots. */
function asFiniteNumberRecord(obj: unknown): Record<string, number> {
  if (!obj || typeof obj !== "object") return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

function pickFirst(metrics: Record<string, number>, keys: string[]): number | null {
  for (const k of keys) {
    const v = metrics[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

function pickByKeyRegex(metrics: Record<string, number>, regex: RegExp): number | null {
  for (const k of Object.keys(metrics)) {
    const low = k.toLowerCase();
    if (regex.test(low)) {
      const v = metrics[k];
      if (typeof v === "number" && Number.isFinite(v)) return v;
    }
  }
  return null;
}

type TrainingTiles =
  | { mode: "map"; map50: number | null; map5095: number | null }
  | { mode: "classify"; top1: number | null; top5: number | null }
  | { mode: "empty" };

function resolveTrainingTiles(metadata: Record<string, unknown>, modelYaml: string): TrainingTiles {
  const resultsBlock = metadata.results as { metrics?: unknown } | undefined;
  const tensorboard = asFiniteNumberRecord(resultsBlock?.metrics);
  const latest = asFiniteNumberRecord(metadata.latest_metrics);
  const hist = metadata.metrics_history;
  const lastEpoch =
    Array.isArray(hist) && hist.length > 0
      ? asFiniteNumberRecord(hist[hist.length - 1])
      : {};

  const m = { ...lastEpoch, ...latest, ...tensorboard };

  const model = (modelYaml || "").toLowerCase();
  const isClsModel =
    model.includes("-cls") || model.includes("cls.") || /\.cls\b/.test(model);

  if (isClsModel) {
    const top1 =
      pickFirst(m, [
        "metrics/accuracy/top1",
        "metrics/top1_acc",
        "top1_acc",
        "accuracy_top1",
        "accuracy",
      ]) ??
      pickByKeyRegex(m, /top[-_]?1|accuracy\(top\s*1\)|accuracy_top1/) ??
      pickByKeyRegex(m, /metrics\/accuracy/);
    const top5 =
      pickFirst(m, ["metrics/accuracy/top5", "metrics/top5_acc", "top5_acc", "accuracy_top5"]) ??
      pickByKeyRegex(m, /top[-_]?5|accuracy\(top\s*5\)|accuracy_top5/);
    return { mode: "classify", top1, top5 };
  }

  const map50Seg =
    pickFirst(m, ["metrics/mAP50(M)", "metrics/mAP50(Mask)", "mAP50(M)", "masks/mAP50"]) ??
    pickByKeyRegex(m, /map50\(m\)|map@[\w.:-]*50.*\(m\)|\/map50\(m\)/);
  const map5095Seg =
    pickFirst(m, ["metrics/mAP50-95(M)", "metrics/mAP50-95(Mask)", "mAP50_95(M)"]) ??
    pickByKeyRegex(m, /map50-95\(m\)|map@[\w.:-]*50-95.*\(m\)/);

  const map50Box =
    pickFirst(m, [
      "metrics/mAP50(B)",
      "metrics/mAP50",
      "mAP50",
      "mAP50(B)",
      "boxes/mAP50",
    ]) ?? pickByKeyRegex(m, /map50\(b\)/);
  const map5095Box =
    pickFirst(m, ["metrics/mAP50-95(B)", "metrics/mAP50-95", "mAP50_95", "mAP50-95(B)", "boxes/mAP50-95"]) ??
    pickByKeyRegex(m, /map50-95\(b\)/);

  const preferSeg =
    model.includes("-seg") || model.includes("-segment") || model.includes("segmentation");

  const map50 = preferSeg ? map50Seg ?? map50Box : map50Box ?? map50Seg;
  const map5095 = preferSeg ? map5095Seg ?? map5095Box : map5095Box ?? map5095Seg;

  if (map50 != null || map5095 != null) {
    return { mode: "map", map50, map5095 };
  }

  return { mode: "empty" };
}

function metricColor(v: number): string {
  if (v >= 0.85) return "text-green-400";
  if (v >= 0.6) return "text-amber-400";
  return "text-red-400";
}

function timeAgo(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso).getTime();
  const diff = Date.now() - d;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
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

function MetricTile({
  label,
  value,
  format = "pct",
}: {
  label: string;
  value: number | null;
  format?: "pct" | "raw";
}) {
  const display =
    value === null
      ? "—"
      : format === "pct"
      ? `${(value * 100).toFixed(1)}%`
      : value.toFixed(3);
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
        {label}
      </span>
      <span
        className={`text-2xl font-semibold tabular-nums leading-tight ${
          value === null ? "text-muted-foreground" : metricColor(value)
        }`}
      >
        {display}
      </span>
    </div>
  );
}

export interface TrainingCardProps {
  task: any;
  modelFamily: string;
  modelSize: string;
  onOpen?: () => void;
  onRename?: () => void;
  /** Open new training form pre-filled from this task (does not start training). */
  onDuplicateSettings?: () => void;
  onRerun?: () => void;
  onDelete?: () => void;
  onTestInference?: () => void;
  onDownload?: () => void;
  onStop?: () => void;
  onPause?: () => void;
  onResume?: () => void;
  onShowError?: () => void;
}

export function TrainingCard({
  task,
  modelFamily,
  modelSize,
  onOpen,
  onRename,
  onDuplicateSettings,
  onRerun,
  onDelete,
  onTestInference,
  onDownload,
  onStop,
  onPause,
  onResume,
  onShowError,
}: TrainingCardProps) {
  const metadata = task.task_metadata || {};
  const status = task.status as string;
  const isRunning = status === "running";
  const isCompleted = status === "completed";
  const isFailed = status === "failed";
  const isStopped = status === "stopped" || status === "cancelled";
  const isPaused = status === "paused";
  const isPending = status === "pending";
  const showProgress = isRunning || isPending || isPaused;
  const canRerun = isCompleted || isFailed || isStopped;
  const totalEpochs = metadata.total_epochs || metadata.epochs || metadata.training_params?.epochs;
  const currentBatch = metadata.current_batch;
  const totalBatches = metadata.total_batches;
  const epochProgressPct = metadata.epoch_progress_pct;
  const epochEta = formatEpochEta(metadata.epoch_eta_seconds);
  const isPauseRequested = isRunning && metadata.stage === "pause_requested";

  const epochsDisplay = (() => {
    if (isRunning && metadata.current_epoch && totalEpochs) {
      return `${metadata.current_epoch} / ${totalEpochs}`;
    }
    if ((isCompleted || isFailed || isStopped) && metadata.current_epoch) {
      return String(metadata.current_epoch);
    }
    if (metadata.training_params?.epochs || metadata.epochs) {
      return String(metadata.training_params?.epochs || metadata.epochs);
    }
    return null;
  })();

  const modelYaml =
    metadata.model_config?.model ||
    metadata.model_type ||
    task?.training_config?.model_type ||
    "";
  const tiles = resolveTrainingTiles(metadata as Record<string, unknown>, modelYaml);

  return (
    <div
      onClick={onOpen}
      className={`group relative rounded-lg border border-border bg-card text-card-foreground border-l-4 ${
        STATUS_BORDER[status] ?? "border-l-gray-500"
      } cursor-pointer hover:border-primary/40 transition-colors`}
    >
      <div className="p-5">
        <div className="flex items-start gap-4">
          {/* Left: identity */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-base font-semibold truncate" title={task.name}>
                {task.name}
              </h3>
              {isFailed && onShowError ? (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onShowError();
                  }}
                  className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium hover:opacity-80 transition-opacity ${
                    STATUS_PILL[status] ?? STATUS_PILL.pending
                  }`}
                >
                  {STATUS_LABEL[status]}
                </button>
              ) : (
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                    STATUS_PILL[status] ?? STATUS_PILL.pending
                  }`}
                >
                  {STATUS_LABEL[status] ?? status}
                </span>
              )}
              <Badge variant="outline" className="text-xs">
                {modelFamily}
              </Badge>
              {modelSize !== "-" && (
                <Badge variant="outline" className="text-xs">
                  {modelSize}
                </Badge>
              )}
            </div>
            <div className="mt-1 text-sm text-muted-foreground flex items-center gap-3 flex-wrap">
              <span className="font-medium text-foreground/80">
                {metadata.model_config?.model || metadata.model_type || "—"}
              </span>
              <span>·</span>
              <span>#{task.id}</span>
              <span>·</span>
              <span title={task.created_at}>{timeAgo(task.created_at)}</span>
              {epochsDisplay && (
                <>
                  <span>·</span>
                  <span>{epochsDisplay} epochs</span>
                </>
              )}
            </div>

            {showProgress && (
              <div className="mt-3">
                <div className="flex items-center gap-3">
                  <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                    <div
                      className={`h-full transition-all ${
                        isFailed
                          ? "bg-red-500"
                          : isCompleted
                          ? "bg-green-500"
                          : "bg-blue-500"
                      }`}
                      style={{ width: `${task.progress || 0}%` }}
                    />
                  </div>
                  <span className="text-xs text-muted-foreground tabular-nums w-10 text-right">
                    {task.progress || 0}%
                  </span>
                </div>
                {(metadata.current_epoch || currentBatch || isPauseRequested) && (
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    {metadata.current_epoch && totalEpochs && (
                      <span>Epoch {metadata.current_epoch}/{totalEpochs}</span>
                    )}
                    {currentBatch && totalBatches && (
                      <span>Batch {currentBatch}/{totalBatches}</span>
                    )}
                    {typeof epochProgressPct === "number" && (
                      <span>{epochProgressPct}% of current epoch</span>
                    )}
                    {epochEta && <span>~{epochEta} left in epoch</span>}
                    {isPauseRequested && (
                      <span className="text-yellow-400">Pause requested</span>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Middle: validation metrics — detection/segmentation: mAP; classification: top-k acc */}
          <div className="hidden md:grid grid-cols-2 gap-6 px-2">
            {tiles.mode === "map" ? (
              <>
                <MetricTile label="mAP@50" value={tiles.map50} />
                <MetricTile label="mAP@50–95" value={tiles.map5095} />
              </>
            ) : tiles.mode === "classify" ? (
              <>
                <MetricTile label="Top-1 acc" value={tiles.top1} />
                <MetricTile label="Top-5 acc" value={tiles.top5} />
              </>
            ) : (
              <>
                <MetricTile label="mAP@50" value={null} />
                <MetricTile label="mAP@50–95" value={null} />
              </>
            )}
          </div>

          {/* Right: actions */}
          <div
            className="flex items-center gap-2 shrink-0"
            onClick={(e) => e.stopPropagation()}
          >
            {canRerun && onRerun && (
              <Button variant="outline" size="sm" onClick={onRerun} className="h-8">
                <RotateCw className="w-3.5 h-3.5 mr-1.5" />
                Rerun
              </Button>
            )}
            {isPaused && onResume && (
              <Button
                variant="outline"
                size="sm"
                onClick={onResume}
                className="h-8 text-green-400 hover:text-green-300"
                title="Resume training from last checkpoint"
              >
                <Play className="w-3.5 h-3.5 mr-1.5" />
                Resume
              </Button>
            )}
            {isCompleted && onTestInference && (
              <Button
                variant="outline"
                size="sm"
                onClick={onTestInference}
                className="h-8"
                title="Test inference"
              >
                <TestTube className="w-3.5 h-3.5 mr-1.5" />
                Test
              </Button>
            )}
            {(isRunning || isPending) && onPause && (
              <Button
                variant="outline"
                size="sm"
                onClick={onPause}
                className="h-8 text-yellow-400 hover:text-yellow-300"
                title="Pause training (saves checkpoint)"
              >
                <Pause className="w-3.5 h-3.5 mr-1.5" />
                Pause
              </Button>
            )}
            {(isRunning || isPending) && onStop && (
              <Button
                variant="outline"
                size="sm"
                onClick={onStop}
                className="h-8 text-red-400 hover:text-red-300"
                title="Stop training"
              >
                <X className="w-3.5 h-3.5 mr-1.5" />
                Stop
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8">
                  <MoreHorizontal className="w-4 h-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                {isCompleted && onDownload && (
                  <DropdownMenuItem onClick={onDownload}>
                    <Download className="w-4 h-4 mr-2" />
                    Download model
                  </DropdownMenuItem>
                )}
                {onRename && (
                  <DropdownMenuItem onClick={onRename}>
                    <Pencil className="w-4 h-4 mr-2" />
                    Rename
                  </DropdownMenuItem>
                )}
                {onDuplicateSettings && (
                  <DropdownMenuItem onClick={onDuplicateSettings}>
                    <CopyPlus className="w-4 h-4 mr-2" />
                    Create new with same settings
                  </DropdownMenuItem>
                )}
                {onDelete && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={onDelete}
                      className="text-destructive focus:text-destructive"
                    >
                      <Trash2 className="w-4 h-4 mr-2" />
                      Delete
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* Mobile metrics */}
        <div className="mt-4 grid grid-cols-2 gap-4 md:hidden">
          {tiles.mode === "map" ? (
            <>
              <MetricTile label="mAP@50" value={tiles.map50} />
              <MetricTile label="mAP@50–95" value={tiles.map5095} />
            </>
          ) : tiles.mode === "classify" ? (
            <>
              <MetricTile label="Top-1 acc" value={tiles.top1} />
              <MetricTile label="Top-5 acc" value={tiles.top5} />
            </>
          ) : (
            <>
              <MetricTile label="mAP@50" value={null} />
              <MetricTile label="mAP@50–95" value={null} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
