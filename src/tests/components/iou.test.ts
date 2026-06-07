/**
 * Unit tests for IoU (Intersection over Union) calculation
 */

import { describe, it, expect } from 'vitest';
import { iou } from '../../components/ThresholdExplorer';

describe('iou function', () => {
  describe('valid inputs', () => {
    it('should calculate IoU for non-overlapping boxes', () => {
      const box1: [number, number, number, number] = [0, 0, 10, 10];
      const box2: [number, number, number, number] = [20, 20, 30, 30];
      expect(iou(box1, box2)).toBe(0);
    });

    it('should calculate IoU for identical boxes', () => {
      const box1: [number, number, number, number] = [10, 10, 20, 20];
      const box2: [number, number, number, number] = [10, 10, 20, 20];
      expect(iou(box1, box2)).toBe(1);
    });

    it('should calculate IoU for partially overlapping boxes', () => {
      const box1: [number, number, number, number] = [0, 0, 10, 10];
      const box2: [number, number, number, number] = [5, 5, 15, 15];
      // Intersection: 5x5 = 25
      // Union: 100 + 100 - 25 = 175
      // IoU: 25/175 = 0.142857...
      expect(iou(box1, box2)).toBeCloseTo(0.142857, 5);
    });

    it('should calculate IoU for box contained in another', () => {
      const box1: [number, number, number, number] = [0, 0, 20, 20];
      const box2: [number, number, number, number] = [5, 5, 15, 15];
      // Intersection: 10x10 = 100
      // Union: 400 + 100 - 100 = 400
      // IoU: 100/400 = 0.25
      expect(iou(box1, box2)).toBeCloseTo(0.25, 5);
    });

    it('should calculate IoU for boxes touching at edge', () => {
      const box1: [number, number, number, number] = [0, 0, 10, 10];
      const box2: [number, number, number, number] = [10, 0, 20, 10];
      // No intersection (touching at edge)
      expect(iou(box1, box2)).toBe(0);
    });

    it('should handle floating point coordinates', () => {
      const box1: [number, number, number, number] = [0.5, 0.5, 10.5, 10.5];
      const box2: [number, number, number, number] = [5.5, 5.5, 15.5, 15.5];
      // Intersection: 5x5 = 25
      // Union: 100 + 100 - 25 = 175
      expect(iou(box1, box2)).toBeCloseTo(0.142857, 5);
    });

    it('should handle very small overlaps', () => {
      const box1: [number, number, number, number] = [0, 0, 100, 100];
      const box2: [number, number, number, number] = [99, 99, 200, 200];
      // Intersection: 1x1 = 1
      // Union: 10000 + 10201 - 1 = 20200
      expect(iou(box1, box2)).toBeCloseTo(1 / 20200, 8);
    });
  });

  describe('edge cases', () => {
    it('should return 0 for inverted boxes (x2 < x1)', () => {
      const box1: [number, number, number, number] = [10, 0, 0, 10]; // inverted x
      const box2: [number, number, number, number] = [0, 0, 10, 10];
      expect(iou(box1, box2)).toBe(0);
    });

    it('should return 0 for inverted boxes (y2 < y1)', () => {
      const box1: [number, number, number, number] = [0, 10, 10, 0]; // inverted y
      const box2: [number, number, number, number] = [0, 0, 10, 10];
      expect(iou(box1, box2)).toBe(0);
    });

    it('should return 0 for zero-area boxes', () => {
      const box1: [number, number, number, number] = [5, 5, 5, 5]; // point
      const box2: [number, number, number, number] = [0, 0, 10, 10];
      expect(iou(box1, box2)).toBe(0);
    });

    it('should return 0 for negative coordinates', () => {
      const box1: [number, number, number, number] = [-10, -10, -5, -5];
      const box2: [number, number, number, number] = [-8, -8, -3, -3];
      // Valid boxes with negative coords should still work
      const result = iou(box1, box2);
      expect(result).toBeGreaterThan(0);
    });
  });

  describe('invalid inputs', () => {
    it('should return 0 for null/undefined first argument', () => {
      const box2: [number, number, number, number] = [0, 0, 10, 10];
      expect(iou(null as any, box2)).toBe(0);
      expect(iou(undefined as any, box2)).toBe(0);
    });

    it('should return 0 for null/undefined second argument', () => {
      const box1: [number, number, number, number] = [0, 0, 10, 10];
      expect(iou(box1, null as any)).toBe(0);
      expect(iou(box1, undefined as any)).toBe(0);
    });

    it('should return 0 for arrays with wrong length', () => {
      const box1 = [0, 0, 10] as any; // too short
      const box2: [number, number, number, number] = [0, 0, 10, 10];
      expect(iou(box1, box2)).toBe(0);

      const box3 = [0, 0, 10, 10, 20] as any; // too long
      expect(iou(box3, box2)).toBe(0);
    });

    it('should return 0 for arrays containing NaN', () => {
      const box1: [number, number, number, number] = [0, NaN, 10, 10];
      const box2: [number, number, number, number] = [0, 0, 10, 10];
      expect(iou(box1, box2)).toBe(0);
    });

    it('should return 0 for arrays containing Infinity', () => {
      const box1: [number, number, number, number] = [0, 0, Infinity, 10];
      const box2: [number, number, number, number] = [0, 0, 10, 10];
      expect(iou(box1, box2)).toBe(0);
    });

    it('should return 0 for arrays containing non-numeric values', () => {
      const box1 = [0, 0, "10", 10] as any;
      const box2: [number, number, number, number] = [0, 0, 10, 10];
      expect(iou(box1, box2)).toBe(0);
    });

    it('should return 0 for empty arrays', () => {
      expect(iou([] as any, [] as any)).toBe(0);
    });
  });

  describe('precision', () => {
    it('should maintain precision for small boxes', () => {
      const box1: [number, number, number, number] = [0, 0, 0.1, 0.1];
      const box2: [number, number, number, number] = [0.05, 0.05, 0.15, 0.15];
      const result = iou(box1, box2);
      expect(result).toBeGreaterThan(0);
      expect(result).toBeLessThan(1);
    });

    it('should handle very large coordinates', () => {
      const box1: [number, number, number, number] = [1000, 1000, 2000, 2000];
      const box2: [number, number, number, number] = [1500, 1500, 2500, 2500];
      const result = iou(box1, box2);
      expect(result).toBeCloseTo(0.142857, 5);
    });
  });

  describe('symmetry', () => {
    it('should be symmetric (iou(a,b) = iou(b,a))', () => {
      const box1: [number, number, number, number] = [0, 0, 10, 10];
      const box2: [number, number, number, number] = [5, 5, 15, 15];
      expect(iou(box1, box2)).toBe(iou(box2, box1));
    });

    it('should be symmetric for all cases', () => {
      const testCases: Array<[[number, number, number, number], [number, number, number, number]]> = [
        [[0, 0, 10, 10], [20, 20, 30, 30]], // non-overlapping
        [[0, 0, 10, 10], [5, 5, 15, 15]], // overlapping
        [[0, 0, 20, 20], [5, 5, 15, 15]], // contained
        [[10, 10, 20, 20], [10, 10, 20, 20]], // identical
      ];

      testCases.forEach(([a, b]) => {
        expect(iou(a, b)).toBe(iou(b, a));
      });
    });
  });
});
