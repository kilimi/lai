import { useCallback, useEffect, useRef, useState } from 'react';
import type { AnnotationClass, Point } from '@/pages/image-annotation/types';
import { calculatePolygonArea } from '@/pages/image-annotation/utils';
import type { Insid3Reference } from '@/components/annotation/insid3Types';
import type {
  Insid3ProcessingDiagnostics,
  Insid3ReferenceSummary,
  Insid3ResultsDialogData,
} from '@/components/annotation/Insid3ResultsDialog';
import { polygonPointsFromApi } from '@/components/annotation/useInsid3References';
import { fetchTask, startInsid3Propagate } from '@/utils/insid3Api';

function parseCollectionId(collectionId: string | undefined): number | undefined {
  if (!collectionId || collectionId === 'default') return undefined;
  const n = Number(collectionId);
  return Number.isFinite(n) ? n : undefined;
}

function taskMetadata(task: Record<string, unknown>): Record<string, unknown> {
  return (task.task_metadata || task.metadata || {}) as Record<string, unknown>;
}

function resolveImagesSearched(md: Record<string, unknown>): number {
  const searchable = md.searchable_image_count;
  if (typeof searchable === 'number' && searchable >= 0) return searchable;
  const total = md.total;
  if (typeof total === 'number' && total > 0) return total;
  const layer = md.layer_image_count;
  const excluded = md.excluded_reference_count;
  if (typeof layer === 'number' && typeof excluded === 'number') {
    return Math.max(0, layer - excluded);
  }
  const results = md.results;
  if (results && typeof results === 'object') {
    return Object.keys(results as object).length;
  }
  return 0;
}

function emptyBatchMessage(
  emptyReason: string | undefined,
  layerImageCount: number | undefined,
  excludedReferenceCount: number | undefined,
): string | undefined {
  if (emptyReason === 'all_reference_images_excluded') {
    const layer = layerImageCount ?? 0;
    const skipped = excludedReferenceCount ?? 0;
    return `Layer has ${layer} image(s); ${skipped} reference image(s) were skipped, leaving none to search.`;
  }
  if (emptyReason === 'no_images_in_layer') {
    return 'No images are registered for this layer in the dataset.';
  }
  if (emptyReason === 'reference_self_test_failed') {
    return 'INSID3 could not match objects on a reference image itself — fix reference masks before searching the layer.';
  }
  return undefined;
}

export interface UseInsid3SegmentOptions {
  references: Insid3Reference[];
  targetClass: AnnotationClass | null;
  datasetId: string | undefined;
  projectId: string | undefined;
  collectionId: string | undefined;
  layerImageFileNames: string[];
  minArea: number;
  resolveImageUrl: (url: string | undefined) => string | undefined;
  onBatchReady?: (
    results: Record<string, Point[][]>,
    classObj: AnnotationClass,
    dialogData: Insid3ResultsDialogData,
  ) => void;
  onShowResults?: (data: Insid3ResultsDialogData) => void;
}

function referenceSummaries(refs: Insid3Reference[]): Insid3ReferenceSummary[] {
  return refs.map((r, i) => ({
    index: i + 1,
    imageName: r.imageName,
    className: r.className,
  }));
}

function countBatchStats(mapped: Record<string, Point[][]>, minArea: number) {
  let annotationsAdded = 0;
  let imagesWithMatches = 0;
  for (const polys of Object.values(mapped)) {
    const kept = polys.filter(
      (poly) => poly.length >= 3 && (minArea <= 0 || calculatePolygonArea(poly) >= minArea),
    );
    if (kept.length > 0) imagesWithMatches += 1;
    annotationsAdded += kept.length;
  }
  return { annotationsAdded, imagesWithMatches };
}

export { countBatchStats };

