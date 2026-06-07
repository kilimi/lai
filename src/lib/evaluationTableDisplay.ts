/**
 * Shared formatting for Model Evaluation tables (Project Evaluations page & dataset tab).
 */

export function formatModelTypeShort(raw: string | undefined | null): string {
  if (!raw || raw === "Unknown") return "";
  return raw.replace(/\.(pt|pth|onnx)$/i, "");
}

/**
 * Model column: architecture (e.g. yolo11n) plus training task name when available.
 * Example: "yolo11n · Road signs v2"
 */
export function formatEvaluationModelDisplay(metadata: {
  model_type?: string;
  model_config?: { model?: string };
  training_task_name?: string;
} | null | undefined): string {
  const m = metadata || {};
  const raw =
    (m.model_type && m.model_type !== "Unknown" ? m.model_type : "") ||
    m.model_config?.model ||
    "";
  const typeShort = formatModelTypeShort(raw) || "—";
  const name = (m.training_task_name || "").trim();
  if (name) return `${typeShort} · ${name}`;
  return typeShort;
}

export type EvalMetrics = { precision: number; recall: number; f1: number };

export function getEvaluationRowMetrics(
  metadata: {
    results?: { precision?: number; recall?: number; f1_score?: number; has_ground_truth?: boolean; predictions_count?: number };
    aggregate_results?: { precision?: number; recall?: number; f1_score?: number; has_ground_truth?: boolean; predictions_count?: number };
  } | null | undefined,
  options: { isMultiDataset: boolean; aggregateStatus: string }
): EvalMetrics | null {
  const m = metadata || {};
  if (options.isMultiDataset) {
    const ar = m.aggregate_results;
    if (ar && ar.has_ground_truth === true && typeof ar.precision === "number") {
      return {
        precision: ar.precision,
        recall: ar.recall ?? 0,
        f1: ar.f1_score ?? 0,
      };
    }
    return null;
  }
  const r = m.results;
  if (r && r.has_ground_truth === true && typeof r.precision === "number") {
    return {
      precision: r.precision,
      recall: r.recall ?? 0,
      f1: r.f1_score ?? 0,
    };
  }
  return null;
}

export function getEvaluationPredictionCount(
  metadata: {
    results?: { predictions_count?: number; has_ground_truth?: boolean };
    aggregate_results?: { predictions_count?: number; has_ground_truth?: boolean };
  } | null | undefined,
  options: { isMultiDataset: boolean }
): number | null {
  const m = metadata || {};
  const source = options.isMultiDataset ? m.aggregate_results : m.results;
  if (!source) return null;
  if (source.has_ground_truth !== false) return null;
  const n = source.predictions_count;
  return typeof n === "number" ? n : 0;
}

export function formatMetricPct(v: number | undefined): string {
  if (v === undefined || Number.isNaN(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

/** Slug for safe download basename (ASCII; matches backend heuristics). */
export function slugForDownloadFilename(
  segment: string | undefined | null,
  fallback: string,
  maxLen = 72
): string {
  const raw = (segment ?? "").trim();
  if (!raw) return fallback;
  let slug = "";
  for (const c of raw) {
    const code = c.charCodeAt(0);
    if (code < 128 && (/[a-zA-Z0-9]/.test(c) || c === "_" || c === "-")) {
      slug += c;
    } else {
      slug += "_";
    }
  }
  slug = slug.replace(/_+/g, "_").replace(/^_|_$/g, "").slice(0, maxLen).replace(/^_|_$/g, "");
  return slug || fallback;
}

export function evaluationCocoJsonDownloadName(opts: {
  taskId: number;
  evaluationName?: string | null;
  datasetName?: string | null;
}): string {
  const evalSlug = slugForDownloadFilename(opts.evaluationName ?? "", `evaluation_${opts.taskId}`);
  const dsSlug = slugForDownloadFilename(opts.datasetName ?? "", `dataset_${opts.taskId}`);
  return `${evalSlug}_${opts.taskId}_${dsSlug}_coco.json`;
}

export function evaluationCocoZipDownloadName(opts: {
  taskId: number;
  evaluationName?: string | null;
}): string {
  const evalSlug = slugForDownloadFilename(opts.evaluationName ?? "", `evaluation_${opts.taskId}`);
  return `${evalSlug}_${opts.taskId}_coco_all.zip`;
}

/** Prefer server Content-Disposition when visible to fetch (same-origin). */
export function attachmentFilenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;
  const starMatch = /\bfilename\*=(?:UTF-8''|utf-8'')([^;\s]+)/i.exec(header);
  if (starMatch?.[1]) {
    try {
      const s = decodeURIComponent(starMatch[1].trim()).trim();
      if (s) return s;
    } catch {
      //
    }
  }
  const qMatch = /\bfilename="((?:[^"\\]|\\.)*)"\s*[;\s]?/i.exec(header);
  if (qMatch?.[1]) return qMatch[1].replace(/\\(.)/g, "$1").trim();
  const plainMatch = /\bfilename=([^;\s]+)/i.exec(header);
  if (plainMatch?.[1]) return plainMatch[1].replace(/^["']|["']$/g, "").trim();
  return null;
}
