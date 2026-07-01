import React, { useMemo, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Search,
  ChevronRight,
  ChevronDown,
  Folder,
  Database,
  ImageIcon,
  X,
  Rows3,
  LayoutList,
  LayoutGrid,
  AlertTriangle,
  Eye,
  EyeOff,
  FileWarning,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { resolveBackendMediaUrl } from "@/config/api";
import {
  ANNOTATION_TYPE_SHORT_LABELS,
  annotationFileSupportsTrainingTask,
  detectAnnotationDisplayType,
  type AnnotationDisplayType,
  type TrainingAnnotationTaskType,
} from "@/utils/annotations";

// ── Types exposed to caller ────────────────────────────────────────────────
export interface PickerAnnotationFile {
  id: string;
  name: string;
  classes: string[];
  taskType?: "detection" | "segmentation" | "classification";
  /** Resolved display type for filtering (Boxes / Masks / Masks + Boxes). */
  annotationType?: AnnotationDisplayType;
  modifiedAt?: string;
  annotationCount?: number;
}

export interface PickerCollection {
  id: string;
  name: string;
  isDefault?: boolean;
  imageCount?: number;
}

export interface PickerDataset {
  id: number;
  name: string;
  description?: string;
  imageCount: number;
  annotationFileCount?: number;
  thumbnailUrl?: string;
  annotationFiles: PickerAnnotationFile[];
  collections: PickerCollection[];
  lastUsedAt?: string;
  tags?: string[];
}

export interface PickerGroup {
  id: number;
  name: string;
  datasetIds: number[];
}

export interface DatasetSelection {
  datasetId: number;
  annotationFileId: string | null;
  collectionId: string | null;
}

export type RequiredTaskType =
  | "detection"
  | "segmentation"
  | "classification"
  | "oriented";

export type DatasetPickerMode = "train" | "evaluate" | "augment";

interface Props {
  datasets: PickerDataset[];
  groups?: PickerGroup[];
  modelClasses: string[];
  modelTaskType?: "detection" | "segmentation" | "classification";
  /**
    * train: hide datasets without annotation files; optionally filter by requiredTaskType.
    * evaluate/augment: show all datasets with images.
   */
  pickerMode?: DatasetPickerMode;
  /**
   * Require selecting an annotation file per selected dataset.
   * Defaults to true for train mode and false for evaluate/augment.
   */
  requireAnnotationSelection?: boolean;
  /**
   * When set (train mode), datasets without compatible annotation files are dimmed and
   * cannot be selected. Datasets with zero annotation files are always hidden.
   * "oriented" is treated as "detection" for compatibility (rotated boxes).
   */
  requiredTaskType?: RequiredTaskType;
  value: DatasetSelection[];
  onChange: (next: DatasetSelection[]) => void;
  /** Optional extra content rendered at the bottom of each expanded dataset row. */
  renderExpandedExtra?: (sel: DatasetSelection, d: PickerDataset) => React.ReactNode;
}

// ── Task type styling ──────────────────────────────────────────────────────
const taskTypeStyles: Record<string, string> = {
  detection: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30",
  segmentation: "bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/30",
  classification: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
};
const taskTypeShort: Record<string, string> = {
  detection: "det",
  segmentation: "seg",
  classification: "cls",
};

// ── Component ──────────────────────────────────────────────────────────────
export function DatasetEvalPicker({
  datasets,
  groups = [],
  value,
  onChange,
  renderExpandedExtra,
  pickerMode = "train",
  requireAnnotationSelection,
  requiredTaskType,
}: Props) {
  const isTrainMode = pickerMode === "train";
  const isEvaluateMode = pickerMode === "evaluate";
  const requiresAnnotationSelection =
    requireAnnotationSelection ?? isTrainMode;
  const { toast } = useToast();
  const [query, setQuery] = useState("");
  const [activeTags, setActiveTags] = useState<Set<string>>(new Set());
  const [density, setDensity] = useState<"comfortable" | "dense" | "grid">("comfortable");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [openGroups, setOpenGroups] = useState<Set<number>>(
    new Set(groups.map((g) => g.id))
  );
  const [showIncompatible, setShowIncompatible] = useState(false);
  const [openSection, setOpenSection] = useState<Record<"compatible" | "incompatible" | "empty", boolean>>({
    compatible: true,
    incompatible: false,
    empty: false,
  });

  const selectionMap = useMemo(() => {
    const m = new Map<number, DatasetSelection>();
    value.forEach((s) => m.set(s.datasetId, s));
    return m;
  }, [value]);

  const datasetMap = useMemo(() => {
    const m = new Map<number, PickerDataset>();
    datasets.forEach((d) => m.set(d.id, d));
    return m;
  }, [datasets]);

  // collect all unique tags across datasets
  const allTags = useMemo(() => {
    const set = new Set<string>();
    datasets.forEach((d) => d.tags?.forEach((t) => set.add(t)));
    return Array.from(set).sort();
  }, [datasets]);

  // "oriented" boxes train on bbox annotation files (rotated boxes are a det variant)
  const compatTaskType: TrainingAnnotationTaskType | undefined =
    requiredTaskType === "oriented" ? "detection" : requiredTaskType;

  function compatibleAnnotationFiles(d: PickerDataset): PickerAnnotationFile[] {
    if (!isTrainMode || !compatTaskType) return d.annotationFiles;
    return d.annotationFiles.filter((f) =>
      annotationFileSupportsTrainingTask(
        {
          name: f.name,
          annotationType: f.annotationType,
          type: f.taskType,
        },
        compatTaskType,
      ),
    );
  }

  function groundTruthFileCount(d: PickerDataset): number {
    if (d.annotationFiles.length > 0) return d.annotationFiles.length;
    return d.annotationFileCount ?? 0;
  }

  function hasAnyFiles(d: PickerDataset) {
    if (d.imageCount <= 0) return false;
    if (!isTrainMode) return true;
    if (groundTruthFileCount(d) <= 0) return false;
    // Files not loaded yet — trust annotation_file_count from list API.
    if (d.annotationFiles.length === 0) return true;
    return compatibleAnnotationFiles(d).length > 0;
  }

  /** Returns 'match' | 'mismatch' | 'unknown' for the dataset vs requiredTaskType. */
  function taskCompatibility(d: PickerDataset): "match" | "mismatch" | "unknown" {
    if (!isTrainMode || !compatTaskType) return "match";
    const files = d.annotationFiles;
    // Lazy/back-end-only counts → we don't know types yet, allow selection.
    if (files.length === 0) return "unknown";
    const compatible = compatibleAnnotationFiles(d);
    if (compatible.length > 0) return "match";
    const knownTypes = files
      .map((f) =>
        f.annotationType ??
        detectAnnotationDisplayType({
          type: f.taskType,
          name: f.name,
        } as Parameters<typeof detectAnnotationDisplayType>[0]),
      )
      .filter((t) => t && t !== "Other");
    if (knownTypes.length === 0) return "unknown";
    return "mismatch";
  }

  function visible(d: PickerDataset) {
    if (d.imageCount <= 0 && isTrainMode) return false;
    if (query && !d.name.toLowerCase().includes(query.toLowerCase()))
      return false;
    if (activeTags.size > 0) {
      const tags = new Set(d.tags ?? []);
      for (const t of activeTags) if (!tags.has(t)) return false;
    }
    return true;
  }

  function isUsable(d: PickerDataset) {
    if (!hasAnyFiles(d)) return false;
    if (taskCompatibility(d) === "mismatch") return false;
    return true;
  }

  /** Bucket a list of datasets by compatibility with the current task. */
  function bucketByCompat(list: PickerDataset[]): {
    compatible: PickerDataset[];
    incompatible: PickerDataset[];
    empty: PickerDataset[];
  } {
    const compatible: PickerDataset[] = [];
    const incompatible: PickerDataset[] = [];
    const empty: PickerDataset[] = [];
    for (const d of list) {
      const files = groundTruthFileCount(d);
      if (files <= 0) {
        empty.push(d);
        continue;
      }
      if (!isTrainMode || !compatTaskType) {
        compatible.push(d);
        continue;
      }
      const compat = taskCompatibility(d);
      if (compat === "mismatch") incompatible.push(d);
      else compatible.push(d);
    }
    return { compatible, incompatible, empty };
  }

  function toggleTag(t: string) {
    setActiveTags((s) => {
      const n = new Set(s);
      n.has(t) ? n.delete(t) : n.add(t);
      return n;
    });
  }

  const groupedIds = new Set<number>(groups.flatMap((g) => g.datasetIds));
  const ungrouped = datasets.filter((d) => !groupedIds.has(d.id) && visible(d));
  const ungroupedBuckets = bucketByCompat(ungrouped);

  const recent = [...ungroupedBuckets.compatible]
    .filter((d) => d.lastUsedAt)
    .sort(
      (a, b) =>
        new Date(b.lastUsedAt!).getTime() - new Date(a.lastUsedAt!).getTime()
    )
    .slice(0, 3);
  const recentIds = new Set(recent.map((d) => d.id));
  const compatibleOthers = ungroupedBuckets.compatible.filter((d) => !recentIds.has(d.id));
  const incompatibleOthers = ungroupedBuckets.incompatible;
  const emptyOthers = ungroupedBuckets.empty;

  function toggleSelected(d: PickerDataset, checked: boolean) {
    if (checked) {
      // Block selecting datasets known to be incompatible with the chosen task.
      if (taskCompatibility(d) === "mismatch") return;
      // Prefer a compatible annotation file for the required task; otherwise latest.
      const compatibleFiles = compatibleAnnotationFiles(d);
      const filesSorted = [...compatibleFiles].sort((a, b) => {
        if (!a.modifiedAt && !b.modifiedAt) return 0;
        if (!a.modifiedAt) return 1;
        if (!b.modifiedAt) return -1;
        return new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime();
      });
      const latestFile = filesSorted[0];
      const coll = d.collections[0];
      onChange([
        ...value,
        {
          datasetId: d.id,
          annotationFileId: requiresAnnotationSelection
            ? (latestFile?.id ?? null)
            : null,
          collectionId: coll?.id ?? null,
        },
      ]);
      if (density === "comfortable") setExpanded((s) => new Set(s).add(d.id));
    } else {
      onChange(value.filter((s) => s.datasetId !== d.id));
    }
  }

  function updateSel(datasetId: number, patch: Partial<DatasetSelection>) {
    onChange(
      value.map((s) => (s.datasetId === datasetId ? { ...s, ...patch } : s))
    );
  }

  function DatasetRow({ d }: { d: PickerDataset }) {
    const sel = selectionMap.get(d.id);
    const isSelected = !!sel;
    const isExpanded = expanded.has(d.id);
    const usable = isUsable(d);
    const isDense = density === "dense";
    const compat = taskCompatibility(d);
    const incompatible = compat === "mismatch";
    const incompatReason = incompatible && compatTaskType
      ? `No ${compatTaskType} annotations in this dataset — not usable for the selected task.`
      : undefined;

    const annotationFileCount = isTrainMode
      ? compatibleAnnotationFiles(d).length
      : groundTruthFileCount(d);
    const visibleAnnotationFiles = compatibleAnnotationFiles(d);
    const taskType = visibleAnnotationFiles[0]?.taskType;
    const thumbSrc = resolveBackendMediaUrl(d.thumbnailUrl);

    return (
      <div
        title={incompatReason}
        className={cn(
          "group rounded-lg border bg-card transition-all duration-150",
          "hover:border-border hover:shadow-sm",
          !isDense && "hover:-translate-y-[1px]",
          isSelected
            ? "border-primary/60 bg-primary/[0.04] shadow-[0_0_0_1px_oklch(var(--primary)/0.25)]"
            : "border-border/60",
          !usable && !isSelected && "opacity-55 hover:opacity-90",
          incompatible && !isSelected && "opacity-40 grayscale"
        )}
      >
        <div
          className={cn(
            "flex items-center gap-3 px-3",
            isDense ? "py-1.5" : "items-start py-2.5"
          )}
        >
          <Checkbox
            checked={isSelected}
            disabled={incompatible && !isSelected}
            onCheckedChange={(c) => toggleSelected(d, !!c)}
            className={cn(!isDense && "mt-1.5")}
          />

          {!isDense && (
            <div className="h-12 w-12 shrink-0 rounded-md bg-muted overflow-hidden flex items-center justify-center ring-1 ring-border/40">
              {thumbSrc ? (
                <img src={thumbSrc} alt="" className="h-full w-full object-cover" loading="lazy" />
              ) : (
                <ImageIcon className="h-5 w-5 text-muted-foreground" />
              )}
            </div>
          )}

          <button
            type="button"
            className="flex-1 min-w-0 text-left"
            onClick={() => {
              if (isSelected) {
                setExpanded((s) => {
                  const n = new Set(s);
                  n.has(d.id) ? n.delete(d.id) : n.add(d.id);
                  return n;
                });
              } else {
                toggleSelected(d, true);
              }
            }}
          >
            <div className="flex items-center gap-2 min-w-0 flex-wrap">
              <span className="font-semibold text-sm truncate">{d.name}</span>
              {d.description && (
                <span className="text-xs text-muted-foreground truncate max-w-[200px]" title={d.description}>
                  {d.description}
                </span>
              )}
              {/* Annotation-file type pill stack — surfaces 1:N relationship at a glance */}
              {d.annotationFiles.length > 0 && (() => {
                const typeCounts = new Map<string, number>();
                d.annotationFiles.forEach((f) => {
                  const t = f.taskType ?? "other";
                  typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
                });
                return (
                  <div className="inline-flex items-center gap-0.5" title={`${d.annotationFiles.length} annotation file(s)`}>
                    {Array.from(typeCounts.entries()).map(([t, n]) => (
                      <span
                        key={t}
                        className={cn(
                          "inline-flex items-center rounded-md border px-1.5 py-0 text-[10px] font-semibold uppercase tracking-wide",
                          taskTypeStyles[t] ?? "bg-muted text-muted-foreground border-border"
                        )}
                      >
                        {taskTypeShort[t] ?? t}
                        {n > 1 && <span className="ml-0.5 opacity-70">×{n}</span>}
                      </span>
                    ))}
                  </div>
                );
              })()}
              {d.annotationFiles.length === 0 && (
                <span className="inline-flex items-center rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400 px-1.5 py-0 text-[10px] font-medium">
                  no annotations
                </span>
              )}
              {isDense && d.tags && d.tags.length > 0 && (
                <div className="flex items-center gap-1 flex-wrap">
                  {d.tags.slice(0, 4).map((t) => (
                    <span
                      key={t}
                      className="inline-flex items-center gap-1 rounded-full bg-primary/10 text-primary border border-primary/20 px-1.5 py-0 text-[10px] font-medium"
                    >
                      {t}
                    </span>
                  ))}
                  {d.tags.length > 4 && (
                    <span className="text-[10px] text-muted-foreground font-medium">
                      +{d.tags.length - 4}
                    </span>
                  )}
                </div>
              )}
            </div>
            <div
              className={cn(
                "text-xs text-muted-foreground flex items-center gap-3",
                isDense ? "mt-0" : "mt-1"
              )}
            >
              <span className="inline-flex items-center gap-1">
                <ImageIcon className="h-3 w-3" />
                {d.imageCount.toLocaleString()}
              </span>
              <span className="inline-flex items-center gap-1">
                <Database className="h-3 w-3" />
                {annotationFileCount} files
              </span>
              {d.lastUsedAt && !isDense && (
                <span className="text-muted-foreground/70">
                  · {timeAgo(d.lastUsedAt)}
                </span>
              )}
            </div>
            {!isDense && d.tags && d.tags.length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap mt-2">
                {d.tags.slice(0, 5).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleTag(t);
                    }}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors",
                      activeTags.has(t)
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-primary/10 text-primary border-primary/20 hover:bg-primary/20"
                    )}
                  >
                    <span
                      className={cn(
                        "h-1.5 w-1.5 rounded-full",
                        activeTags.has(t) ? "bg-primary-foreground" : "bg-primary/70"
                      )}
                    />
                    {t}
                  </button>
                ))}
                {d.tags.length > 5 && (
                  <span className="text-[11px] text-muted-foreground font-medium">
                    +{d.tags.length - 5}
                  </span>
                )}
              </div>
            )}
          </button>

          {isSelected && (
            <button
              type="button"
              onClick={() =>
                setExpanded((s) => {
                  const n = new Set(s);
                  n.has(d.id) ? n.delete(d.id) : n.add(d.id);
                  return n;
                })
              }
              className="text-muted-foreground hover:text-foreground"
              aria-label={isExpanded ? "Collapse" : "Expand"}
            >
              {isExpanded ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
            </button>
          )}
        </div>

        {isSelected && isExpanded && (
          <div className="border-t border-border/60 px-3 py-3 space-y-3 bg-muted/30">
            <div className={cn("grid gap-3", requiresAnnotationSelection ? "grid-cols-1 md:grid-cols-2" : "grid-cols-1")}>
            {requiresAnnotationSelection && (
            <div className="space-y-1">
              <label className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                Annotation file
              </label>
              <Select
                value={sel?.annotationFileId ?? "none"}
                onValueChange={(v) =>
                  updateSel(d.id, {
                    annotationFileId: v === "none" ? null : v,
                  })
                }
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="Pick annotation file" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No annotation file</SelectItem>
                  {visibleAnnotationFiles.map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      <div className="flex items-center gap-2">
                        <span>{f.name}</span>
                        {(f.annotationType || f.taskType) && (
                          <span className="text-[10px] text-muted-foreground">
                            (
                            {f.annotationType
                              ? ANNOTATION_TYPE_SHORT_LABELS[f.annotationType]
                              : f.taskType}
                            )
                          </span>
                        )}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            )}

            <div className="space-y-1">
              <label className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                Image collection
              </label>
              <Select
                value={sel?.collectionId ?? ""}
                onValueChange={(v) => updateSel(d.id, { collectionId: v })}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="Pick collection" />
                </SelectTrigger>
                <SelectContent>
                  {d.collections.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                      {c.isDefault ? " (default)" : ""}
                      {c.imageCount != null && (
                        <span className="text-[10px] text-muted-foreground ml-1">
                          · {c.imageCount} imgs
                        </span>
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            </div>
            {renderExpandedExtra && sel && renderExpandedExtra(sel, d)}
          </div>
        )}
      </div>
    );
  }

  const totalImages = value.reduce((sum, s) => {
    const d = datasetMap.get(s.datasetId);
    return sum + (d?.imageCount ?? 0);
  }, 0);

  const selectedDatasets = value
    .map((s) => datasetMap.get(s.datasetId))
    .filter(Boolean) as PickerDataset[];

  return (
    <div className="rounded-lg border border-border bg-card">
      {/* Search + density toggle */}
      <div className="p-3 border-b border-border space-y-2">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search datasets…"
              className="pl-8 h-9"
            />
          </div>
          <div className="flex items-center rounded-md border border-border overflow-hidden">
            <button
              type="button"
              onClick={() => setDensity("comfortable")}
              className={cn(
                "h-9 w-9 flex items-center justify-center transition-colors",
                density === "comfortable"
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:text-foreground"
              )}
              title="Comfortable"
              aria-label="Comfortable density"
            >
              <LayoutList className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setDensity("dense")}
              className={cn(
                "h-9 w-9 flex items-center justify-center transition-colors border-l border-border",
                density === "dense"
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:text-foreground"
              )}
              title="Dense"
              aria-label="Dense density"
            >
              <Rows3 className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setDensity("grid")}
              className={cn(
                "h-9 w-9 flex items-center justify-center transition-colors border-l border-border",
                density === "grid"
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:text-foreground"
              )}
              title="Card grid"
              aria-label="Card grid view"
            >
              <LayoutGrid className="h-4 w-4" />
            </button>
          </div>
        </div>

        {requiredTaskType && isTrainMode && (
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-2 py-0.5 font-medium">
              Filtering by task:
              <span className="text-foreground uppercase tracking-wide">
                {requiredTaskType}
              </span>
            </span>
            <span>
              {compatTaskType === "detection"
                ? "Classification-only datasets are dimmed."
                : "Datasets without matching annotations are dimmed."}
            </span>
          </div>
        )}
        {isEvaluateMode && (
          <p className="text-[11px] text-muted-foreground">
            All datasets with images are listed. Annotation file selection is optional in evaluation.
          </p>
        )}

        {/* Tag filter chips */}
        {allTags.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            {allTags.map((t) => {
              const active = activeTags.has(t);
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => toggleTag(t)}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors",
                    active
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-muted/40 text-muted-foreground border-border hover:text-foreground hover:bg-muted"
                  )}
                >
                  <span
                    className={cn(
                      "h-1.5 w-1.5 rounded-full",
                      active ? "bg-primary-foreground" : "bg-muted-foreground/50"
                    )}
                  />
                  {t}
                </button>
              );
            })}
            {activeTags.size > 0 && (
              <button
                type="button"
                onClick={() => setActiveTags(new Set())}
                className="text-[11px] text-muted-foreground hover:text-foreground underline ml-1"
              >
                clear
              </button>
            )}
          </div>
        )}
      </div>

      {/* Sticky selection summary */}
      {selectedDatasets.length > 0 && (
        <div className="border-b border-border bg-primary/[0.04] px-3 py-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[11px] uppercase tracking-wide text-primary font-semibold">
              Selected
            </span>
            {selectedDatasets.map((d) => (
              <span
                key={d.id}
                className="inline-flex items-center gap-1 rounded-full bg-primary text-primary-foreground pl-2 pr-1 py-0.5 text-[11px] font-medium"
              >
                {d.name}
                <button
                  type="button"
                  onClick={() => toggleSelected(d, false)}
                  className="ml-0.5 rounded-full hover:bg-primary-foreground/20 p-0.5"
                  aria-label={`Remove ${d.name}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="max-h-[420px] overflow-y-auto p-3 space-y-4">
        {recent.length > 0 && (
          <section className="space-y-2">
            <h4 className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">
              Recently used
            </h4>
            <div className={density === "grid" ? "grid grid-cols-2 lg:grid-cols-3 gap-2" : "space-y-2"}>
              {recent.map((d) => (
                <DatasetRow key={d.id} d={d} />
              ))}
            </div>
          </section>
        )}

        {groups.length > 0 && (
          <section className="space-y-2">
            <h4 className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">
              Dataset groups
            </h4>
            {groups.map((g) => {
              const dsInGroup = g.datasetIds
                .map((id) => datasetMap.get(id))
                .filter(Boolean) as PickerDataset[];
              const visibleDs = dsInGroup.filter(visible);
              const isOpen = openGroups.has(g.id);
              return (
                <div key={g.id} className="rounded-md border border-border bg-background">
                  <div className="flex items-center justify-between px-2 py-1.5">
                    <button
                      type="button"
                      onClick={() =>
                        setOpenGroups((s) => {
                          const n = new Set(s);
                          n.has(g.id) ? n.delete(g.id) : n.add(g.id);
                          return n;
                        })
                      }
                      className="flex items-center gap-1.5 text-sm font-medium"
                    >
                      {isOpen ? (
                        <ChevronDown className="h-3.5 w-3.5" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5" />
                      )}
                      <Folder className="h-3.5 w-3.5 text-muted-foreground" />
                      {g.name}
                      <Badge variant="secondary" className="text-[10px] ml-1">
                        {dsInGroup.length}
                      </Badge>
                    </button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs"
                      onClick={() => {
                        const additions: DatasetSelection[] = [];
                        let skippedIncompat = 0;
                        let skippedEmpty = 0;
                        dsInGroup.forEach((d) => {
                          if (selectionMap.has(d.id)) return;
                          if (groundTruthFileCount(d) <= 0) {
                            if (isTrainMode) { skippedEmpty += 1; return; }
                          } else if (isTrainMode && taskCompatibility(d) === "mismatch") {
                            skippedIncompat += 1;
                            return;
                          }
                          const compatible = compatibleAnnotationFiles(d);
                          const file = compatible[0];
                          const coll = d.collections[0];
                          additions.push({
                            datasetId: d.id,
                            annotationFileId: requiresAnnotationSelection
                              ? (file?.id ?? null)
                              : null,
                            collectionId: coll?.id ?? null,
                          });
                        });
                        if (additions.length) onChange([...value, ...additions]);
                        if (skippedIncompat > 0 || skippedEmpty > 0) {
                          toast({
                            title: `Added ${additions.length} of ${dsInGroup.length}`,
                            description: [
                              skippedIncompat > 0 && `${skippedIncompat} skipped (no ${compatTaskType ?? "matching"} annotations)`,
                              skippedEmpty > 0 && `${skippedEmpty} skipped (no annotation files)`,
                            ].filter(Boolean).join(" · "),
                          });
                        }
                      }}
                    >
                      Add all
                    </Button>
                  </div>
                  {isOpen && visibleDs.length > 0 && (
                    <div className={density === "grid" ? "grid grid-cols-2 lg:grid-cols-3 gap-2 px-2 pb-2" : "space-y-2 px-2 pb-2"}>
                      {visibleDs.map((d) => (
                        <DatasetRow key={d.id} d={d} />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </section>
        )}

        {compatibleOthers.length > 0 && (
          <section className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => setOpenSection((s) => ({ ...s, compatible: !s.compatible }))}
                className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground font-semibold hover:text-foreground"
              >
                {openSection.compatible ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                {(recent.length > 0 || groups.length > 0) ? "Compatible datasets" : "Datasets"}
                <Badge variant="secondary" className="text-[10px] ml-1">{compatibleOthers.length}</Badge>
              </button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs"
                onClick={() => {
                  const unselected = compatibleOthers.filter((d) => !selectionMap.has(d.id));
                  if (unselected.length === 0) return;
                  const additions: DatasetSelection[] = unselected.map((d) => {
                    const file = compatibleAnnotationFiles(d)[0];
                    const coll = d.collections[0];
                    return {
                      datasetId: d.id,
                      annotationFileId: requiresAnnotationSelection ? (file?.id ?? null) : null,
                      collectionId: coll?.id ?? null,
                    };
                  });
                  onChange([...value, ...additions]);
                  toast({
                    title: `Added ${additions.length} dataset${additions.length === 1 ? "" : "s"}`,
                    description: "Latest compatible annotation file selected for each.",
                  });
                }}
              >
                Select all
              </Button>
            </div>
            {openSection.compatible && (
              <div className={density === "grid" ? "grid grid-cols-2 lg:grid-cols-3 gap-2" : "space-y-2"}>
                {compatibleOthers.map((d) => (
                  <DatasetRow key={d.id} d={d} />
                ))}
              </div>
            )}
          </section>
        )}

        {incompatibleOthers.length > 0 && (
          <section className="space-y-2">
            <button
              type="button"
              onClick={() => setOpenSection((s) => ({ ...s, incompatible: !s.incompatible }))}
              className="w-full flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-amber-600 dark:text-amber-400 font-semibold hover:opacity-80"
            >
              {openSection.incompatible ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              <FileWarning className="h-3.5 w-3.5" />
              Not compatible with {compatTaskType ?? "task"}
              <Badge variant="outline" className="text-[10px] ml-1 border-amber-500/40 text-amber-600 dark:text-amber-400">
                {incompatibleOthers.length}
              </Badge>
            </button>
            {openSection.incompatible && (
              <>
                <p className="text-[11px] text-muted-foreground -mt-1">
                  These datasets have annotation files, but none match the selected task. They can't be added.
                </p>
                <div className={density === "grid" ? "grid grid-cols-2 lg:grid-cols-3 gap-2" : "space-y-2"}>
                  {incompatibleOthers.map((d) => (
                    <DatasetRow key={d.id} d={d} />
                  ))}
                </div>
              </>
            )}
          </section>
        )}

        {emptyOthers.length > 0 && !isTrainMode && (
          <section className="space-y-2">
            <button
              type="button"
              onClick={() => setOpenSection((s) => ({ ...s, empty: !s.empty }))}
              className="w-full flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground font-semibold hover:text-foreground"
            >
              {openSection.empty ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              <AlertTriangle className="h-3.5 w-3.5" />
              No annotations yet
              <Badge variant="outline" className="text-[10px] ml-1">{emptyOthers.length}</Badge>
            </button>
            {openSection.empty && (
              <>
                <p className="text-[11px] text-muted-foreground -mt-1">
                  Datasets without annotation files. Add annotations first if you need ground truth.
                </p>
                <div className={density === "grid" ? "grid grid-cols-2 lg:grid-cols-3 gap-2" : "space-y-2"}>
                  {emptyOthers.map((d) => (
                    <DatasetRow key={d.id} d={d} />
                  ))}
                </div>
              </>
            )}
          </section>
        )}

        {ungrouped.length === 0 &&
          groups.every(
            (g) =>
              g.datasetIds
                .map((id) => datasetMap.get(id))
                .filter(Boolean)
                .filter((d) => visible(d as PickerDataset)).length === 0
          ) && (
            <div className="text-center py-10 text-sm text-muted-foreground">
              <Database className="h-8 w-8 mx-auto mb-2 opacity-40" />
              No datasets match your filters
            </div>
          )}
      </div>

      <div className="border-t border-border px-3 py-2 flex items-center gap-3 text-xs bg-muted/40 rounded-b-lg">
        <span className="font-medium">
          {value.length} dataset{value.length === 1 ? "" : "s"}
        </span>
        <span className="text-muted-foreground">·</span>
        <span className="text-muted-foreground">
          {totalImages.toLocaleString()} images
        </span>
      </div>
    </div>
  );
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const d = Math.floor(diff / 86400000);
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 30) return `${d}d ago`;
  const m = Math.floor(d / 30);
  return `${m}mo ago`;
}
