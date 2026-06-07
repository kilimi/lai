import { describe, expect, it } from 'vitest';
import {
  applyClassColorsToAnnotations,
  resolveAnnotationDisplayColor,
} from '@/utils/annotationColorConsistency';

describe('applyClassColorsToAnnotations', () => {
  it('remaps annotation colors from class palette for consistent stats/list colors', () => {
    const annotations = [
      { id: 'a1', label: 'Car', color: '#111111' },
      { id: 'a2', label: 'Person', color: '#222222' },
    ];
    const classes = [
      { name: 'Car', color: '#ff0000' },
      { name: 'Person', color: '#00ff00' },
    ];

    const result = applyClassColorsToAnnotations(annotations, classes);

    expect(result).toEqual([
      { id: 'a1', label: 'Car', color: '#ff0000' },
      { id: 'a2', label: 'Person', color: '#00ff00' },
    ]);
  });

  it('matches labels case-insensitively', () => {
    const annotations = [{ id: 'a1', label: 'person', color: '#111111' }];
    const classes = [{ name: 'Person', color: '#00ff00' }];

    const result = applyClassColorsToAnnotations(annotations, classes);

    expect(result[0].color).toBe('#00ff00');
  });

  it('keeps original color when class does not exist', () => {
    const annotations = [{ id: 'a1', label: 'Unknown', color: '#123456' }];
    const classes = [{ name: 'Car', color: '#ff0000' }];

    const result = applyClassColorsToAnnotations(annotations, classes);

    expect(result).toEqual([{ id: 'a1', label: 'Unknown', color: '#123456' }]);
  });
});

describe('resolveAnnotationDisplayColor', () => {
  // Regression: on the first paint of the segmentation annotation page,
  // annotations arrive from the API before classes are populated, so the
  // state-level remap effect hasn't run yet. Render code must still pick up
  // the class palette color so the canvas matches the left Classes panel.
  it('prefers the class palette color over annotation.color', () => {
    const color = resolveAnnotationDisplayColor(
      { label: 'Car', color: '#aaaaaa' },
      [{ name: 'Car', color: '#ff0000' }],
    );
    expect(color).toBe('#ff0000');
  });

  it('matches case-insensitively', () => {
    const color = resolveAnnotationDisplayColor(
      { label: 'car', color: '#aaaaaa' },
      [{ name: 'Car', color: '#ff0000' }],
    );
    expect(color).toBe('#ff0000');
  });

  it('falls back to annotation.color when no class matches', () => {
    const color = resolveAnnotationDisplayColor(
      { label: 'Unknown', color: '#123456' },
      [{ name: 'Car', color: '#ff0000' }],
    );
    expect(color).toBe('#123456');
  });

  it('falls back to annotation.color when classes list is empty', () => {
    const color = resolveAnnotationDisplayColor(
      { label: 'Car', color: '#123456' },
      [],
    );
    expect(color).toBe('#123456');
  });
});
