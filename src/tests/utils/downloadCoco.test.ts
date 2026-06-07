import { describe, it, expect, vi } from 'vitest';
import { buildCocoFromSamples, downloadCocoFile, validateCocoData } from '../../utils/downloadCoco';
import { AnnotationSample } from '../../utils/annotations';

describe('downloadCoco utilities', () => {
  describe('buildCocoFromSamples', () => {
    it('should build COCO data with bboxes and masks', () => {
      const samples: AnnotationSample[] = [
        {
          id: '1',
          imageId: '1',
          className: 'person',
          bbox: [10, 20, 100, 150],
          segmentation: [[10, 20, 110, 20, 110, 170, 10, 170]],
          area: 100 * 150,
          confidence: 1.0,
          color: '#FF0000',
          isVisible: true,
          showBboxes: true,
        },
        {
          id: '2',
          imageId: '1',
          className: 'car',
          bbox: [0, 0, 0, 0], // Empty bbox
          segmentation: [[200, 200, 300, 200, 300, 300, 200, 300]],
          area: 100 * 100,
          confidence: 1.0,
          color: '#00FF00',
          isVisible: true,
          showBboxes: true,
        }
      ];

      const imageDimensions = {
        '1': { width: 640, height: 480 }
      };

      const cocoData = buildCocoFromSamples(samples, imageDimensions);

      // Check structure
      expect(cocoData.images).toHaveLength(1);
      expect(cocoData.categories).toHaveLength(2);
      expect(cocoData.annotations).toHaveLength(2);

      // Check categories
      expect(cocoData.categories.map(c => c.name)).toContain('person');
      expect(cocoData.categories.map(c => c.name)).toContain('car');

      // Check first annotation (has both bbox and segmentation)
      expect(cocoData.annotations[0]).toMatchObject({
        category_id: 1, // person
        bbox: [10, 20, 100, 150],
        segmentation: [[10, 20, 110, 20, 110, 170, 10, 170]],
        area: 15000
      });

      // Check second annotation (mask-only)
      expect(cocoData.annotations[1]).toMatchObject({
        category_id: 2, // car
        segmentation: [[200, 200, 300, 200, 300, 300, 200, 300]],
        area: 10000
      });
    });

    it('should handle normalized bbox coordinates', () => {
      const samples: AnnotationSample[] = [
        {
          id: '1',
          imageId: '1',
          className: 'object',
          bbox: [0.1, 0.2, 0.5, 0.6], // normalized (0-1)
          area: 0.3 * 0.4,
          confidence: 1.0,
          color: '#FF0000',
          isVisible: true,
          showBboxes: true,
        }
      ];

      const imageDimensions = {
        '1': { width: 640, height: 480 }
      };

      const cocoData = buildCocoFromSamples(samples, imageDimensions);

      // Should convert to pixel coordinates
      expect(cocoData.annotations[0].bbox).toEqual([
        0.1 * 640,  // 64
        0.2 * 480,  // 96
        0.5 * 640,  // 320
        0.6 * 480   // 288
      ]);
    });

    it('should handle absolute bbox coordinates without conversion', () => {
      const samples: AnnotationSample[] = [
        {
          id: '1',
          imageId: '1',
          className: 'object',
          bbox: [100, 200, 300, 400], // absolute pixel coordinates
          area: 300 * 400,
          confidence: 1.0,
          color: '#FF0000',
          isVisible: true,
          showBboxes: true,
        }
      ];

      const imageDimensions = {
        '1': { width: 1920, height: 1080 }
      };

      const cocoData = buildCocoFromSamples(samples, imageDimensions);

      // Should keep as-is
      expect(cocoData.annotations[0].bbox).toEqual([100, 200, 300, 400]);
    });

    it('should include only bboxes when segmentation is empty', () => {
      const samples: AnnotationSample[] = [
        {
          id: '1',
          imageId: '1',
          className: 'object',
          bbox: [10, 20, 100, 150],
          segmentation: [],
          area: 100 * 150,
          confidence: 1.0,
          color: '#FF0000',
          isVisible: true,
          showBboxes: true,
        }
      ];

      const imageDimensions = {
        '1': { width: 640, height: 480 }
      };

      const cocoData = buildCocoFromSamples(samples, imageDimensions);

      expect(cocoData.annotations[0]).toHaveProperty('bbox');
      expect(cocoData.annotations[0]).not.toHaveProperty('segmentation');
    });

    it('should handle multiple images', () => {
      const samples: AnnotationSample[] = [
        {
          id: '1',
          imageId: 'img1',
          className: 'class1',
          bbox: [10, 20, 100, 150],
          area: 15000,
          confidence: 1.0,
          color: '#FF0000',
          isVisible: true,
          showBboxes: true,
        },
        {
          id: '2',
          imageId: 'img2',
          className: 'class1',
          bbox: [5, 10, 50, 75],
          area: 3750,
          confidence: 1.0,
          color: '#FF0000',
          isVisible: true,
          showBboxes: true,
        }
      ];

      const imageDimensions = {
        'img1': { width: 640, height: 480 },
        'img2': { width: 800, height: 600 }
      };

      const imageMapping = {
        'img1': 'test1.jpg',
        'img2': 'test2.jpg'
      };

      const cocoData = buildCocoFromSamples(samples, imageDimensions, imageMapping);

      expect(cocoData.images).toHaveLength(2);
      expect(cocoData.images.map(i => i.file_name)).toEqual(['test1.jpg', 'test2.jpg']);
    });
  });

  describe('validateCocoData', () => {
    it('should count annotations with bbox and segmentation', () => {
      const cocoData = {
        info: {},
        images: [],
        categories: [],
        annotations: [
          { id: 1, bbox: [0, 0, 100, 100], segmentation: [[0, 0, 100, 0, 100, 100, 0, 100]] },
          { id: 2, bbox: [10, 10, 50, 50] }, // bbox only
          { id: 3, segmentation: [[200, 200, 300, 200, 300, 300, 200, 300]] }, // mask only
          { id: 4 } // neither
        ]
      };

      const stats = validateCocoData(cocoData);

      expect(stats.totalAnnotations).toBe(4);
      expect(stats.withBbox).toBe(2);
      expect(stats.withSegmentation).toBe(2);
      expect(stats.withBoth).toBe(1);
    });

    it('should handle empty annotations array', () => {
      const cocoData = {
        info: {},
        images: [],
        categories: [],
        annotations: []
      };

      const stats = validateCocoData(cocoData);

      expect(stats.totalAnnotations).toBe(0);
      expect(stats.withBbox).toBe(0);
      expect(stats.withSegmentation).toBe(0);
      expect(stats.withBoth).toBe(0);
    });
  });

  describe('downloadCocoFile', () => {
    it('should be a valid export function', () => {
      // This function is primarily browser-based and cannot be fully tested in Node.js
      // The real-world test is manual verification in the browser
      expect(typeof downloadCocoFile).toBe('function');
    });
  });
});
