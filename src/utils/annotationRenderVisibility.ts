export interface AnnotationRedrawDecisionInput {
  expectedVisibleAnnotationsCount: number;
  isLayerSwitching: boolean;
  imageReady: boolean;
  currentImageKey: string;
  lastDrawImageKey: string;
  lastDrawnVisibleAnnotations: number;
}

export function shouldScheduleAnnotationRedraw(
  input: AnnotationRedrawDecisionInput,
): boolean {
  const {
    expectedVisibleAnnotationsCount,
    isLayerSwitching,
    imageReady,
    currentImageKey,
    lastDrawImageKey,
    lastDrawnVisibleAnnotations,
  } = input;

  if (expectedVisibleAnnotationsCount <= 0) return false;
  if (isLayerSwitching) return false;
  if (!imageReady) return true;

  return (
    lastDrawImageKey !== currentImageKey ||
    lastDrawnVisibleAnnotations < expectedVisibleAnnotationsCount
  );
}
