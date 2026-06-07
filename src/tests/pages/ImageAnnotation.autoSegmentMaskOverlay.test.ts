import { describe, it, expect } from 'vitest';
import { buildAutoSegmentMaskOverlayStyle } from '@/pages/ImageAnnotation';

describe('ImageAnnotation SAM mask overlay style', () => {
  it('uses the same zoom and pan transform as the canvas image', () => {
    const style = buildAutoSegmentMaskOverlayStyle(
      { x: 120, y: -30 },
      2,
      1024,
      768,
    );

    expect(style.left).toBe(120);
    expect(style.top).toBe(-30);
    expect(style.width).toBe(2048);
    expect(style.height).toBe(1536);
  });

  it('keeps deterministic zero size when natural image dimensions are unavailable', () => {
    const style = buildAutoSegmentMaskOverlayStyle(
      { x: 10, y: 20 },
      1.5,
      0,
      0,
    );

    expect(style.left).toBe(10);
    expect(style.top).toBe(20);
    expect(style.width).toBe(0);
    expect(style.height).toBe(0);
  });
});
