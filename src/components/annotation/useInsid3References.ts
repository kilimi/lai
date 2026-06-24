import { useCallback, useMemo, useState } from 'react';
import type { AnnotationClass, AnnotationShape, Point } from '@/pages/image-annotation/types';
import { bboxToRectPoints, pointsToBbox } from '@/pages/image-annotation/utils';
import {
  INSID3_MAX_REFERENCES,
  type Insid3Reference,
  referenceKey,
} from '@/components/annotation/insid3Types';

export interface UseInsid3ReferencesOptions {
  targetClassId: string | null;
  classes: AnnotationClass[];
}

export function annotationPointsForReference(annotation: AnnotationShape): Point[] | null {
  if (annotation.type === 'polygon' && annotation.points.length >= 3) {
    return annotation.points;
  }
  if (annotation.type === 'rectangle' && annotation.points.length >= 2) {
    return bboxToRectPoints(pointsToBbox(annotation.points));
  }
  return null;
}

export function isInsid3MaskShape(annotation: AnnotationShape): boolean {
  if (!annotation.visible) return false;
  return annotationPointsForReference(annotation) !== null;
}

/** @deprecated use isInsid3MaskShape — kept for callers filtering by target class */
export function isPickableInsid3Annotation(
  annotation: AnnotationShape,
  targetClassName: string | null | undefined,
): boolean {
  if (!isInsid3MaskShape(annotation)) return false;
  if (!targetClassName) return true;
  return annotation.label === targetClassName;
}

export function useInsid3References({ targetClassId, classes }: UseInsid3ReferencesOptions) {
  const [references, setReferences] = useState<Insid3Reference[]>([]);

  const targetClass = useMemo(
    () => classes.find((c) => c.id === targetClassId) ?? null,
    [classes, targetClassId],
  );

  const addReference = useCallback(
    (params: {
      imageName: string;
      annotation: AnnotationShape;
      imageUrl?: string;
      imageB64?: string;
      width?: number;
      height?: number;
      polygon?: Point[];
    }) => {
      const className = params.annotation.label;
      const polygon = params.polygon ?? annotationPointsForReference(params.annotation);
      if (!polygon || polygon.length < 3) {
        return { ok: false as const, error: 'Mask needs at least 3 points' };
      }
      if (references.length > 0 && className !== references[0].className) {
        return {
          ok: false as const,
          error: `All references must be "${references[0].className}" (this mask is "${className}")`,
        };
      }
      const key = referenceKey(params.imageName, params.annotation.id);
      if (references.some((r) => referenceKey(r.imageName, r.annotationId) === key)) {
        return { ok: false as const, error: 'Already in references' };
      }
      if (references.length >= INSID3_MAX_REFERENCES) {
        return { ok: false as const, error: `Maximum ${INSID3_MAX_REFERENCES} references` };
      }
      const ref: Insid3Reference = {
        id: `insid3_ref_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        imageName: params.imageName,
        annotationId: params.annotation.id,
        className,
        polygon,
        imageUrl: params.imageB64 ? undefined : params.imageUrl,
        imageB64: params.imageB64,
        width: params.width,
        height: params.height,
      };
      setReferences((prev) => [...prev, ref]);
      return { ok: true as const, ref, action: 'added' as const };
    },
    [references],
  );

  const removeReference = useCallback((id: string) => {
    setReferences((prev) => prev.filter((r) => r.id !== id));
  }, []);

  const findReference = useCallback(
    (imageName: string, annotationId: string) =>
      references.find(
        (r) => r.imageName === imageName && r.annotationId === annotationId,
      ) ?? null,
    [references],
  );

  const toggleReference = useCallback(
    (params: {
      imageName: string;
      annotation: AnnotationShape;
      imageUrl?: string;
      imageB64?: string;
      width?: number;
      height?: number;
      polygon?: Point[];
    }) => {
      const existing = findReference(params.imageName, params.annotation.id);
      if (existing) {
        removeReference(existing.id);
        return { ok: true as const, action: 'removed' as const };
      }
      return addReference(params);
    },
    [addReference, findReference, removeReference],
  );

  const clearReferences = useCallback(() => setReferences([]), []);

  const isReferenceAnnotation = useCallback(
    (imageName: string, annotationId: string) =>
      references.some(
        (r) => r.imageName === imageName && r.annotationId === annotationId,
      ),
    [references],
  );

  const referenceImageNames = useMemo(
    () => new Set(references.map((r) => r.imageName)),
    [references],
  );

  return {
    pickMode: true,
    references,
    setReferences,
    targetClass,
    addReference,
    toggleReference,
    findReference,
    removeReference,
    clearReferences,
    isReferenceAnnotation,
    referenceImageNames,
    canRun: references.length >= 1,
  };
}

export function polygonPointsFromApi(raw: number[][]): Point[] {
  return raw.map((p) => ({ x: p[0], y: p[1] }));
}