function isPropagateMetadataReady(md: Record<string, unknown>): boolean {
  if (md.stage === 'completed' || md.empty_reason) return true;
  const total = resolveImagesSearched(md);
  const processed = typeof md.processed === 'number' ? md.processed : 0;
  return total > 0 && processed >= total;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseProcessingDiagnostics(md: Record<string, unknown>): Insid3ProcessingDiagnostics | undefined {
  const summary = asRecord(md.diagnostics_summary);
  if (!summary) return undefined;

  const settings = asRecord(summary.settings);
  const outcomes = asRecord(summary.outcomes);
  const referencesRaw = summary.references;
  const samplesRaw = summary.samples;
  const hintsRaw = summary.hints;
  const pipelineRaw = summary.pipeline;

  const selfTestRaw = summary.selfTest;
  const selfTest =
    selfTestRaw && typeof selfTestRaw === 'object'
      ? {
          ok: Boolean((selfTestRaw as Record<string, unknown>).ok),
          reason:
            typeof (selfTestRaw as Record<string, unknown>).reason === 'string'
              ? ((selfTestRaw as Record<string, unknown>).reason as string)
              : undefined,
        }
      : undefined;

  return {
    pipeline: Array.isArray(pipelineRaw) ? pipelineRaw.map(String) : undefined,
    hints: Array.isArray(hintsRaw) ? hintsRaw.map(String) : undefined,
    selfTest,
    settings: settings
      ? {
          modelSize: typeof settings.modelSize === 'string' ? settings.modelSize : undefined,
          imageSize: typeof settings.imageSize === 'number' ? settings.imageSize : undefined,
          minArea: typeof settings.minArea === 'number' ? settings.minArea : undefined,
        }
      : undefined,
    references: Array.isArray(referencesRaw)
      ? referencesRaw.map((row, i) => {
          const r = asRecord(row) ?? {};
          return {
            index: typeof r.index === 'number' ? r.index : i,
            imageName: typeof r.imageName === 'string' ? r.imageName : undefined,
            width: typeof r.width === 'number' ? r.width : undefined,
            height: typeof r.height === 'number' ? r.height : undefined,
            polygonVertices:
              typeof r.polygonVertices === 'number' ? r.polygonVertices : undefined,
            polygonArea: typeof r.polygonArea === 'number' ? r.polygonArea : undefined,
            maskPixels: typeof r.maskPixels === 'number' ? r.maskPixels : r.maskPixels === null ? null : undefined,
            warning: typeof r.warning === 'string' ? r.warning : r.warning === null ? null : undefined,
            rasterStrategy:
              typeof r.rasterStrategy === 'string' ? r.rasterStrategy : undefined,
          };
        })
      : undefined,
    outcomes: outcomes
      ? Object.fromEntries(
          Object.entries(outcomes).map(([k, v]) => [k, typeof v === 'number' ? v : Number(v) || 0]),
        )
      : undefined,
    samples: Array.isArray(samplesRaw)
      ? samplesRaw.map((row) => {
          const s = asRecord(row) ?? {};
          return {
            image: String(s.image ?? ''),
            outcome: String(s.outcome ?? ''),
            reason: typeof s.reason === 'string' ? s.reason : undefined,
            positivePixels:
              typeof s.positivePixels === 'number' ? s.positivePixels : undefined,
            skippedByMinArea:
              typeof s.skippedByMinArea === 'number' ? s.skippedByMinArea : undefined,
          };
        })
      : undefined,
  };
}

export function useInsid3Segment({
  references,
  targetClass,
  datasetId,
  projectId,
  collectionId,
  layerImageFileNames,
  minArea,
  resolveImageUrl,
  onBatchReady,
  onShowResults,
}: UseInsid3SegmentOptions) {
  const [isPropagating, setIsPropagating] = useState(false);
  const [propagateProgress, setPropagateProgress] = useState<{ current: number; total: number } | null>(null);
  const [excludeReferenceImages, setExcludeReferenceImages] = useState(true);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const runPropagate = useCallback(async () => {
    if (!datasetId || references.length === 0 || !targetClass) return;
    const refSummaries = referenceSummaries(references);
    setIsPropagating(true);
    setPropagateProgress({ current: 0, total: 0 });
    try {
      const refsWithUrls = references.map((r) => ({
        ...r,
        imageUrl: resolveImageUrl(r.imageUrl),
      }));
      const started = await startInsid3Propagate({
        datasetId: Number(datasetId),
        projectId: projectId ? Number(projectId) : undefined,
        collectionId: parseCollectionId(collectionId),
        className: targetClass.name,
        classColor: targetClass.color,
        references: refsWithUrls,
        excludeReferenceImages,
        layerImageFileNames,
        minArea,
      });
      const taskId = started.task_id;

      await new Promise<void>((resolve, reject) => {
        pollRef.current = setInterval(async () => {
          try {
            let task = await fetchTask(taskId);
            let md = taskMetadata(task);

            if (task.status === 'completed' && !isPropagateMetadataReady(md)) {
              task = await fetchTask(taskId);
              md = taskMetadata(task);
            }

            const total = resolveImagesSearched(md);
            const processed = typeof md.processed === 'number' ? md.processed : 0;
            if (total > 0) setPropagateProgress({ current: processed, total });

            if (task.status === 'completed' && isPropagateMetadataReady(md)) {
              if (pollRef.current) clearInterval(pollRef.current);

              const results = (md.results || {}) as Record<string, unknown>;
              const mapped: Record<string, Point[][]> = {};
              let failCount = 0;
              for (const [fileName, val] of Object.entries(results)) {
                const entry = val as { polygons?: number[][][]; error?: string };
                if (entry.error) {
                  failCount += 1;
                  continue;
                }
                const polys = (entry.polygons || [])
                  .map((p) => polygonPointsFromApi(p))
                  .filter((pts) => pts.length >= 3);
                if (polys.length > 0) mapped[fileName] = polys;
              }
              const totalImages = resolveImagesSearched(md);
              const layerImageCount =
                typeof md.layer_image_count === 'number' ? md.layer_image_count : undefined;
              const excludedReferenceCount =
                typeof md.excluded_reference_count === 'number'
                  ? md.excluded_reference_count
                  : undefined;
              const emptyReason =
                typeof md.empty_reason === 'string' ? md.empty_reason : undefined;
              const { annotationsAdded, imagesWithMatches } = countBatchStats(mapped, minArea);
              const diagnostics = parseProcessingDiagnostics(md);

              const dialogData: Insid3ResultsDialogData = {
                mode: 'batch',
                outcome:
                  annotationsAdded > 0
                    ? 'complete'
                    : failCount > 0 && imagesWithMatches === 0
                      ? 'error'
                      : 'empty',
                className: targetClass.name,
                referenceCount: references.length,
                references: refSummaries,
                totalImages,
                imagesWithMatches,
                annotationsAdded: 0,
                totalPolygons: annotationsAdded,
                applied: false,
                defaultClassId: targetClass.id,
                failCount,
                minArea,
                layerImageCount,
                excludedReferenceCount,
                emptyReason,
                diagnostics,
                message:
                  annotationsAdded === 0
                    ? emptyBatchMessage(emptyReason, layerImageCount, excludedReferenceCount)
                    : failCount > 0
                      ? 'Some images could not be processed.'
                      : undefined,
              };

              if (annotationsAdded > 0) {
                onBatchReady?.(mapped, targetClass, dialogData);
              } else {
                onShowResults?.(dialogData);
              }
              resolve();
            } else if (task.status === 'failed' || task.status === 'cancelled') {
              if (pollRef.current) clearInterval(pollRef.current);
              reject(new Error(task.error_message || `Task ${task.status}`));
            }
          } catch (err) {
            if (pollRef.current) clearInterval(pollRef.current);
            reject(err);
          }
        }, 2000);
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      onShowResults?.({
        mode: 'batch',
        outcome: 'error',
        className: targetClass.name,
        referenceCount: references.length,
        references: refSummaries,
        totalImages: 0,
        imagesWithMatches: 0,
        annotationsAdded: 0,
        failCount: 0,
        minArea,
        message: 'Find similar in layer failed.',
        detail: message,
      });
    } finally {
      setIsPropagating(false);
      setPropagateProgress(null);
    }
  }, [
    datasetId,
    projectId,
    collectionId,
    layerImageFileNames,
    references,
    targetClass,
    minArea,
    resolveImageUrl,
    excludeReferenceImages,
    onBatchReady,
    onShowResults,
  ]);

  return {
    isPropagating,
    propagateProgress,
    excludeReferenceImages,
    setExcludeReferenceImages,
    runPropagate,
  };
}
