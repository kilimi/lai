/**
 * INSID3 integration hook + UI for ImageAnnotation (segmentation view only).
 */
import { useCallback, useEffect, useMemo, type RefObject } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Insid3PickModeBanner } from '@/components/annotation/Insid3PickModeBanner';
import { Insid3ReferencePanel } from '@/components/annotation/Insid3ReferencePanel';
import {
  isInsid3MaskShape,
  useInsid3References,
  annotationPointsForReference,
} from '@/components/annotation/useInsid3References';
import { useInsid3Segment } from '@/components/annotation/useInsid3Segment';
import type { Insid3Reference } from '@/components/annotation/insid3Types';
import type { AnnotationClass, AnnotationShape, Point } from '@/pages/image-annotation/types';
import { resolveBackendMediaUrl } from '@/config/api';
import { captureReferenceSnapshot } from '@/components/annotation/insid3ReferenceCapture';
import type { Insid3ResultsDialogData } from '@/components/annotation/Insid3ResultsDialog';
import { fetchInsid3Ready } from '@/utils/insid3Api';

export type SegmentModelChoice = 'sam2' | 'sam3' | 'insid3';

export function useInsid3Available() {
  return useQuery({
    queryKey: ['insid3-ready'],
    queryFn: fetchInsid3Ready,
    staleTime: 60_000,
    retry: 1,
    select: (status) => status,
  });
}

export interface Insid3ReferenceImageParams {
  imageUrl?: string;
  width?: number;
  height?: number;
}

export interface UseInsid3AnnotationIntegrationOptions {
  enabled: boolean;
  classes: AnnotationClass[];
  selectedClass: string | null;
  onSelectedClassChange: (id: string) => void;
  currentImageName: string | null;
  currentImageUrl?: string;
  currentImageWidth?: number;
  currentImageHeight?: number;
  resolveReferenceParams?: (imageName: string) => Insid3ReferenceImageParams | undefined;
  /** When false, do not snapshot the visible bitmap (annotation layer ≠ display layer). */
  canCaptureReferenceFromCanvas?: boolean;
  annotations: AnnotationShape[];
  datasetId: string | undefined;
  projectId: string | undefined;
  collectionId: string | undefined;
  layerImageFileNames: string[];
  samMinArea: number;
  imageRef: RefObject<HTMLImageElement | null>;
  onReferencesChange: (refs: Insid3Reference[]) => void;
  onBatchReady?: (
    results: Record<string, Point[][]>,
    classObj: AnnotationClass,
    dialogData: Insid3ResultsDialogData,
  ) => void;
  onShowResults?: (data: Insid3ResultsDialogData) => void;
  toast: (opts: { title: string; description?: string; variant?: 'default' | 'destructive' }) => void;
}

