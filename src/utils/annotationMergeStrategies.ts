/**
 * annotationMergeStrategies
 * -------------------------
 * Pure helpers for resolving overlapping/duplicate annotations when merging
 * multiple AnnotationFiles into one COCO output.
 *
 * The actual merge runs client-side (combine `samples`, dedup, upload as a
 * new file) so users get an instant preview and a single deterministic result.
 */
import type { AnnotationFile, AnnotationSample } from "@/utils/annotations";

export type MergeStrategy =
  | "union"          // keep all
  | "exact"          // drop only IoU >= 0.95 same-class duplicates
  | "iou"            // NMS-style same-class dedup at threshold
  | "priority";      // priority order tie-breaker on overlap

export type TieBreaker = "largest" | "smallest" | "first" | "last";

export type CrossClassPolicy = "keep" | "priority";

export interface MergeStrategyConfig {
  strategy: MergeStrategy;
  iouThreshold: number;          // used by 'iou'
  tieBreaker: TieBreaker;        // used by 'iou' and 'exact'
  priorityOrder: string[];       // file ids, highest priority first
  crossClass: CrossClassPolicy;
  crossClassIou: number;         // when crossClass='priority', remove lower-priority overlapping cross-class ann at this IoU
}

export const DEFAULT_MERGE_CONFIG: MergeStrategyConfig = {
  strategy: "exact",
  iouThreshold: 0.7,
  tieBreaker: "largest",
  priorityOrder: [],
  crossClass: "keep",
  crossClassIou: 0.7,
};

// Tagged sample carrying its source file id for priority + reporting.
export interface TaggedSample extends AnnotationSample {
  __sourceFileId: string;
  __sourceFileName: string;
}

export interface MergeReport {
  total: number;          // input instance count
  kept: number;
  removedExact: number;
  removedIou: number;
  removedCrossClass: number;
  conflicts: Array<{
    imageId: string;
    classNames: [string, string];
    iou: number;
    sources: [string, string];
  }>;
}

// ---- geometry helpers ------------------------------------------------------

function bboxArea(b?: [number, number, number, number]) {
  if (!b) return 0;
  return Math.max(0, b[2]) * Math.max(0, b[3]);
}

/** Bbox IoU on normalized [x,y,w,h] tuples. Returns 0 for missing/degenerate. */
export function bboxIoU(a?: [number, number, number, number], b?: [number, number, number, number]) {
  if (!a || !b) return 0;
  const [ax, ay, aw, ah] = a;
  const [bx, by, bw, bh] = b;
  if (aw <= 0 || ah <= 0 || bw <= 0 || bh <= 0) return 0;
  const x1 = Math.max(ax, bx);
  const y1 = Math.max(ay, by);
  const xi2 = Math.min(ax + aw, bx + bw);
  const yi2 = Math.min(ay + ah, by + bh);
  const iw = Math.max(0, xi2 - x1);
  const ih = Math.max(0, yi2 - y1);
  const inter = iw * ih;
  if (inter <= 0) return 0;
  const union = aw * ah + bw * bh - inter;
  return union <= 0 ? 0 : inter / union;
}

// ---- core dedup ------------------------------------------------------------

function priorityRank(fileId: string, order: string[]): number {
  const idx = order.indexOf(fileId);
  return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
}

/** Returns true if `a` should be kept over `b` under the tie-breaker. */
function preferA(a: TaggedSample, b: TaggedSample, cfg: MergeStrategyConfig): boolean {
  if (cfg.strategy === "priority" || cfg.priorityOrder.length > 0) {
    const ra = priorityRank(a.__sourceFileId, cfg.priorityOrder);
    const rb = priorityRank(b.__sourceFileId, cfg.priorityOrder);
    if (ra !== rb) return ra < rb;
  }
  switch (cfg.tieBreaker) {
    case "largest":  return bboxArea(a.bbox) >= bboxArea(b.bbox);
    case "smallest": return bboxArea(a.bbox) <= bboxArea(b.bbox);
    case "first":    return true;
    case "last":     return false;
  }
}

/**
 * Apply the chosen merge strategy to a flat list of tagged samples.
 * Pure — does not mutate inputs.
 */
