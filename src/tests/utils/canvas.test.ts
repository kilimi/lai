import { describe, it, expect, beforeEach } from 'vitest';
import {
  setupCanvas,
  xywhToXyxy,
  xyxyToXywh,
  scaleBBox,
  getBBoxArea,
  getBBoxIntersection,
  calculateIoU,
  getContrastingColor,
  type BBox,
} from '@/utils/canvas';

describe('Canvas Utilities', () => {
  describe('setupCanvas', () => {
    it('sets up canvas with correct dimensions', () => {
      const canvas = document.createElement('canvas');
      const ctx = setupCanvas(canvas, 800, 600);

      expect(ctx).not.toBeNull();
      expect(canvas.style.width).toBe('800px');
      expect(canvas.style.height).toBe('600px');
    });

    it('returns null for canvas without 2d context', () => {
      const canvas = {
        getContext: () => null,
        style: {},
      } as any;

      const ctx = setupCanvas(canvas, 800, 600);
      expect(ctx).toBeNull();
    });
  });

  describe('xywhToXyxy', () => {
    it('converts xywh to xyxy format', () => {
      const result = xywhToXyxy([10, 20, 100, 50]);

      expect(result).toEqual({
        x1: 10,
        y1: 20,
        x2: 110,
        y2: 70,
      });
    });
  });

  describe('xyxyToXywh', () => {
    it('converts xyxy bbox object to xywh array', () => {
      const bbox: BBox = { x1: 10, y1: 20, x2: 110, y2: 70 };
      const result = xyxyToXywh(bbox);

      expect(result).toEqual([10, 20, 100, 50]);
    });

    it('converts xyxy array to xywh array', () => {
      const result = xyxyToXywh([10, 20, 110, 70]);

      expect(result).toEqual([10, 20, 100, 50]);
    });
  });

  describe('scaleBBox', () => {
    it('scales bbox by given factor', () => {
      const bbox: BBox = { x1: 10, y1: 20, x2: 110, y2: 70 };
      const result = scaleBBox(bbox, 2);

      expect(result).toEqual({
        x1: 20,
        y1: 40,
        x2: 220,
        y2: 140,
      });
    });

    it('scales down with factor < 1', () => {
      const bbox: BBox = { x1: 100, y1: 200, x2: 300, y2: 400 };
      const result = scaleBBox(bbox, 0.5);

      expect(result).toEqual({
        x1: 50,
        y1: 100,
        x2: 150,
        y2: 200,
      });
    });
  });

  describe('getBBoxArea', () => {
    it('calculates bbox area correctly', () => {
      const bbox: BBox = { x1: 10, y1: 20, x2: 110, y2: 70 };
      const area = getBBoxArea(bbox);

      expect(area).toBe(5000); // 100 * 50
    });

    it('returns 0 for zero-area bbox', () => {
      const bbox: BBox = { x1: 10, y1: 20, x2: 10, y2: 20 };
      const area = getBBoxArea(bbox);

      expect(area).toBe(0);
    });
  });

  describe('getBBoxIntersection', () => {
    it('calculates intersection of overlapping bboxes', () => {
      const bbox1: BBox = { x1: 0, y1: 0, x2: 100, y2: 100 };
      const bbox2: BBox = { x1: 50, y1: 50, x2: 150, y2: 150 };

      const intersection = getBBoxIntersection(bbox1, bbox2);

      expect(intersection).toEqual({
        x1: 50,
        y1: 50,
        x2: 100,
        y2: 100,
      });
    });

    it('returns null for non-overlapping bboxes', () => {
      const bbox1: BBox = { x1: 0, y1: 0, x2: 50, y2: 50 };
      const bbox2: BBox = { x1: 100, y1: 100, x2: 150, y2: 150 };

      const intersection = getBBoxIntersection(bbox1, bbox2);

      expect(intersection).toBeNull();
    });

    it('handles fully contained bbox', () => {
      const bbox1: BBox = { x1: 0, y1: 0, x2: 100, y2: 100 };
      const bbox2: BBox = { x1: 25, y1: 25, x2: 75, y2: 75 };

      const intersection = getBBoxIntersection(bbox1, bbox2);

      expect(intersection).toEqual({
        x1: 25,
        y1: 25,
        x2: 75,
        y2: 75,
      });
    });

    it('returns null for touching but not overlapping bboxes', () => {
      const bbox1: BBox = { x1: 0, y1: 0, x2: 50, y2: 50 };
      const bbox2: BBox = { x1: 50, y1: 0, x2: 100, y2: 50 };

      const intersection = getBBoxIntersection(bbox1, bbox2);

      expect(intersection).toBeNull();
    });
  });

  describe('calculateIoU', () => {
    it('calculates IoU for overlapping bboxes', () => {
      const bbox1: BBox = { x1: 0, y1: 0, x2: 100, y2: 100 }; // area = 10000
      const bbox2: BBox = { x1: 50, y1: 50, x2: 150, y2: 150 }; // area = 10000
      // intersection: 50x50 = 2500
      // union: 10000 + 10000 - 2500 = 17500
      // IoU: 2500 / 17500 = 0.142857...

      const iou = calculateIoU(bbox1, bbox2);

      expect(iou).toBeCloseTo(0.142857, 5);
    });

    it('returns 0 for non-overlapping bboxes', () => {
      const bbox1: BBox = { x1: 0, y1: 0, x2: 50, y2: 50 };
      const bbox2: BBox = { x1: 100, y1: 100, x2: 150, y2: 150 };

      const iou = calculateIoU(bbox1, bbox2);

      expect(iou).toBe(0);
    });

    it('returns 1 for identical bboxes', () => {
      const bbox1: BBox = { x1: 0, y1: 0, x2: 100, y2: 100 };
      const bbox2: BBox = { x1: 0, y1: 0, x2: 100, y2: 100 };

      const iou = calculateIoU(bbox1, bbox2);

      expect(iou).toBe(1);
    });

    it('calculates IoU for fully contained bbox', () => {
      const bbox1: BBox = { x1: 0, y1: 0, x2: 100, y2: 100 }; // area = 10000
      const bbox2: BBox = { x1: 25, y1: 25, x2: 75, y2: 75 }; // area = 2500
      // intersection: 2500
      // union: 10000 (larger bbox area)
      // IoU: 2500 / 10000 = 0.25

      const iou = calculateIoU(bbox1, bbox2);

      expect(iou).toBe(0.25);
    });
  });

  describe('getContrastingColor', () => {
    it('returns white for dark background', () => {
      expect(getContrastingColor('#000000')).toBe('#ffffff');
      expect(getContrastingColor('#333333')).toBe('#ffffff');
      expect(getContrastingColor('#0000ff')).toBe('#ffffff');
    });

    it('returns black for light background', () => {
      expect(getContrastingColor('#ffffff')).toBe('#000000');
      expect(getContrastingColor('#ffff00')).toBe('#000000');
      expect(getContrastingColor('#cccccc')).toBe('#000000');
    });

    it('handles colors without # prefix', () => {
      expect(getContrastingColor('000000')).toBe('#ffffff');
      expect(getContrastingColor('ffffff')).toBe('#000000');
    });

    it('returns appropriate contrast for medium colors', () => {
      expect(getContrastingColor('#808080')).toBe('#000000'); // Gray (luminance ~0.502 > 0.5 threshold → dark text)
      expect(getContrastingColor('#ff0000')).toBe('#ffffff'); // Red (luminance ~0.299 < 0.5 → light text)
      expect(getContrastingColor('#00ff00')).toBe('#000000'); // Green (luminance ~0.587 > 0.5 → dark text)
    });
  });
});
