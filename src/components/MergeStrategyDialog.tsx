/**
 * MergeStrategyDialog
 * -------------------
 * Lets the user choose a merge strategy + tie-breaker for combining
 * overlapping annotations across files. Provides a live preview by
 * running applyMergeStrategy over the in-memory samples.
 */
import { useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ChevronUp, ChevronDown } from "lucide-react";
import type { AnnotationFile } from "@/utils/annotations";
import { ANNOTATION_TYPE_SHORT_LABELS, ANNOTATION_MERGE_GROUP_LABELS, detectAnnotationDisplayType, validateAnnotationMergeSelection } from "@/utils/annotations";
import {
  applyMergeStrategy,
  collectTaggedSamples,
  DEFAULT_MERGE_CONFIG,
  type MergeStrategy,
  type MergeStrategyConfig,
  type TieBreaker,
  type CrossClassPolicy,
} from "@/utils/annotationMergeStrategies";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  files: AnnotationFile[];
  onConfirm: (cfg: MergeStrategyConfig, mergedFileName: string) => void;
}

const STRATEGY_LABELS: Record<MergeStrategy, { title: string; hint: string }> = {
  exact: {
    title: "Drop exact duplicates",
    hint: "Removes only same-class instances at IoU ≥ 0.95. Safe default.",
  },
  iou: {
    title: "Deduplicate by IoU",
    hint: "NMS-style: same-class instances overlapping at the chosen IoU collapse to one.",
  },
  priority: {
    title: "Priority order",
    hint: "Higher-priority file wins on overlap. Useful for ground-truth vs. predictions.",
  },
  union: {
    title: "Keep all (union)",
    hint: "No deduplication. Use when comparing annotators or building consensus.",
  },
};

