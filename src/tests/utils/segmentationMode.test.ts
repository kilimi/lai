import { describe, expect, it } from 'vitest';
import { detectSegmentationModeCapabilities, pointsToTightBbox } from '@/utils/annotations';

describe('detectSegmentationModeCapabilities', () => {
  it('detects bbox-only files', () => {
    const result = detectSegmentationModeCapabilities({
      annotations: [{ id: 1, bbox: [10, 20, 30, 40], segmentation: [] }],
    });
    expect(result).toEqual({ hasMasks: false, hasBboxesOnly: true, isEmpty: false });
  });

  it('detects mask-containing files as mask mode', () => {
    const result = detectSegmentationModeCapabilities({
      annotations: [{ id: 1, bbox: [10, 20, 30, 40], segmentation: [[1, 2, 3, 4, 5, 6]] }],
    });
    expect(result).toEqual({ hasMasks: true, hasBboxesOnly: false, isEmpty: false });
  });

  it('detects empty files', () => {
    const result = detectSegmentationModeCapabilities({ annotations: [] });
    expect(result).toEqual({ hasMasks: false, hasBboxesOnly: false, isEmpty: true });
  });
});

describe('pointsToTightBbox', () => {
  it('converts polygon points to a tight xywh bbox', () => {
    const bbox = pointsToTightBbox([
      { x: 10, y: 20 },
      { x: 80, y: 20 },
      { x: 60, y: 90 },
      { x: 20, y: 70 },
    ]);
    expect(bbox).toEqual([10, 20, 70, 70]);
  });
});

