import React, { useMemo, useState } from "react";
import { Plus, AlertTriangle, Info } from "lucide-react";
import { formatModelTypeShort } from "@/lib/evaluationTableDisplay";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * Models × Datasets coverage matrix for evaluations.
 *
 * Fairness rules:
 *  - Predictions-only runs (no ground truth) are excluded from the matrix.
 *    A separate counter surfaces how many are hidden.
 *  - A "Ground truth" selector lets the user restrict the matrix to a single
 *    GT file. Default "All" aggregates whichever GTs exist per dataset.
 *  - When a cell aggregates runs from multiple distinct GT files, a ⚠ badge
 *    is shown — those F1s are not directly comparable.
 */

export interface MatrixTask {
  id: number;
  status: string;
  task_metadata?: any;
}

interface Props {
  tasks: MatrixTask[];
  onCellOpen?: (taskId: number) => void;
  onCellEvaluate?: (modelKey: string, datasetName: string) => void;
  onNewEvaluation?: () => void;
}

interface CellEval {
  taskId: number;
  status: string;
  f1: number | null;
  hasGt: boolean;
  predictions: number | null;
  createdAt?: string;
  gtName: string;
}

interface CellData {
  best?: CellEval;
  count: number;
  gtFiles: Set<string>;
}

function modelIdentity(meta: any): { key: string; label: string; sub: string } {
  const arch = formatModelTypeShort(meta?.model_type) || meta?.model_config?.model || "model";
  const name = (meta?.training_task_name || "").trim();
  const key = `${name || "—"}::${arch}`;
  return { key, label: name || arch, sub: arch };
}

function metricColor(v: number): string {
  if (v >= 0.85) return "text-emerald-400 bg-emerald-500/10 border-emerald-500/30";
  if (v >= 0.6) return "text-amber-400 bg-amber-500/10 border-amber-500/30";
  return "text-red-400 bg-red-500/10 border-red-500/30";
}

const ALL_GT = "__ALL__";