export function useInsid3AnnotationIntegration(opts: UseInsid3AnnotationIntegrationOptions) {
  const { data: insid3Status } = useInsid3Available();
  const insid3Available = insid3Status?.available ?? false;
  const insid3ClassId = opts.selectedClass || opts.classes[0]?.id || null;

  const refsState = useInsid3References({
    targetClassId: insid3ClassId,
    classes: opts.classes,
  });

  const referenceClassName = refsState.references[0]?.className ?? null;

  const pickableOnCurrentImage = useMemo(
    () => opts.annotations.filter((ann) => isInsid3MaskShape(ann)).length,
    [opts.annotations],
  );

  const resolveImageUrl = useCallback((url: string | undefined) => {
    if (!url) return undefined;
    return resolveBackendMediaUrl(url) || url;
  }, []);

  const segment = useInsid3Segment({
    references: refsState.references,
    targetClass:
      refsState.targetClass ??
      opts.classes.find((c) => c.name === referenceClassName) ??
      null,
    datasetId: opts.datasetId,
    projectId: opts.projectId,
    collectionId: opts.collectionId,
    layerImageFileNames: opts.layerImageFileNames,
    minArea: opts.samMinArea,
    resolveImageUrl,
    onBatchReady: opts.onBatchReady,
    onShowResults: opts.onShowResults,
  });

  useEffect(() => {
    opts.onReferencesChange(refsState.references);
  }, [refsState.references, opts.onReferencesChange]);

  const handleAnnotationPick = useCallback(
    (annotation: AnnotationShape | null) => {
      if (!annotation || !opts.currentImageName) return;
      if (!isInsid3MaskShape(annotation)) {
        opts.toast({
          title: 'Not a mask',
          description: 'Click a polygon or box annotation on the image.',
          variant: 'destructive',
        });
        return;
      }

      const classObj = opts.classes.find((c) => c.name === annotation.label);
      if (refsState.references.length === 0 && classObj) {
        opts.onSelectedClassChange(classObj.id);
      }

      const resolved =
        opts.resolveReferenceParams?.(opts.currentImageName) ?? {
          imageUrl: opts.currentImageUrl,
          width: opts.currentImageWidth,
          height: opts.currentImageHeight,
        };
      const width = resolved.width ?? opts.currentImageWidth;
      const height = resolved.height ?? opts.currentImageHeight;
      const polygon = annotationPointsForReference(annotation);
      if (!polygon) return;

      let imageB64: string | undefined;
      let snapshotPolygon = polygon;
      let snapshotWidth = width;
      let snapshotHeight = height;
      const imgEl = opts.imageRef.current;
      if (opts.canCaptureReferenceFromCanvas !== false && imgEl?.complete && width && height) {
        const snap = captureReferenceSnapshot(imgEl, polygon, width, height);
        if (snap) {
          imageB64 = snap.imageB64;
          snapshotPolygon = snap.polygon;
          snapshotWidth = snap.width;
          snapshotHeight = snap.height;
        }
      }

      const result = refsState.toggleReference({
        imageName: opts.currentImageName,
        annotation,
        imageUrl: imageB64 ? undefined : resolved.imageUrl ?? opts.currentImageUrl,
        imageB64,
        width: snapshotWidth,
        height: snapshotHeight,
        polygon: snapshotPolygon,
      });
      if (!result.ok) {
        opts.toast({ title: 'Cannot update reference', description: result.error, variant: 'destructive' });
      }
    },
    [opts, refsState],
  );

  const displayClassName = referenceClassName ?? refsState.targetClass?.name ?? null;

  const sidebarPanel = opts.enabled ? (
    <Insid3ReferencePanel
      classes={opts.classes}
      targetClassId={insid3ClassId}
      onTargetClassChange={opts.onSelectedClassChange}
      references={refsState.references}
      onRemoveReference={refsState.removeReference}
      onClearReferences={refsState.clearReferences}
      pickableOnCurrentImage={pickableOnCurrentImage}
      referenceClassName={referenceClassName}
      onFindSimilar={() => void segment.runPropagate()}
      isPropagating={segment.isPropagating}
      propagateProgress={segment.propagateProgress}
      excludeReferenceImages={segment.excludeReferenceImages}
      onExcludeReferenceImagesChange={segment.setExcludeReferenceImages}
      canRun={refsState.canRun}
      insid3Available={insid3Available}
      insid3UnavailableDetail={insid3Status?.detail}
      insid3WeightsMissing={insid3Status?.weightsMissing ?? true}
    />
  ) : null;

  const canvasBanner = opts.enabled ? (
    <Insid3PickModeBanner
      referenceCount={refsState.references.length}
      className={displayClassName ?? undefined}
      pickableOnImage={pickableOnCurrentImage}
    />
  ) : null;

  return {
    insid3Available,
    targetClassName: displayClassName,
    isPickableAnnotation: isInsid3MaskShape,
    isReferenceAnnotation: (imageName: string, annotationId: string) =>
      refsState.isReferenceAnnotation(imageName, annotationId),
    handleAnnotationPick,
    sidebarPanel,
    canvasBanner,
    isInsid3Busy: segment.isPropagating,
  };
}
