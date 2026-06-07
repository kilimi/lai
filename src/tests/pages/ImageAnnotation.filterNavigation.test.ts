import { describe, it, expect } from 'vitest';
import { resolveClassFilterToggleNavigation } from '@/pages/ImageAnnotation';

describe('ImageAnnotation class filter navigation', () => {
  const base = ['img_1.jpg', 'img_2.jpg', 'img_3.jpg', 'img_4.jpg'];

  it('enables filter and navigates to first filtered image (N1)', () => {
    const classMap = {
      cat: new Set(['img_3.jpg', 'img_4.jpg']),
    };

    const result = resolveClassFilterToggleNavigation(base, classMap, null, 'cat');

    expect(result.nextFilterName).toBe('cat');
    expect(result.nextList).toEqual(['img_3.jpg', 'img_4.jpg']);
    expect(result.firstImage).toBe('img_3.jpg');
  });

  it('disables active filter and navigates to first unfiltered image (N1)', () => {
    const classMap = {
      cat: new Set(['img_3.jpg', 'img_4.jpg']),
    };

    const result = resolveClassFilterToggleNavigation(base, classMap, 'cat', 'cat');

    expect(result.nextFilterName).toBeNull();
    expect(result.nextList).toEqual(base);
    expect(result.firstImage).toBe('img_1.jpg');
  });

  it('falls back to base list when selected class has no mapped images', () => {
    const classMap = {
      cat: new Set(['img_3.jpg']),
    };

    const result = resolveClassFilterToggleNavigation(base, classMap, null, 'dog');

    expect(result.nextFilterName).toBe('dog');
    expect(result.nextList).toEqual(base);
    expect(result.firstImage).toBe('img_1.jpg');
  });

  it('returns null firstImage when base list is empty', () => {
    const classMap = {
      cat: new Set<string>(),
    };

    const result = resolveClassFilterToggleNavigation([], classMap, null, 'cat');

    expect(result.nextFilterName).toBe('cat');
    expect(result.nextList).toEqual([]);
    expect(result.firstImage).toBeNull();
  });
});
