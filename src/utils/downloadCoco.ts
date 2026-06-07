/**
 * Utility functions for downloading COCO-format annotation files.
 * Consolidates download logic used across Dataset view and Model Evaluation.
 */

import { AnnotationSample } from './annotations';

export interface CocoData {
  info?: {
    description?: string;
    version?: string;
    year?: number;
    contributor?: string;
    date_created?: string;
  };
  licenses?: Array<{ id: number; name: string; url: string }>;
  images: Array<{ id: number; file_name: string; width: number; height: number }>;
  categories: Array<{ id: number; name: string; supercategory?: string }>;
  annotations: Array<any>;
}

/**
 * Download a COCO format JSON file to the browser
 * @param cocoData - The COCO format data to download
 * @param filename - Name of the file to download (without .json extension)
 */
export function downloadCocoFile(cocoData: CocoData, filename: string): void {
  const dataStr = JSON.stringify(cocoData, null, 2);
  const dataBlob = new Blob([dataStr], { type: 'application/json' });
  const url = URL.createObjectURL(dataBlob);

  const link = document.createElement('a');
  link.href = url;
  link.download = `${filename}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Build COCO data from AnnotationSample array (local format)
 * Includes both bounding boxes and segmentation masks if available
 * 
 * @param samples - Array of annotation samples
 * @param imageDimensions - Map of image ID to {width, height}
 * @param imageMapping - Map of image ID to filename
 */
export function buildCocoFromSamples(
  samples: AnnotationSample[],
  imageDimensions: Record<string, { width: number; height: number }>,
  imageMapping?: Record<string, string>
): CocoData {
  // Extract unique categories from samples
  const categoryMap = new Map<string, number>();
  let categoryId = 1;

  samples.forEach(sample => {
    if (!categoryMap.has(sample.className)) {
      categoryMap.set(sample.className, categoryId++);
    }
  });

  const categories = Array.from(categoryMap.entries()).map(([name, id]) => ({
    id,
    name,
    supercategory: ""
  }));

  // Create images array from samples
  const imageSet = new Map<string, any>();
  samples.forEach(sample => {
    if (!imageSet.has(sample.imageId)) {
      const dims = imageDimensions[sample.imageId] || { width: 640, height: 480 };
      const fileName = imageMapping?.[sample.imageId] || `image_${sample.imageId}.jpg`;

      imageSet.set(sample.imageId, {
        id: parseInt(sample.imageId) || 
            Math.abs(sample.imageId.split('').reduce((a, b) => {
              a = ((a << 5) - a) + b.charCodeAt(0);
              return a & a;
            }, 0)) || 
            Math.floor(Math.random() * 1000000),
        width: dims.width,
        height: dims.height,
        file_name: fileName,
        license: 1,
        flickr_url: "",
        coco_url: "",
        date_captured: ""
      });
    }
  });

  const cocoData: CocoData = {
    info: {
      description: 'Annotations exported from AI Data Creator',
      version: "1.0",
      year: new Date().getFullYear(),
      contributor: "AI Data Creator",
      date_created: new Date().toISOString()
    },
    licenses: [{
      id: 1,
      name: "Unknown License",
      url: ""
    }],
    images: Array.from(imageSet.values()),
    categories: categories,
    annotations: samples.map((sample, index) => {
      const imageInfo = imageSet.get(sample.imageId);
      const imageWidth = imageInfo?.width || 640;
      const imageHeight = imageInfo?.height || 480;

      // Convert normalized bbox to absolute coordinates if needed
      let bboxAbsolute = [0, 0, 0, 0];
      if (sample.bbox && Array.isArray(sample.bbox) && sample.bbox.length === 4) {
        if (sample.bbox[0] > 1 || sample.bbox[1] > 1 || sample.bbox[2] > 1 || sample.bbox[3] > 1) {
          bboxAbsolute = [...sample.bbox];
        } else {
          bboxAbsolute = [
            sample.bbox[0] * imageWidth,
            sample.bbox[1] * imageHeight,
            sample.bbox[2] * imageWidth,
            sample.bbox[3] * imageHeight
          ];
        }
      }

      const annotation: any = {
        id: index + 1,
        image_id: imageInfo?.id || parseInt(sample.imageId) || 1,
        category_id: categoryMap.get(sample.className) || 1,
        iscrowd: 0
      };

      // Always include bbox if available
      if (bboxAbsolute && bboxAbsolute.some(v => v !== 0)) {
        annotation.bbox = bboxAbsolute;
        annotation.area = sample.area || (bboxAbsolute[2] * bboxAbsolute[3]);
      }

      // Always include segmentation if available (masks)
      if (sample.segmentation && Array.isArray(sample.segmentation) && sample.segmentation.length > 0) {
        annotation.segmentation = sample.segmentation;
        // Ensure area is set for mask annotations
        if (!annotation.area) {
          annotation.area = sample.area || 0;
        }
      }

      return annotation;
    })
  };

  return cocoData;
}

/**
 * Validates that COCO data includes both bboxes and masks where expected
 * Returns stats about what's included
 */
export function validateCocoData(cocoData: CocoData): {
  totalAnnotations: number;
  withBbox: number;
  withSegmentation: number;
  withBoth: number;
} {
  const stats = {
    totalAnnotations: cocoData.annotations.length,
    withBbox: 0,
    withSegmentation: 0,
    withBoth: 0,
  };

  cocoData.annotations.forEach(ann => {
    const hasBbox = ann.bbox && Array.isArray(ann.bbox) && ann.bbox.length === 4;
    const hasSegmentation = ann.segmentation && Array.isArray(ann.segmentation) && ann.segmentation.length > 0;

    if (hasBbox) stats.withBbox++;
    if (hasSegmentation) stats.withSegmentation++;
    if (hasBbox && hasSegmentation) stats.withBoth++;
  });

  return stats;
}
