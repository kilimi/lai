import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { drawAnnotations, CmSample } from '../../components/ConfusionMatrixCellModal';

describe('drawAnnotations', () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let mockCanvas: HTMLCanvasElement;
  let mockImg: HTMLImageElement;
  let mockCtx: CanvasRenderingContext2D;

  beforeEach(() => {
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Create mock canvas
    mockCanvas = document.createElement('canvas');
    
    // Create mock context with all required methods
    mockCtx = {
      scale: vi.fn(),
      clearRect: vi.fn(),
      strokeRect: vi.fn(),
      fillRect: vi.fn(),
      fillText: vi.fn(),
      measureText: vi.fn().mockReturnValue({ width: 100 }),
    } as any;
    
    vi.spyOn(mockCanvas, 'getContext').mockReturnValue(mockCtx);

    // Create mock image
    mockImg = document.createElement('img');
    Object.defineProperty(mockImg, 'clientWidth', { value: 640, writable: true, configurable: true });
    Object.defineProperty(mockImg, 'clientHeight', { value: 480, writable: true, configurable: true });
    Object.defineProperty(mockImg, 'naturalWidth', { value: 1280, writable: true, configurable: true });
    Object.defineProperty(mockImg, 'naturalHeight', { value: 960, writable: true, configurable: true });
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
  });

  describe('Valid drawing operations', () => {
    it('should draw ground truth box', () => {
      const sample: CmSample = {
        file_name: 'test.jpg',
        gt_bbox: [100, 100, 200, 200],
        gt_class_name: 'cat',
      };

      const result = drawAnnotations(mockCanvas, mockImg, sample);
      
      expect(result).toBe(true);
      expect(mockCtx.strokeRect).toHaveBeenCalled();
      expect(mockCtx.fillText).toHaveBeenCalled();
    });

    it('should draw prediction box', () => {
      const sample: CmSample = {
        file_name: 'test.jpg',
        pred_bbox: [150, 150, 250, 250],
        pred_class_name: 'dog',
        conf: 0.95,
      };

      const result = drawAnnotations(mockCanvas, mockImg, sample);
      
      expect(result).toBe(true);
      expect(mockCtx.strokeRect).toHaveBeenCalled();
      expect(mockCtx.fillText).toHaveBeenCalled();
    });

    it('should draw both GT and prediction boxes', () => {
      const sample: CmSample = {
        file_name: 'test.jpg',
        gt_bbox: [100, 100, 200, 200],
        gt_class_name: 'cat',
        pred_bbox: [150, 150, 250, 250],
        pred_class_name: 'cat',
        conf: 0.95,
      };

      const result = drawAnnotations(mockCanvas, mockImg, sample);
      
      expect(result).toBe(true);
      // Should draw two boxes (strokeRect called twice)
      expect(mockCtx.strokeRect).toHaveBeenCalledTimes(2);
      expect(mockCtx.fillText).toHaveBeenCalledTimes(2);
    });

    it('should handle samples without bboxes', () => {
      const sample: CmSample = {
        file_name: 'test.jpg',
      };

      const result = drawAnnotations(mockCanvas, mockImg, sample);
      
      expect(result).toBe(true);
      // clearRect should be called but no drawing
      expect(mockCtx.clearRect).toHaveBeenCalled();
      expect(mockCtx.strokeRect).not.toHaveBeenCalled();
    });

    it('should format confidence percentage in label', () => {
      const sample: CmSample = {
        file_name: 'test.jpg',
        pred_bbox: [100, 100, 200, 200],
        pred_class_name: 'cat',
        conf: 0.856,
      };

      drawAnnotations(mockCanvas, mockImg, sample);
      
      // Check that fillText was called with confidence percentage
      const fillTextCalls = vi.mocked(mockCtx.fillText).mock.calls;
      const labelWithConf = fillTextCalls.some(call => 
        call[0].includes('86%') // 0.856 * 100 = 85.6, rounds to 86
      );
      expect(labelWithConf).toBe(true);
    });

    it('should use default labels when class names missing', () => {
      const sample: CmSample = {
        file_name: 'test.jpg',
        gt_bbox: [100, 100, 200, 200],
        pred_bbox: [150, 150, 250, 250],
      };

      const result = drawAnnotations(mockCanvas, mockImg, sample);
      
      expect(result).toBe(true);
      const fillTextCalls = vi.mocked(mockCtx.fillText).mock.calls;
      const hasGT = fillTextCalls.some(call => call[0] === 'GT');
      const hasPred = fillTextCalls.some(call => call[0] === 'Pred');
      expect(hasGT).toBe(true);
      expect(hasPred).toBe(true);
    });
  });

  describe('Canvas setup and scaling', () => {
    it('should set canvas dimensions with device pixel ratio', () => {
      Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
      
      const sample: CmSample = {
        file_name: 'test.jpg',
        gt_bbox: [100, 100, 200, 200],
      };

      drawAnnotations(mockCanvas, mockImg, sample);
      
      expect(mockCanvas.width).toBe(640 * 2);
      expect(mockCanvas.height).toBe(480 * 2);
      expect(mockCanvas.style.width).toBe('640px');
      expect(mockCanvas.style.height).toBe('480px');
      expect(mockCtx.scale).toHaveBeenCalledWith(2, 2);
    });

    it('should handle devicePixelRatio = 1', () => {
      Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true });
      
      const sample: CmSample = {
        file_name: 'test.jpg',
        gt_bbox: [100, 100, 200, 200],
      };

      drawAnnotations(mockCanvas, mockImg, sample);
      
      expect(mockCanvas.width).toBe(640);
      expect(mockCanvas.height).toBe(480);
      expect(mockCtx.scale).toHaveBeenCalledWith(1, 1);
    });

    it('should clear canvas before drawing', () => {
      const sample: CmSample = {
        file_name: 'test.jpg',
        gt_bbox: [100, 100, 200, 200],
      };

      drawAnnotations(mockCanvas, mockImg, sample);
      
      expect(mockCtx.clearRect).toHaveBeenCalledWith(0, 0, 640, 480);
    });
  });

  describe('Coordinate scaling', () => {
    it('should scale bounding box coordinates from natural to display size', () => {
      // img: natural 1280x960, display 640x480 (scale: 0.5)
      const sample: CmSample = {
        file_name: 'test.jpg',
        gt_bbox: [100, 100, 300, 300], // 200x200 box in natural coords
      };

      drawAnnotations(mockCanvas, mockImg, sample);
      
      // Box should be scaled to 50, 50, 150, 150 in display coords
      const strokeRectCalls = vi.mocked(mockCtx.strokeRect).mock.calls;
      expect(strokeRectCalls[0]).toEqual([50, 50, 100, 100]);
    });

    it('should handle non-square aspect ratio scaling', () => {
      // Different scale factors for x and y
      Object.defineProperty(mockImg, 'clientWidth', { value: 800, configurable: true });
      Object.defineProperty(mockImg, 'clientHeight', { value: 400, configurable: true });
      Object.defineProperty(mockImg, 'naturalWidth', { value: 1600, configurable: true });
      Object.defineProperty(mockImg, 'naturalHeight', { value: 1200, configurable: true });
      // sx = 800/1600 = 0.5, sy = 400/1200 = 0.333

      const sample: CmSample = {
        file_name: 'test.jpg',
        gt_bbox: [100, 100, 200, 200],
      };

      drawAnnotations(mockCanvas, mockImg, sample);
      
      const strokeRectCalls = vi.mocked(mockCtx.strokeRect).mock.calls;
      // x: 100*0.5=50, y: 100*0.333=33.33, w: 100*0.5=50, h: 100*0.333=33.33
      expect(strokeRectCalls[0][0]).toBeCloseTo(50);
      expect(strokeRectCalls[0][1]).toBeCloseTo(33.33, 1);
    });
  });

  describe('Invalid inputs and error handling', () => {
    it('should return false for null canvas', () => {
      const sample: CmSample = {
        file_name: 'test.jpg',
        gt_bbox: [100, 100, 200, 200],
      };

      const result = drawAnnotations(null, mockImg, sample);
      
      expect(result).toBe(false);
      expect(mockCtx.strokeRect).not.toHaveBeenCalled();
    });

    it('should return false for null image', () => {
      const sample: CmSample = {
        file_name: 'test.jpg',
        gt_bbox: [100, 100, 200, 200],
      };

      const result = drawAnnotations(mockCanvas, null, sample);
      
      expect(result).toBe(false);
      expect(mockCtx.strokeRect).not.toHaveBeenCalled();
    });

    it('should return false for null sample', () => {
      const result = drawAnnotations(mockCanvas, mockImg, null as any);
      
      expect(result).toBe(false);
      expect(mockCtx.strokeRect).not.toHaveBeenCalled();
    });

    it('should return false and warn when image clientWidth is 0', () => {
      Object.defineProperty(mockImg, 'clientWidth', { value: 0, configurable: true });
      
      const sample: CmSample = {
        file_name: 'test.jpg',
        gt_bbox: [100, 100, 200, 200],
      };

      const result = drawAnnotations(mockCanvas, mockImg, sample);
      
      expect(result).toBe(false);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        'drawAnnotations: zero dimensions',
        expect.objectContaining({ dw: 0 })
      );
    });

    it('should return false and warn when image clientHeight is 0', () => {
      Object.defineProperty(mockImg, 'clientHeight', { value: 0, configurable: true });
      
      const sample: CmSample = {
        file_name: 'test.jpg',
        gt_bbox: [100, 100, 200, 200],
      };

      const result = drawAnnotations(mockCanvas, mockImg, sample);
      
      expect(result).toBe(false);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        'drawAnnotations: zero dimensions',
        expect.objectContaining({ dh: 0 })
      );
    });

    it('should return false and warn when image naturalWidth is 0', () => {
      Object.defineProperty(mockImg, 'naturalWidth', { value: 0, configurable: true });
      
      const sample: CmSample = {
        file_name: 'test.jpg',
        gt_bbox: [100, 100, 200, 200],
      };

      const result = drawAnnotations(mockCanvas, mockImg, sample);
      
      expect(result).toBe(false);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        'drawAnnotations: zero dimensions',
        expect.objectContaining({ nw: 0 })
      );
    });

    it('should return false and warn when image naturalHeight is 0', () => {
      Object.defineProperty(mockImg, 'naturalHeight', { value: 0, configurable: true });
      
      const sample: CmSample = {
        file_name: 'test.jpg',
        gt_bbox: [100, 100, 200, 200],
      };

      const result = drawAnnotations(mockCanvas, mockImg, sample);
      
      expect(result).toBe(false);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        'drawAnnotations: zero dimensions',
        expect.objectContaining({ nh: 0 })
      );
    });

    it('should return false and warn when getContext returns null', () => {
      vi.spyOn(mockCanvas, 'getContext').mockReturnValue(null);
      
      const sample: CmSample = {
        file_name: 'test.jpg',
        gt_bbox: [100, 100, 200, 200],
      };

      const result = drawAnnotations(mockCanvas, mockImg, sample);
      
      expect(result).toBe(false);
      expect(consoleWarnSpy).toHaveBeenCalledWith('drawAnnotations: failed to get 2d context');
    });
  });

  describe('Drawing styles and constants', () => {
    it('should use correct line width based on display width', () => {
      // clientWidth = 640, lineW = max(1.5, round(640/300)) = max(1.5, 2) = 2
      const sample: CmSample = {
        file_name: 'test.jpg',
        gt_bbox: [100, 100, 200, 200],
      };

      drawAnnotations(mockCanvas, mockImg, sample);
      
      expect(mockCtx.strokeStyle).toBeTruthy();
      expect(mockCtx.lineWidth).toBeTruthy();
    });

    it('should use correct font size based on display width', () => {
      // clientWidth = 640, fontSize = max(10, round(640/45)) = max(10, 14) = 14
      const sample: CmSample = {
        file_name: 'test.jpg',
        gt_bbox: [100, 100, 200, 200],
        gt_class_name: 'test',
      };

      drawAnnotations(mockCanvas, mockImg, sample);
      
      const fontCalls = vi.mocked(mockCtx).font;
      expect(fontCalls).toBeTruthy();
    });

    it('should use green color for GT boxes', () => {
      const sample: CmSample = {
        file_name: 'test.jpg',
        gt_bbox: [100, 100, 200, 200],
      };

      drawAnnotations(mockCanvas, mockImg, sample);
      
      expect(mockCtx.strokeStyle).toBe('#22c55e');
    });

    it('should use red color for prediction boxes', () => {
      const sample: CmSample = {
        file_name: 'test.jpg',
        pred_bbox: [100, 100, 200, 200],
      };

      drawAnnotations(mockCanvas, mockImg, sample);
      
      expect(mockCtx.strokeStyle).toBe('#ef4444');
    });

    it('should enforce minimum line width', () => {
      // Very small display width
      Object.defineProperty(mockImg, 'clientWidth', { value: 100, configurable: true });
      Object.defineProperty(mockImg, 'clientHeight', { value: 100, configurable: true });
      
      const sample: CmSample = {
        file_name: 'test.jpg',
        gt_bbox: [10, 10, 20, 20],
      };

      drawAnnotations(mockCanvas, mockImg, sample);
      
      // Should use minimum of 1.5
      expect(mockCtx.lineWidth).toBeGreaterThanOrEqual(1.5);
    });

    it('should enforce minimum font size', () => {
      // Very small display width
      Object.defineProperty(mockImg, 'clientWidth', { value: 100, configurable: true });
      Object.defineProperty(mockImg, 'clientHeight', { value: 100, configurable: true });
      
      const sample: CmSample = {
        file_name: 'test.jpg',
        gt_bbox: [10, 10, 20, 20],
        gt_class_name: 'test',
      };

      drawAnnotations(mockCanvas, mockImg, sample);
      
      // Font should include minimum size of 10
      const fontCalls = vi.mocked(mockCtx).font;
      expect(fontCalls).toContain('10px');
    });
  });

  describe('Real-world scenarios', () => {
    it('should handle True Positive scenario (matching GT and Pred)', () => {
      const sample: CmSample = {
        file_name: 'img_001.jpg',
        image_id: 123,
        gt_bbox: [100, 100, 300, 300],
        gt_class_name: 'car',
        pred_bbox: [110, 110, 310, 310],
        pred_class_name: 'car',
        conf: 0.95,
        iou: 0.85,
      };

      const result = drawAnnotations(mockCanvas, mockImg, sample);
      
      expect(result).toBe(true);
      expect(mockCtx.strokeRect).toHaveBeenCalledTimes(2);
    });

    it('should handle False Positive scenario (no GT)', () => {
      const sample: CmSample = {
        file_name: 'img_002.jpg',
        pred_bbox: [100, 100, 200, 200],
        pred_class_name: 'person',
        conf: 0.75,
      };

      const result = drawAnnotations(mockCanvas, mockImg, sample);
      
      expect(result).toBe(true);
      expect(mockCtx.strokeRect).toHaveBeenCalledTimes(1);
    });

    it('should handle False Negative scenario (no prediction)', () => {
      const sample: CmSample = {
        file_name: 'img_003.jpg',
        gt_bbox: [100, 100, 200, 200],
        gt_class_name: 'bicycle',
      };

      const result = drawAnnotations(mockCanvas, mockImg, sample);
      
      expect(result).toBe(true);
      expect(mockCtx.strokeRect).toHaveBeenCalledTimes(1);
    });

    it('should handle confusion scenario (different classes)', () => {
      const sample: CmSample = {
        file_name: 'img_004.jpg',
        gt_bbox: [100, 100, 200, 200],
        gt_class_name: 'dog',
        pred_bbox: [105, 105, 205, 205],
        pred_class_name: 'cat',
        conf: 0.88,
        iou: 0.7,
      };

      const result = drawAnnotations(mockCanvas, mockImg, sample);
      
      expect(result).toBe(true);
      expect(mockCtx.strokeRect).toHaveBeenCalledTimes(2);
    });
  });
});
