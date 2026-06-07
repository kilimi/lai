export interface ClassColorSource {
  name: string;
  color: string;
}

export interface AnnotationColorTarget {
  label?: string | null;
  color?: string | null;
}

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}

export function applyClassColorsToAnnotations<T extends AnnotationColorTarget>(
  annotations: T[],
  classes: ClassColorSource[],
): T[] {
  if (!annotations.length || !classes.length) {
    return annotations;
  }

  const colorByLabel = new Map<string, string>();
  for (const cls of classes) {
    if (!cls?.name || !cls?.color) {
      continue;
    }
    colorByLabel.set(normalizeLabel(cls.name), cls.color);
  }

  let changed = false;
  const remapped = annotations.map((annotation) => {
    if (!annotation?.label) {
      return annotation;
    }
    const targetColor = colorByLabel.get(normalizeLabel(annotation.label));
    if (!targetColor || targetColor === annotation.color) {
      return annotation;
    }
    changed = true;
    return { ...annotation, color: targetColor };
  });

  return changed ? remapped : annotations;
}

/**
 * Resolve the color that should actually be rendered for an annotation.
 *
 * The state-level `applyClassColorsToAnnotations` reconciliation runs in a
 * `useEffect`, so on the very first paint annotation.color can still hold a
 * stale backend-assigned value that doesn't match the left-side Classes
 * palette. Render code should call this helper so the canvas and right-panel
 * swatches always agree with the Classes panel regardless of load order.
 */
export function resolveAnnotationDisplayColor(
  annotation: AnnotationColorTarget,
  classes: ClassColorSource[],
): string | null | undefined {
  if (annotation?.label) {
    const target = normalizeLabel(annotation.label);
    for (const cls of classes) {
      if (cls?.name && cls?.color && normalizeLabel(cls.name) === target) {
        return cls.color;
      }
    }
  }
  return annotation?.color;
}
