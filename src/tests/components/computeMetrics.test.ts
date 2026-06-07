/**
 * Unit tests for computeMetrics function
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { computeMetrics, RawPrediction, RawGTBox } from '../../components/ThresholdExplorer';

describe('computeMetrics function', () => {
  const classNames = ['cat', 'dog', 'background'];
  const numRealClasses = 2;
  const imageIdToFilename = { '1': 'image1.jpg', '2': 'image2.jpg' };

  describe('basic metrics calculation', () => {
    it('should calculate perfect precision and recall', () => {
      const predictions: RawPrediction[] = [
        { image_id: 1, class_id: 0, bbox_xyxy: [10, 10, 20, 20], conf: 0.9 }
      ];
      const groundTruth: RawGTBox[] = [
        { image_id: 1, file_name: 'image1.jpg', class_id: 0, bbox: [10, 10, 20, 20], class_name: 'cat' }
      ];

      const result = computeMetrics(
        predictions,
        groundTruth,
        0.5,
        0.5,
        numRealClasses,
        [-1, -1],
        classNames,
        imageIdToFilename
      );

      expect(result.precision).toBe(1);
      expect(result.recall).toBe(1);
      expect(result.f1).toBe(1);
      expect(result.tp).toBe(1);
      expect(result.fp).toBe(0);
      expect(result.fn).toBe(0);
    });

    it('should handle false positives', () => {
      const predictions: RawPrediction[] = [
        { image_id: 1, class_id: 0, bbox_xyxy: [10, 10, 20, 20], conf: 0.9 },
        { image_id: 1, class_id: 0, bbox_xyxy: [50, 50, 60, 60], conf: 0.8 } // FP
      ];
      const groundTruth: RawGTBox[] = [
        { image_id: 1, file_name: 'image1.jpg', class_id: 0, bbox: [10, 10, 20, 20], class_name: 'cat' }
      ];

      const result = computeMetrics(
        predictions,
        groundTruth,
        0.5,
        0.5,
        numRealClasses,
        [-1, -1],
        classNames,
        imageIdToFilename
      );

      expect(result.tp).toBe(1);
      expect(result.fp).toBe(1);
      expect(result.fn).toBe(0);
      expect(result.precision).toBeCloseTo(0.5, 5);
      expect(result.recall).toBe(1);
    });

    it('should handle false negatives', () => {
      const predictions: RawPrediction[] = [
        { image_id: 1, class_id: 0, bbox_xyxy: [10, 10, 20, 20], conf: 0.9 }
      ];
      const groundTruth: RawGTBox[] = [
        { image_id: 1, file_name: 'image1.jpg', class_id: 0, bbox: [10, 10, 20, 20], class_name: 'cat' },
        { image_id: 1, file_name: 'image1.jpg', class_id: 0, bbox: [50, 50, 60, 60], class_name: 'cat' } // FN
      ];

      const result = computeMetrics(
        predictions,
        groundTruth,
        0.5,
        0.5,
        numRealClasses,
        [-1, -1],
        classNames,
        imageIdToFilename
      );

      expect(result.tp).toBe(1);
      expect(result.fp).toBe(0);
      expect(result.fn).toBe(1);
      expect(result.precision).toBe(1);
      expect(result.recall).toBeCloseTo(0.5, 5);
    });

    it('should handle empty predictions', () => {
      const predictions: RawPrediction[] = [];
      const groundTruth: RawGTBox[] = [
        { image_id: 1, file_name: 'image1.jpg', class_id: 0, bbox: [10, 10, 20, 20], class_name: 'cat' }
      ];

      const result = computeMetrics(
        predictions,
        groundTruth,
        0.5,
        0.5,
        numRealClasses,
        [-1, -1],
        classNames,
        imageIdToFilename
      );

      expect(result.tp).toBe(0);
      expect(result.fp).toBe(0);
      expect(result.fn).toBe(1);
      expect(result.precision).toBe(0);
      expect(result.recall).toBe(0);
      expect(result.f1).toBe(0);
    });

    it('should handle empty ground truth', () => {
      const predictions: RawPrediction[] = [
        { image_id: 1, class_id: 0, bbox_xyxy: [10, 10, 20, 20], conf: 0.9 }
      ];
      const groundTruth: RawGTBox[] = [];

      const result = computeMetrics(
        predictions,
        groundTruth,
        0.5,
        0.5,
        numRealClasses,
        [-1, -1],
        classNames,
        imageIdToFilename
      );

      expect(result.tp).toBe(0);
      expect(result.fp).toBe(1);
      expect(result.fn).toBe(0);
      expect(result.precision).toBe(0);
      expect(result.recall).toBe(0);
    });
  });

  describe('confidence threshold filtering', () => {
    it('should filter predictions below global confidence threshold', () => {
      const predictions: RawPrediction[] = [
        { image_id: 1, class_id: 0, bbox_xyxy: [10, 10, 20, 20], conf: 0.9 },
        { image_id: 1, class_id: 0, bbox_xyxy: [30, 30, 40, 40], conf: 0.3 } // below threshold
      ];
      const groundTruth: RawGTBox[] = [
        { image_id: 1, file_name: 'image1.jpg', class_id: 0, bbox: [10, 10, 20, 20], class_name: 'cat' },
        { image_id: 1, file_name: 'image1.jpg', class_id: 0, bbox: [30, 30, 40, 40], class_name: 'cat' }
      ];

      const result = computeMetrics(
        predictions,
        groundTruth,
        0.5, // global confidence threshold
        0.5,
        numRealClasses,
        [-1, -1],
        classNames,
        imageIdToFilename
      );

      expect(result.tp).toBe(1);
      expect(result.fn).toBe(1); // second GT not matched
    });

    it('should use per-class confidence threshold when set', () => {
      const predictions: RawPrediction[] = [
        { image_id: 1, class_id: 0, bbox_xyxy: [10, 10, 20, 20], conf: 0.7 },
        { image_id: 1, class_id: 1, bbox_xyxy: [30, 30, 40, 40], conf: 0.3 }
      ];
      const groundTruth: RawGTBox[] = [
        { image_id: 1, file_name: 'image1.jpg', class_id: 0, bbox: [10, 10, 20, 20], class_name: 'cat' },
        { image_id: 1, file_name: 'image1.jpg', class_id: 1, bbox: [30, 30, 40, 40], class_name: 'dog' }
      ];

      const result = computeMetrics(
        predictions,
        groundTruth,
        0.5,
        0.5,
        numRealClasses,
        [0.8, 0.2], // class 0 needs 0.8, class 1 needs 0.2
        classNames,
        imageIdToFilename
      );

      // class 0 prediction filtered (0.7 < 0.8), class 1 passes (0.3 >= 0.2)
      expect(result.tp).toBe(1);
      expect(result.fn).toBe(1);
    });
  });

  describe('IoU threshold behavior', () => {
    it('should match predictions above IoU threshold', () => {
      const predictions: RawPrediction[] = [
        { image_id: 1, class_id: 0, bbox_xyxy: [10, 10, 20, 20], conf: 0.9 }
      ];
      const groundTruth: RawGTBox[] = [
        { image_id: 1, file_name: 'image1.jpg', class_id: 0, bbox: [12, 12, 22, 22], class_name: 'cat' }
      ];

      const result = computeMetrics(
        predictions,
        groundTruth,
        0.5,
        0.3, // Low IoU threshold - should match
        numRealClasses,
        [-1, -1],
        classNames,
        imageIdToFilename
      );

      expect(result.tp).toBe(1);
    });

    it('should not match predictions below IoU threshold', () => {
      const predictions: RawPrediction[] = [
        { image_id: 1, class_id: 0, bbox_xyxy: [10, 10, 20, 20], conf: 0.9 }
      ];
      const groundTruth: RawGTBox[] = [
        { image_id: 1, file_name: 'image1.jpg', class_id: 0, bbox: [50, 50, 60, 60], class_name: 'cat' }
      ];

      const result = computeMetrics(
        predictions,
        groundTruth,
        0.5,
        0.5,
        numRealClasses,
        [-1, -1],
        classNames,
        imageIdToFilename
      );

      expect(result.tp).toBe(0);
      expect(result.fp).toBe(1);
      expect(result.fn).toBe(1);
    });
  });

  describe('confusion matrix', () => {
    it('should populate confusion matrix for correct predictions', () => {
      const predictions: RawPrediction[] = [
        { image_id: 1, class_id: 0, bbox_xyxy: [10, 10, 20, 20], conf: 0.9 },
        { image_id: 1, class_id: 1, bbox_xyxy: [30, 30, 40, 40], conf: 0.8 }
      ];
      const groundTruth: RawGTBox[] = [
        { image_id: 1, file_name: 'image1.jpg', class_id: 0, bbox: [10, 10, 20, 20], class_name: 'cat' },
        { image_id: 1, file_name: 'image1.jpg', class_id: 1, bbox: [30, 30, 40, 40], class_name: 'dog' }
      ];

      const result = computeMetrics(
        predictions,
        groundTruth,
        0.5,
        0.5,
        numRealClasses,
        [-1, -1],
        classNames,
        imageIdToFilename
      );

      // Diagonal should have the true positives
      expect(result.cm[0][0]).toBe(1); // cat predicted as cat
      expect(result.cm[1][1]).toBe(1); // dog predicted as dog
    });

    it('should populate confusion matrix for misclassifications', () => {
      const predictions: RawPrediction[] = [
        { image_id: 1, class_id: 1, bbox_xyxy: [10, 10, 20, 20], conf: 0.9 } // predict dog
      ];
      const groundTruth: RawGTBox[] = [
        { image_id: 1, file_name: 'image1.jpg', class_id: 0, bbox: [10, 10, 20, 20], class_name: 'cat' } // GT cat
      ];

      const result = computeMetrics(
        predictions,
        groundTruth,
        0.5,
        0.5,
        numRealClasses,
        [-1, -1],
        classNames,
        imageIdToFilename
      );

      // Row = GT, Col = Predicted
      expect(result.cm[0][1]).toBe(1); // cat predicted as dog
    });

    it('should track false positives in background row', () => {
      const predictions: RawPrediction[] = [
        { image_id: 1, class_id: 0, bbox_xyxy: [50, 50, 60, 60], conf: 0.9 } // no matching GT
      ];
      const groundTruth: RawGTBox[] = [];

      const result = computeMetrics(
        predictions,
        groundTruth,
        0.5,
        0.5,
        numRealClasses,
        [-1, -1],
        classNames,
        imageIdToFilename
      );

      // Last row (background) should have the false positive
      expect(result.cm[numRealClasses][0]).toBe(1);
    });

    it('should track false negatives in background column', () => {
      const predictions: RawPrediction[] = [];
      const groundTruth: RawGTBox[] = [
        { image_id: 1, file_name: 'image1.jpg', class_id: 0, bbox: [10, 10, 20, 20], class_name: 'cat' }
      ];

      const result = computeMetrics(
        predictions,
        groundTruth,
        0.5,
        0.5,
        numRealClasses,
        [-1, -1],
        classNames,
        imageIdToFilename
      );

      // Last column (not found) should have the false negative
      expect(result.cm[0][numRealClasses]).toBe(1);
    });
  });

  describe('per-class metrics', () => {
    it('should calculate per-class precision and recall', () => {
      const predictions: RawPrediction[] = [
        { image_id: 1, class_id: 0, bbox_xyxy: [10, 10, 20, 20], conf: 0.9 },
        { image_id: 1, class_id: 0, bbox_xyxy: [50, 50, 60, 60], conf: 0.8 } // FP
      ];
      const groundTruth: RawGTBox[] = [
        { image_id: 1, file_name: 'image1.jpg', class_id: 0, bbox: [10, 10, 20, 20], class_name: 'cat' }
      ];

      const result = computeMetrics(
        predictions,
        groundTruth,
        0.5,
        0.5,
        numRealClasses,
        [-1, -1],
        classNames,
        imageIdToFilename
      );

      const catMetrics = result.perClass[0];
      expect(catMetrics.name).toBe('cat');
      expect(catMetrics.tp).toBe(1);
      expect(catMetrics.fp).toBe(1);
      expect(catMetrics.fn).toBe(0);
      expect(catMetrics.precision).toBeCloseTo(0.5, 5);
      expect(catMetrics.recall).toBe(1);
    });
  });

  describe('invalid input handling', () => {
    it('should filter predictions with invalid class_id', () => {
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      
      const predictions: RawPrediction[] = [
        { image_id: 1, class_id: 999, bbox_xyxy: [10, 10, 20, 20], conf: 0.9 }, // invalid
        { image_id: 1, class_id: 0, bbox_xyxy: [30, 30, 40, 40], conf: 0.9 } // valid
      ];
      const groundTruth: RawGTBox[] = [
        { image_id: 1, file_name: 'image1.jpg', class_id: 0, bbox: [30, 30, 40, 40], class_name: 'cat' }
      ];

      const result = computeMetrics(
        predictions,
        groundTruth,
        0.5,
        0.5,
        numRealClasses,
        [-1, -1],
        classNames,
        imageIdToFilename
      );

      expect(result.tp).toBe(1);
      expect(consoleWarn).toHaveBeenCalledWith(
        expect.stringContaining('Invalid class_id 999')
      );
      
      consoleWarn.mockRestore();
    });

    it('should filter predictions with negative class_id', () => {
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      
      const predictions: RawPrediction[] = [
        { image_id: 1, class_id: -1, bbox_xyxy: [10, 10, 20, 20], conf: 0.9 }
      ];
      const groundTruth: RawGTBox[] = [];

      const result = computeMetrics(
        predictions,
        groundTruth,
        0.5,
        0.5,
        numRealClasses,
        [-1, -1],
        classNames,
        imageIdToFilename
      );

      expect(result.tp).toBe(0);
      expect(result.fp).toBe(0);
      expect(consoleWarn).toHaveBeenCalled();
      
      consoleWarn.mockRestore();
    });

    it('should filter ground truth with invalid class_id', () => {
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      
      const predictions: RawPrediction[] = [];
      const groundTruth: RawGTBox[] = [
        { image_id: 1, file_name: 'image1.jpg', class_id: 999, bbox: [10, 10, 20, 20], class_name: 'invalid' }
      ];

      const result = computeMetrics(
        predictions,
        groundTruth,
        0.5,
        0.5,
        numRealClasses,
        [-1, -1],
        classNames,
        imageIdToFilename
      );

      expect(result.fn).toBe(0); // Invalid GT not counted
      expect(consoleWarn).toHaveBeenCalledWith(
        expect.stringContaining('Invalid GT class_id 999')
      );
      
      consoleWarn.mockRestore();
    });

    it('should filter predictions with invalid image_id', () => {
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      
      const predictions: RawPrediction[] = [
        { image_id: NaN, class_id: 0, bbox_xyxy: [10, 10, 20, 20], conf: 0.9 }
      ];
      const groundTruth: RawGTBox[] = [];

      const result = computeMetrics(
        predictions,
        groundTruth,
        0.5,
        0.5,
        numRealClasses,
        [-1, -1],
        classNames,
        imageIdToFilename
      );

      expect(result.tp).toBe(0);
      expect(result.fp).toBe(0);
      expect(consoleWarn).toHaveBeenCalledWith(
        expect.stringContaining('Invalid image_id')
      );
      
      consoleWarn.mockRestore();
    });

    it('should handle out-of-bounds perClassConf array access', () => {
      const predictions: RawPrediction[] = [
        { image_id: 1, class_id: 0, bbox_xyxy: [10, 10, 20, 20], conf: 0.9 }
      ];
      const groundTruth: RawGTBox[] = [
        { image_id: 1, file_name: 'image1.jpg', class_id: 0, bbox: [10, 10, 20, 20], class_name: 'cat' }
      ];

      // Shorter perClassConf array than needed
      const result = computeMetrics(
        predictions,
        groundTruth,
        0.5,
        0.5,
        numRealClasses,
        [-1], // only 1 element, but class_id 0 exists
        classNames,
        imageIdToFilename
      );

      // Should fall back to global threshold and not crash
      expect(result.tp).toBe(1);
    });
  });

  describe('multi-image scenarios', () => {
    it('should handle predictions across multiple images', () => {
      const predictions: RawPrediction[] = [
        { image_id: 1, class_id: 0, bbox_xyxy: [10, 10, 20, 20], conf: 0.9 },
        { image_id: 2, class_id: 1, bbox_xyxy: [30, 30, 40, 40], conf: 0.8 }
      ];
      const groundTruth: RawGTBox[] = [
        { image_id: 1, file_name: 'image1.jpg', class_id: 0, bbox: [10, 10, 20, 20], class_name: 'cat' },
        { image_id: 2, file_name: 'image2.jpg', class_id: 1, bbox: [30, 30, 40, 40], class_name: 'dog' }
      ];

      const result = computeMetrics(
        predictions,
        groundTruth,
        0.5,
        0.5,
        numRealClasses,
        [-1, -1],
        classNames,
        imageIdToFilename
      );

      expect(result.tp).toBe(2);
      expect(result.fp).toBe(0);
      expect(result.fn).toBe(0);
    });

    it('should handle images with no predictions', () => {
      const predictions: RawPrediction[] = [
        { image_id: 1, class_id: 0, bbox_xyxy: [10, 10, 20, 20], conf: 0.9 }
      ];
      const groundTruth: RawGTBox[] = [
        { image_id: 1, file_name: 'image1.jpg', class_id: 0, bbox: [10, 10, 20, 20], class_name: 'cat' },
        { image_id: 2, file_name: 'image2.jpg', class_id: 1, bbox: [30, 30, 40, 40], class_name: 'dog' }
      ];

      const result = computeMetrics(
        predictions,
        groundTruth,
        0.5,
        0.5,
        numRealClasses,
        [-1, -1],
        classNames,
        imageIdToFilename
      );

      expect(result.tp).toBe(1);
      expect(result.fn).toBe(1); // dog in image 2 not detected
    });

    it('should handle images with no ground truth', () => {
      const predictions: RawPrediction[] = [
        { image_id: 1, class_id: 0, bbox_xyxy: [10, 10, 20, 20], conf: 0.9 },
        { image_id: 2, class_id: 0, bbox_xyxy: [30, 30, 40, 40], conf: 0.8 }
      ];
      const groundTruth: RawGTBox[] = [
        { image_id: 1, file_name: 'image1.jpg', class_id: 0, bbox: [10, 10, 20, 20], class_name: 'cat' }
      ];

      const result = computeMetrics(
        predictions,
        groundTruth,
        0.5,
        0.5,
        numRealClasses,
        [-1, -1],
        classNames,
        imageIdToFilename
      );

      expect(result.tp).toBe(1);
      expect(result.fp).toBe(1); // prediction in image 2 has no GT
    });
  });

  describe('greedy matching behavior', () => {
    it('should use greedy matching (first prediction gets first pick)', () => {
      // Two predictions close to same GT - first one should match
      const predictions: RawPrediction[] = [
        { image_id: 1, class_id: 0, bbox_xyxy: [10, 10, 20, 20], conf: 0.9 },
        { image_id: 1, class_id: 0, bbox_xyxy: [11, 11, 21, 21], conf: 0.95 } // better IoU but second
      ];
      const groundTruth: RawGTBox[] = [
        { image_id: 1, file_name: 'image1.jpg', class_id: 0, bbox: [10, 10, 20, 20], class_name: 'cat' }
      ];

      const result = computeMetrics(
        predictions,
        groundTruth,
        0.5,
        0.5,
        numRealClasses,
        [-1, -1],
        classNames,
        imageIdToFilename
      );

      expect(result.tp).toBe(1);
      expect(result.fp).toBe(1); // second prediction becomes FP
    });
  });
});