export function EvaluationsMatrix({ tasks, onCellOpen, onCellEvaluate }: Props) {
  const [gtFilter, setGtFilter] = useState<string>(ALL_GT);

  const { models, datasets, grid, bestPerDataset, gtOptions, hiddenNoGt } = useMemo(() => {
    type Expanded = {
      modelKey: string;
      modelLabel: string;
      modelSub: string;
      datasetName: string;
      cell: CellEval;
    };
    const expanded: Expanded[] = [];
    let hiddenNoGt = 0;
    const gtSet = new Set<string>();

    for (const t of tasks) {
      const m = t.task_metadata || {};
      if (m.is_multi_dataset) continue;
      const datasetName = (m.dataset_name || "").trim();
      if (!datasetName) continue;
      const r = m.results || {};
      const ident = modelIdentity(m);
      const hasGt = r.has_ground_truth === true;
      // (#5) Exclude predictions-only runs entirely
      if (!hasGt) {
        hiddenNoGt += 1;
        continue;
      }
      const gtName = (m.annotation_file_name || m.ground_truth_file || "Unknown GT").toString();
      gtSet.add(gtName);
      expanded.push({
        modelKey: ident.key,
        modelLabel: ident.label,
        modelSub: ident.sub,
        datasetName,
        cell: {
          taskId: t.id,
          status: t.status,
          f1: typeof r.f1_score === "number" ? r.f1_score : null,
          hasGt: true,
          predictions: typeof r.predictions_count === "number" ? r.predictions_count : null,
          createdAt: (t as any).created_at,
          gtName,
        },
      });
    }

    // Apply GT filter
    const filtered = gtFilter === ALL_GT
      ? expanded
      : expanded.filter(e => e.cell.gtName === gtFilter);

    const modelMap = new Map<string, { label: string; sub: string }>();
    const datasetSet = new Set<string>();
    for (const c of filtered) {
      modelMap.set(c.modelKey, { label: c.modelLabel, sub: c.modelSub });
      datasetSet.add(c.datasetName);
    }
    const models = Array.from(modelMap.entries())
      .map(([key, v]) => ({ key, ...v }))
      .sort((a, b) => a.label.localeCompare(b.label));
    const datasets = Array.from(datasetSet).sort((a, b) => a.localeCompare(b));

    const grid = new Map<string, CellData>();
    for (const c of filtered) {
      const k = `${c.modelKey}|${c.datasetName}`;
      const cur = grid.get(k);
      if (!cur) {
        grid.set(k, { best: c.cell, count: 1, gtFiles: new Set([c.cell.gtName]) });
      } else {
        cur.count += 1;
        cur.gtFiles.add(c.cell.gtName);
        const replace = (() => {
          if (c.cell.status === "running" && cur.best?.status !== "running") return true;
          const a = c.cell.f1 ?? -1;
          const b = cur.best?.f1 ?? -1;
          if (a !== b) return a > b;
          return (c.cell.createdAt || "") > (cur.best?.createdAt || "");
        })();
        if (replace) cur.best = c.cell;
      }
    }

    const bestPerDataset = new Map<string, number>();
    for (const ds of datasets) {
      let best = -1;
      for (const m of models) {
        const c = grid.get(`${m.key}|${ds}`);
        if (c?.best?.f1 != null && c.best.f1 > best) best = c.best.f1;
      }
      if (best >= 0) bestPerDataset.set(ds, best);
    }

    return {
      models,
      datasets,
      grid,
      bestPerDataset,
      gtOptions: Array.from(gtSet).sort(),
      hiddenNoGt,
    };
  }, [tasks, gtFilter]);

  const totalCells = models.length * datasets.length;
  const filledCells = Array.from(grid.values()).filter((c) => !!c.best).length;
  const coverage = totalCells > 0 ? Math.round((filledCells / totalCells) * 100) : 0;

  return (
    <TooltipProvider delayDuration={150}>
      <div className="space-y-3">
        {/* Controls row */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Ground truth:</span>
              <Select value={gtFilter} onValueChange={setGtFilter}>
                <SelectTrigger className="h-8 min-w-[220px] text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_GT}>All GT files ({gtOptions.length})</SelectItem>
                  {gtOptions.map(gt => (
                    <SelectItem key={gt} value={gt} className="font-mono text-xs">
                      {gt}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  Different ground truth files produce F1 scores that are not directly
                  comparable. Pick a single GT for a fair comparison, or watch for the
                  ⚠ badge on cells that aggregate runs from multiple GT files.
                </TooltipContent>
              </Tooltip>
            </div>
            {hiddenNoGt > 0 && (
              <span className="text-xs text-muted-foreground">
                {hiddenNoGt} predictions-only run{hiddenNoGt === 1 ? "" : "s"} hidden (no GT)
              </span>
            )}
          </div>

          <div className="flex items-center gap-3 text-sm">
            <div className="text-muted-foreground">
              <span className="text-foreground font-medium">{models.length}</span> models ·{" "}
              <span className="text-foreground font-medium">{datasets.length}</span> datasets ·{" "}
              <span className="text-foreground font-medium">
                {filledCells}/{totalCells}
              </span>
            </div>
            <div className="flex items-center gap-2 w-48">
              <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${coverage}%` }}
                />
              </div>
              <span className="tabular-nums text-xs text-muted-foreground w-10 text-right">
                {coverage}%
              </span>
            </div>
          </div>
        </div>

        {models.length === 0 || datasets.length === 0 ? (
          <div className="text-center py-16 border border-dashed border-border rounded-lg">
            <p className="text-muted-foreground">
              {gtFilter === ALL_GT
                ? "No evaluations with ground truth yet."
                : "No evaluations match this ground truth file."}
            </p>
          </div>
        ) : (
          <div className="border border-border rounded-lg overflow-auto bg-card">
            <table className="w-full border-collapse text-sm">
              <thead className="sticky top-0 z-10 bg-card">
                <tr>
                  <th className="text-left p-3 border-b border-r border-border font-medium text-muted-foreground sticky left-0 bg-card z-20 min-w-[220px]">
                    Model
                  </th>
                  {datasets.map((ds) => (
                    <th
                      key={ds}
                      className="text-left p-3 border-b border-border font-medium min-w-[140px] max-w-[180px]"
                      title={ds}
                    >
                      <div className="truncate">{ds}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {models.map((m) => (
                  <tr key={m.key} className="hover:bg-muted/20">
                    <td className="p-3 border-b border-r border-border sticky left-0 bg-card z-10">
                      <div className="font-medium truncate" title={m.label}>{m.label}</div>
                      <div className="text-xs text-muted-foreground">{m.sub}</div>
                    </td>
                    {datasets.map((ds) => {
                      const cell = grid.get(`${m.key}|${ds}`);
                      const best = cell?.best;
                      const mixedGt = !!cell && cell.gtFiles.size > 1;
                      const isBestForCol =
                        best?.f1 != null && bestPerDataset.get(ds) === best.f1;

                      if (!best) {
                        return (
                          <td key={ds} className="border-b border-border p-1.5">
                            <button
                              onClick={() => onCellEvaluate?.(m.key, ds)}
                              className="w-full h-12 rounded border border-dashed border-border/60 text-muted-foreground/60 hover:text-foreground hover:border-primary hover:bg-primary/5 transition-colors flex items-center justify-center group"
                              title={`Evaluate ${m.label} on ${ds}`}
                            >
                              <Plus className="w-3.5 h-3.5 opacity-0 group-hover:opacity-100 transition-opacity" />
                            </button>
                          </td>
                        );
                      }
                      if (best.status === "running" || best.status === "pending") {
                        return (
                          <td key={ds} className="border-b border-border p-1.5">
                            <button
                              onClick={() => onCellOpen?.(best.taskId)}
                              className="w-full h-12 rounded border border-blue-500/40 bg-blue-500/10 text-blue-300 text-xs flex items-center justify-center gap-1.5"
                            >
                              <span className="inline-block w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
                              Running
                            </button>
                          </td>
                        );
                      }
                      if (best.status === "failed") {
                        return (
                          <td key={ds} className="border-b border-border p-1.5">
                            <button
                              onClick={() => onCellOpen?.(best.taskId)}
                              className="w-full h-12 rounded border border-red-500/40 bg-red-500/10 text-red-300 text-xs flex items-center justify-center"
                            >
                              Failed
                            </button>
                          </td>
                        );
                      }
                      if (best.f1 == null) {
                        return (
                          <td key={ds} className="border-b border-border p-1.5">
                            <button
                              onClick={() => onCellOpen?.(best.taskId)}
                              className="w-full h-12 rounded border border-border bg-muted/30 text-muted-foreground text-xs flex flex-col items-center justify-center"
                            >
                              <span className="font-medium text-foreground">
                                {best.predictions?.toLocaleString() ?? "—"}
                              </span>
                              <span className="text-[10px]">predictions</span>
                            </button>
                          </td>
                        );
                      }
                      return (
                        <td key={ds} className="border-b border-border p-1.5">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                onClick={() => onCellOpen?.(best.taskId)}
                                className={cn(
                                  "relative w-full h-12 rounded border flex flex-col items-center justify-center transition-all hover:scale-[1.02] hover:shadow-md",
                                  metricColor(best.f1),
                                  isBestForCol && "ring-2 ring-emerald-400/60"
                                )}
                              >
                                {mixedGt && (
                                  <span className="absolute top-0.5 right-0.5 text-amber-400">
                                    <AlertTriangle className="w-3 h-3" />
                                  </span>
                                )}
                                <span className="text-base font-semibold tabular-nums leading-none">
                                  {(best.f1 * 100).toFixed(1)}
                                </span>
                                <span className="text-[10px] uppercase tracking-wider opacity-70 mt-0.5">
                                  F1{cell!.count > 1 ? ` · ${cell!.count}×` : ""}
                                </span>
                              </button>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-xs">
                              <div className="space-y-1 text-xs">
                                <div>
                                  <span className="font-semibold">F1:</span> {(best.f1 * 100).toFixed(1)}%
                                  {cell!.count > 1 && ` · ${cell!.count} runs`}
                                </div>
                                {mixedGt ? (
                                  <div className="text-amber-400">
                                    ⚠ Mixed ground truth — scores aren't directly comparable:
                                    <ul className="list-disc list-inside mt-0.5 font-mono">
                                      {Array.from(cell!.gtFiles).map(g => <li key={g}>{g}</li>)}
                                    </ul>
                                  </div>
                                ) : (
                                  <div className="text-muted-foreground">
                                    GT: <span className="font-mono">{best.gtName}</span>
                                  </div>
                                )}
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Legend */}
        <div className="flex items-center gap-4 text-xs text-muted-foreground flex-wrap">
          <div className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded bg-emerald-500/20 border border-emerald-500/40" />
            ≥ 85% F1
          </div>
          <div className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded bg-amber-500/20 border border-amber-500/40" />
            60–85%
          </div>
          <div className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded bg-red-500/20 border border-red-500/40" />
            &lt; 60%
          </div>
          <div className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded ring-2 ring-emerald-400/60" />
            Best per dataset
          </div>
          <div className="flex items-center gap-1.5">
            <AlertTriangle className="w-3 h-3 text-amber-400" />
            Mixed GT (not directly comparable)
          </div>
          <div className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded border border-dashed border-border" />
            Not evaluated — click to run
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