export function applyMergeStrategy(
  samples: TaggedSample[],
  cfg: MergeStrategyConfig,
): { kept: TaggedSample[]; report: MergeReport } {
  const report: MergeReport = {
    total: samples.length,
    kept: 0,
    removedExact: 0,
    removedIou: 0,
    removedCrossClass: 0,
    conflicts: [],
  };

  if (cfg.strategy === "union" && cfg.crossClass === "keep") {
    report.kept = samples.length;
    return { kept: samples.slice(), report };
  }

  // Group by image
  const byImage = new Map<string, TaggedSample[]>();
  for (const s of samples) {
    const arr = byImage.get(s.imageId) || [];
    arr.push(s);
    byImage.set(s.imageId, arr);
  }

  const exactT = 0.95;
  const iouT = cfg.strategy === "iou" ? cfg.iouThreshold : exactT;
  const sameClassDedup = cfg.strategy === "exact" || cfg.strategy === "iou" || cfg.strategy === "priority";

  const kept: TaggedSample[] = [];

  for (const [, group] of byImage) {
    // ---- same-class dedup ----
    let local: TaggedSample[] = group.slice();
    if (sameClassDedup) {
      // Sort: priority first, then preferred-area first (so iteration keeps "winner")
      local.sort((a, b) => {
        if (cfg.priorityOrder.length) {
          const r = priorityRank(a.__sourceFileId, cfg.priorityOrder) - priorityRank(b.__sourceFileId, cfg.priorityOrder);
          if (r !== 0) return r;
        }
        if (cfg.tieBreaker === "largest")  return bboxArea(b.bbox) - bboxArea(a.bbox);
        if (cfg.tieBreaker === "smallest") return bboxArea(a.bbox) - bboxArea(b.bbox);
        return 0;
      });

      const survivors: TaggedSample[] = [];
      for (const cand of local) {
        let dropped = false;
        for (const s of survivors) {
          if (s.className !== cand.className) continue;
          const iou = bboxIoU(s.bbox, cand.bbox);
          if (iou >= iouT) {
            // Decide which one stays — preferA(s, cand) true means s wins.
            if (preferA(s, cand, cfg)) {
              if (iou >= exactT) report.removedExact++; else report.removedIou++;
              dropped = true;
              break;
            } else {
              // cand wins, remove s
              const idx = survivors.indexOf(s);
              survivors.splice(idx, 1);
              if (iou >= exactT) report.removedExact++; else report.removedIou++;
              break;
            }
          }
        }
        if (!dropped) survivors.push(cand);
      }
      local = survivors;
    }

    // ---- cross-class policy ----
    if (cfg.crossClass === "priority" && cfg.priorityOrder.length) {
      const survivors: TaggedSample[] = [];
      // higher priority first
      local.sort((a, b) => priorityRank(a.__sourceFileId, cfg.priorityOrder) - priorityRank(b.__sourceFileId, cfg.priorityOrder));
      for (const cand of local) {
        let dropped = false;
        for (const s of survivors) {
          if (s.className === cand.className) continue;
          const iou = bboxIoU(s.bbox, cand.bbox);
          if (iou >= cfg.crossClassIou) {
            // s has higher (or equal) priority due to sort
            report.removedCrossClass++;
            report.conflicts.push({
              imageId: cand.imageId,
              classNames: [s.className, cand.className],
              iou,
              sources: [s.__sourceFileName, cand.__sourceFileName],
            });
            dropped = true;
            break;
          }
        }
        if (!dropped) survivors.push(cand);
      }
      local = survivors;
    } else if (cfg.crossClass === "keep") {
      // Still surface conflicts for transparency (cap to 50 total)
      if (report.conflicts.length < 50) {
        for (let i = 0; i < local.length && report.conflicts.length < 50; i++) {
          for (let j = i + 1; j < local.length && report.conflicts.length < 50; j++) {
            const a = local[i]; const b = local[j];
            if (a.className === b.className) continue;
            const iou = bboxIoU(a.bbox, b.bbox);
            if (iou >= cfg.crossClassIou) {
              report.conflicts.push({
                imageId: a.imageId,
                classNames: [a.className, b.className],
                iou,
                sources: [a.__sourceFileName, b.__sourceFileName],
              });
            }
          }
        }
      }
    }

    kept.push(...local);
  }

  report.kept = kept.length;
  return { kept, report };
}

/** Convenience: tag samples from each file with their source. */
export function collectTaggedSamples(files: AnnotationFile[]): TaggedSample[] {
  const out: TaggedSample[] = [];
  for (const f of files) {
    for (const s of f.samples || []) {
      out.push({ ...s, __sourceFileId: f.id, __sourceFileName: f.name });
    }
  }
  return out;
}