export function MergeStrategyDialog({ open, onOpenChange, files, onConfirm }: Props) {
  const [strategy, setStrategy] = useState<MergeStrategy>(DEFAULT_MERGE_CONFIG.strategy);
  const [iou, setIou] = useState<number>(DEFAULT_MERGE_CONFIG.iouThreshold);
  const [tieBreaker, setTieBreaker] = useState<TieBreaker>(DEFAULT_MERGE_CONFIG.tieBreaker);
  const [crossClass, setCrossClass] = useState<CrossClassPolicy>(DEFAULT_MERGE_CONFIG.crossClass);
  const [crossClassIou] = useState<number>(DEFAULT_MERGE_CONFIG.crossClassIou);
  const [order, setOrder] = useState<string[]>(files.map((f) => f.id));
  const defaultName = useMemo(
    () => `merged_${files.map((f) => f.name.replace(/\.[^/.]+$/, "")).join("_").slice(0, 80)}.json`,
    [files]
  );
  const [mergedName, setMergedName] = useState<string>(defaultName);

  // Keep order in sync with file selection when dialog reopens
  useMemo(() => setOrder(files.map((f) => f.id)), [files]);

  const cfg: MergeStrategyConfig = {
    strategy,
    iouThreshold: iou,
    tieBreaker,
    priorityOrder: order,
    crossClass,
    crossClassIou,
  };

  const samplesLoaded = files.every((f) => Array.isArray(f.samples) && (f.samples.length > 0 || (f.totalSampleCount || 0) === 0));

  const preview = useMemo(() => {
    if (!samplesLoaded) return null;
    const tagged = collectTaggedSamples(files);
    return applyMergeStrategy(tagged, cfg);
  }, [files, cfg, samplesLoaded]);

  const moveOrder = (idx: number, dir: -1 | 1) => {
    const next = order.slice();
    const j = idx + dir;
    if (j < 0 || j >= next.length) return;
    [next[idx], next[j]] = [next[j], next[idx]];
    setOrder(next);
  };

  const fileById = (id: string) => files.find((f) => f.id === id);

  const mergeValidation = useMemo(() => validateAnnotationMergeSelection(files), [files]);
  const mergeGroupLabel = mergeValidation.mergeGroup
    ? ANNOTATION_MERGE_GROUP_LABELS[mergeValidation.mergeGroup]
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Merge {files.length} annotation files</DialogTitle>
        </DialogHeader>

        <ScrollArea className="max-h-[65vh] pr-3">
          <div className="space-y-4 py-2">
            {/* Selected files + types */}
            <div className="rounded-md border border-border/60 bg-muted/30 p-3 space-y-2">
              <div className="text-xs font-medium">Files to merge</div>
              {mergeGroupLabel && (
                <p className="text-xs text-muted-foreground">
                  All selected files are compatible <Badge variant="secondary" className="text-[10px] h-4">{mergeGroupLabel}</Badge>
                  {' '}— mask-only and Masks + Boxes files can be merged together.
                </p>
              )}
              <ul className="space-y-1">
                {files.map((f) => {
                  const t = detectAnnotationDisplayType(f);
                  return (
                    <li key={f.id} className="flex items-center gap-2 text-sm min-w-0">
                      <span className="truncate flex-1" title={f.name}>{f.name}</span>
                      <Badge variant="outline" className="text-[10px] h-4 shrink-0">
                        {ANNOTATION_TYPE_SHORT_LABELS[t]}
                      </Badge>
                    </li>
                  );
                })}
              </ul>
              {!mergeValidation.ok && (
                <p className="text-xs text-destructive">{mergeValidation.message}</p>
              )}
            </div>

            {/* Output name */}
            <div>
              <Label className="text-xs">Output file name</Label>
              <Input value={mergedName} onChange={(e) => setMergedName(e.target.value)} />
            </div>

            {/* Strategy */}
            <div>
              <Label className="text-xs">Conflict strategy (same-class overlap)</Label>
              <RadioGroup
                value={strategy}
                onValueChange={(v) => setStrategy(v as MergeStrategy)}
                className="mt-2 space-y-2"
              >
                {(Object.keys(STRATEGY_LABELS) as MergeStrategy[]).map((s) => (
                  <div key={s} className="flex items-start gap-2 rounded-md border border-border/60 p-3">
                    <RadioGroupItem value={s} id={`s-${s}`} className="mt-0.5" />
                    <div className="flex-1">
                      <Label htmlFor={`s-${s}`} className="font-medium">{STRATEGY_LABELS[s].title}</Label>
                      <p className="text-xs text-muted-foreground">{STRATEGY_LABELS[s].hint}</p>

                      {s === "iou" && strategy === "iou" && (
                        <div className="mt-3 grid grid-cols-[1fr_auto] items-center gap-3">
                          <div>
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-xs text-muted-foreground">IoU threshold</span>
                              <span className="text-xs tabular-nums">{iou.toFixed(2)}</span>
                            </div>
                            <Slider value={[iou]} min={0.1} max={0.95} step={0.05} onValueChange={(v) => setIou(v[0])} />
                          </div>
                          <div>
                            <Label className="text-xs">Tie-breaker</Label>
                            <Select value={tieBreaker} onValueChange={(v) => setTieBreaker(v as TieBreaker)}>
                              <SelectTrigger className="h-8 w-36"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="largest">Keep largest</SelectItem>
                                <SelectItem value="smallest">Keep smallest</SelectItem>
                                <SelectItem value="first">Keep first</SelectItem>
                                <SelectItem value="last">Keep last</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                        </div>
                      )}

                      {s === "priority" && strategy === "priority" && (
                        <div className="mt-3 space-y-1.5">
                          <div className="text-xs text-muted-foreground">Drag-free reorder — top has highest priority.</div>
                          {order.map((fid, i) => {
                            const f = fileById(fid);
                            if (!f) return null;
                            return (
                              <div key={fid} className="flex items-center gap-2 rounded border border-border/60 px-2 py-1 bg-muted/30">
                                <span className="text-[10px] tabular-nums w-5 text-muted-foreground">#{i + 1}</span>
                                <span className="flex-1 truncate text-sm">{f.name}</span>
                                <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => moveOrder(i, -1)} disabled={i === 0}>
                                  <ChevronUp className="h-3.5 w-3.5" />
                                </Button>
                                <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => moveOrder(i, 1)} disabled={i === order.length - 1}>
                                  <ChevronDown className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </RadioGroup>
            </div>

            {/* Cross-class */}
            <div>
              <Label className="text-xs">Cross-class overlaps</Label>
              <Select value={crossClass} onValueChange={(v) => setCrossClass(v as CrossClassPolicy)}>
                <SelectTrigger className="h-9 mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="keep">Keep both (default)</SelectItem>
                  <SelectItem value="priority">Prefer priority file's class</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1">
                When two annotations of <em>different</em> classes overlap heavily, this decides whether to keep both or trust the priority file.
              </p>
            </div>

            {/* Preview */}
            <div className="rounded-md bg-muted/40 p-3">
              <div className="text-xs font-medium mb-2">Preview (estimate)</div>
              <p className="text-[11px] text-muted-foreground mb-2">
                Estimated from loaded samples. The merge runs on the backend over the full annotation set with the strategy you select here.
              </p>
              {!samplesLoaded ? (
                <p className="text-xs text-muted-foreground">
                  No samples loaded yet — open files (eye icon) to see an estimate. The backend will still apply your chosen strategy exactly.
                </p>
              ) : preview ? (
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge variant="secondary">In: ~{preview.report.total.toLocaleString()}</Badge>
                  <Badge variant="default">Kept: ~{preview.report.kept.toLocaleString()}</Badge>
                  {preview.report.removedExact > 0 && (
                    <Badge variant="outline">Exact dupes: −{preview.report.removedExact}</Badge>
                  )}
                  {preview.report.removedIou > 0 && (
                    <Badge variant="outline">IoU dupes: −{preview.report.removedIou}</Badge>
                  )}
                  {preview.report.removedCrossClass > 0 && (
                    <Badge variant="outline">Cross-class: −{preview.report.removedCrossClass}</Badge>
                  )}
                  {preview.report.conflicts.length > 0 && (
                    <Badge variant="outline" className="border-yellow-500/40 text-yellow-700 dark:text-yellow-300">
                      {preview.report.conflicts.length} conflicts flagged
                    </Badge>
                  )}
                </div>
              ) : null}

              {preview && preview.report.conflicts.length > 0 && (
                <div className="mt-2 max-h-32 overflow-auto border-t border-border/40 pt-2 text-[11px] space-y-1">
                  {preview.report.conflicts.slice(0, 8).map((c, i) => (
                    <div key={i} className="flex items-center gap-2 text-muted-foreground">
                      <span className="font-mono truncate">img {c.imageId}</span>
                      <span>·</span>
                      <span className="truncate">{c.classNames[0]} vs {c.classNames[1]}</span>
                      <span className="ml-auto tabular-nums">IoU {c.iou.toFixed(2)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </ScrollArea>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            onClick={() => onConfirm(cfg, mergedName)}
            disabled={!mergedName.trim() || !mergeValidation.ok}
            title={!mergeValidation.ok ? mergeValidation.message : undefined}
          >
            Merge
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
