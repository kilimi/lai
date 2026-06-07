export interface AnnotationSample {
  id?: string;
  imageId: string;
  datasetId?: string;  // Add datasetId field
  className: string;
  bbox: [number, number, number, number]; // [x, y, width, height] normalized 0-1
  segmentation?: number[][];  // Optional polygon points
  area?: number;              // Optional area
  confidence?: number;        // Optional confidence score
  color?: string;             // Optional color for display
  opacity?: number;           // Optional opacity for display
  isVisible?: boolean;        // Optional visibility for toggling in UI (for segmentation masks)
  showBboxes?: boolean;       // Optional individual bbox visibility control
  annotationFileName?: string; // Optional annotation file name for grouping
  /** Dimensions of the image that annotation coords (segmentation/bbox) are in; used for correct overlay in grid/modal when images differ */
  referenceImageWidth?: number;
  referenceImageHeight?: number;
}

export interface AnnotationFile {
  id: string;
  name: string;
  date: string;
  format: string;
  type?: 'Classification' | 'Segmentation (mask+bbox)' | 'Segmentation (mask)' | 'Segmentation (bbox)' | 'Other' | 'classification' | 'segmentation' | 'segmentation-mask-bbox' | 'segmentation-mask' | 'segmentation-bbox' | 'detection' | 'object_detection' | 'nothing' | 'any'; // Support both new and old annotation types for backward compatibility (detection = legacy augmented bbox-only)
  classCount: number;
  imageCount: number;
  matchedImageCount: number;
  datasetId: string;
  classStats?: { className: string; count: number; color: string; opacity?: number }[];
  samples?: AnnotationSample[];
  isVisible?: boolean;
  showBboxes?: boolean; // Add individual bbox visibility control for the annotation file
  classColors?: { [className: string]: string }; // Add class color mapping
  imageMapping?: { [imageId: string]: string }; // Map COCO image IDs to filenames
  imageDetails?: { [imageId: string]: { fileName: string; width: number; height: number } }; // ADDED: Full image details with dimensions
  cocoImages?: { id: number; file_name: string; width: number; height: number }[]; // COCO images array for scaling segmentation to dataset image space
  tags?: string[]; // Add tags for categorization and search
  processing_status?: string; // Backend processing status
  error_message?: string; // Error message if processing failed
  totalSampleCount?: number; // Total number of annotations in the file
  isContentLoaded?: boolean; // Whether full content has been loaded (for lazy loading)
  /** True after annotations for every dataset image were loaded for grid overlay */
  allGridAnnotationsLoaded?: boolean;
  currentPageLoaded?: boolean;
  isLoadingCurrentPage?: boolean;
  // Coverage properties
  totalReferencedImages?: number; // Total images referenced in annotation file
  presentCount?: number; // Number of images present in dataset
  missingCount?: number; // Number of images missing from dataset
}

export type SegmentationEditorMode = 'mask' | 'bbox';

export type AnnotationDisplayType =
  | 'Classification'
  | 'Segmentation (mask+bbox)'
  | 'Segmentation (mask)'
  | 'Segmentation (bbox)'
  | 'Other';

export interface SegmentationModeCapabilities {
  hasMasks: boolean;
  hasBboxesOnly: boolean;
  isEmpty: boolean;
}

export function detectSegmentationModeCapabilities(cocoData: any): SegmentationModeCapabilities {
  const anns = Array.isArray(cocoData?.annotations) ? cocoData.annotations : [];
  if (anns.length === 0) {
    return { hasMasks: false, hasBboxesOnly: false, isEmpty: true };
  }

  let hasMasks = false;
  let hasBboxes = false;
  for (const ann of anns) {
    const seg = ann?.segmentation;
    const hasMask =
      Array.isArray(seg) &&
      ((Array.isArray(seg[0]) && (seg[0] as any[]).length >= 6) ||
        (typeof seg[0] === 'number' && seg.length >= 6));
    if (hasMask) hasMasks = true;
    const bbox = ann?.bbox;
    if (Array.isArray(bbox) && bbox.length >= 4) hasBboxes = true;
  }
  return { hasMasks, hasBboxesOnly: !hasMasks && hasBboxes, isEmpty: false };
}

/** True when segmentation contains a polygon with at least 3 points (6 coords). */
export function hasMeaningfulSegmentation(segmentation: unknown): boolean {
  if (!segmentation || !Array.isArray(segmentation) || segmentation.length === 0) {
    return false;
  }
  const first = segmentation[0];
  if (typeof first === 'number') {
    return segmentation.length >= 6;
  }
  if (Array.isArray(first)) {
    return first.length >= 6;
  }
  return false;
}

export function hasMeaningfulBbox(bbox: unknown): boolean {
  if (!bbox || !Array.isArray(bbox) || bbox.length !== 4) {
    return false;
  }
  return bbox.some((v) => typeof v === 'number' && v !== 0);
}

export function detectAnnotationTypeFromSamples(
  samples: AnnotationSample[],
): AnnotationDisplayType {
  if (!samples.length) {
    return 'Other';
  }

  const hasSegmentation = samples.some((s) => hasMeaningfulSegmentation(s.segmentation));
  const hasBbox = samples.some((s) => hasMeaningfulBbox(s.bbox));

  if (hasSegmentation && hasBbox) return 'Segmentation (mask+bbox)';
  if (hasSegmentation) return 'Segmentation (mask)';
  if (hasBbox) return 'Segmentation (bbox)';

  const hasOnlyEmptyBbox = samples.every(
    (s) =>
      !s.bbox ||
      (Array.isArray(s.bbox) &&
        s.bbox.length === 4 &&
        s.bbox[0] === 0 &&
        s.bbox[1] === 0 &&
        s.bbox[2] === 0 &&
        s.bbox[3] === 0),
  );
  if (hasOnlyEmptyBbox && samples.some((s) => s.className)) {
    return 'Classification';
  }

  return 'Segmentation (bbox)';
}

/** Display type for dataset annotation files — prefers loaded sample content over stale DB type. */
export function detectAnnotationDisplayType(file: AnnotationFile): AnnotationDisplayType {
  if (file.samples && file.samples.length > 0) {
    return detectAnnotationTypeFromSamples(file.samples);
  }

  const t = String(file.type || '').trim().toLowerCase();
  if (t === 'classification') return 'Classification';
  if (t === 'segmentation (mask+bbox)' || t === 'segmentation-mask-bbox') {
    return 'Segmentation (mask+bbox)';
  }
  if (t === 'segmentation (mask)' || t === 'segmentation-mask') {
    return 'Segmentation (mask)';
  }
  if (
    t === 'segmentation (bbox)' ||
    t === 'segmentation-bbox' ||
    t === 'detection' ||
    t === 'object_detection' ||
    t === 'object detection (bbox)'
  ) {
    return 'Segmentation (bbox)';
  }
  if (t === 'segmentation') {
    return 'Segmentation (bbox)';
  }

  if (file.name || (file as { fileName?: string }).fileName) {
    const nameLower = String(file.name || (file as { fileName?: string }).fileName).toLowerCase();
    if (nameLower.startsWith('augmented_')) return 'Segmentation (mask+bbox)';
    if (nameLower.includes('classification') || nameLower.includes('classify')) {
      return 'Classification';
    }
    if (nameLower.includes('mask') && nameLower.includes('bbox')) {
      return 'Segmentation (mask+bbox)';
    }
    if (nameLower.includes('mask')) return 'Segmentation (mask)';
    if (nameLower.includes('bbox') || nameLower.includes('detection')) {
      return 'Segmentation (bbox)';
    }
    if (nameLower.includes('segmentation') || nameLower.includes('seg')) {
      return 'Segmentation (bbox)';
    }
  }

  return 'Other';
}

export const ANNOTATION_TYPE_SHORT_LABELS: Record<AnnotationDisplayType, string> = {
  Classification: 'Class',
  'Segmentation (mask+bbox)': 'Masks + Boxes',
  'Segmentation (mask)': 'Masks',
  'Segmentation (bbox)': 'Boxes',
  Other: 'Other',
};

/** Merge compatibility groups — mask-only and mask+bbox files merge together. */
export type AnnotationMergeGroup = 'classification' | 'bbox' | 'mask' | 'other';

export const ANNOTATION_MERGE_GROUP_LABELS: Record<Exclude<AnnotationMergeGroup, 'other'>, string> = {
  classification: 'Class',
  bbox: 'Boxes',
  mask: 'Masks',
};

export function getAnnotationMergeGroup(type: AnnotationDisplayType): AnnotationMergeGroup {
  if (type === 'Classification') return 'classification';
  if (type === 'Segmentation (bbox)') return 'bbox';
  if (type === 'Segmentation (mask)' || type === 'Segmentation (mask+bbox)') return 'mask';
  return 'other';
}

export function getAnnotationMergeGroupForFile(file: AnnotationFile): AnnotationMergeGroup {
  return getAnnotationMergeGroup(detectAnnotationDisplayType(file));
}

export type TrainingAnnotationTaskType = 'detection' | 'segmentation' | 'classification' | 'oriented';

/** Normalize oriented detection to bbox-based detection for compatibility checks. */
export function normalizeTrainingTaskType(
  task: TrainingAnnotationTaskType,
): 'detection' | 'segmentation' | 'classification' {
  if (task === 'oriented') return 'detection';
  return task;
}

/**
 * Whether an annotation file can train the given task.
 * Detection accepts any spatial annotations (boxes / masks); only Classification is excluded.
 */
export function annotationFileSupportsTrainingTask(
  file: Pick<AnnotationFile, 'type' | 'name' | 'samples'> & {
    annotationType?: AnnotationDisplayType;
  },
  task: TrainingAnnotationTaskType,
): boolean {
  const displayType =
    file.annotationType ?? detectAnnotationDisplayType(file as AnnotationFile);
  const normalized = normalizeTrainingTaskType(task);
  if (normalized === 'detection') {
    return displayType !== 'Classification';
  }
  if (normalized === 'segmentation') {
    return (
      displayType === 'Segmentation (mask)' || displayType === 'Segmentation (mask+bbox)'
    );
  }
  if (normalized === 'classification') {
    return displayType === 'Classification';
  }
  return false;
}

/** Primary task badge for picker rows. */
export function primaryTrainingTaskTypeForAnnotationFile(
  file: Pick<AnnotationFile, 'type' | 'name' | 'samples'>,
): 'detection' | 'segmentation' | 'classification' | undefined {
  const displayType = detectAnnotationDisplayType(file as AnnotationFile);
  if (displayType === 'Segmentation (bbox)') return 'detection';
  if (displayType === 'Segmentation (mask+bbox)') return 'detection';
  if (displayType === 'Segmentation (mask)') return 'segmentation';
  if (displayType === 'Classification') return 'classification';
  return undefined;
}

export function filterAnnotationFilesForTrainingTask<
  T extends Pick<AnnotationFile, 'type' | 'name' | 'samples'> & {
    annotationType?: AnnotationDisplayType;
  },
>(files: T[], task: TrainingAnnotationTaskType): T[] {
  return files.filter((f) => annotationFileSupportsTrainingTask(f, task));
}

export function mapAnnotationFileForTrainingPicker(file: {
  id: string | number;
  name?: string;
  file_name?: string;
  type?: string | null;
  created_at?: string | null;
}): {
  id: string;
  name: string;
  classes: string[];
  annotationType: AnnotationDisplayType;
  taskType: 'detection' | 'segmentation' | 'classification' | undefined;
  modifiedAt?: string;
} {
  const name = file.name || file.file_name || String(file.id);
  const stub: AnnotationFile = {
    id: String(file.id),
    name,
    date: '',
    format: 'COCO',
    type: (file.type || undefined) as AnnotationFile['type'],
    classCount: 0,
    imageCount: 0,
    matchedImageCount: 0,
    datasetId: '',
  };
  const annotationType = detectAnnotationDisplayType(stub);
  return {
    id: String(file.id),
    name,
    classes: [],
    annotationType,
    taskType: primaryTrainingTaskTypeForAnnotationFile(stub),
    modifiedAt: file.created_at || undefined,
  };
}

/** Whether two or more files can be merged — all must share the same merge group. */
export function validateAnnotationMergeSelection(files: AnnotationFile[]): {
  ok: boolean;
  mergeGroup?: Exclude<AnnotationMergeGroup, 'other'>;
  message?: string;
} {
  if (files.length < 2) {
    return { ok: false, message: 'Select at least 2 annotation files to merge.' };
  }

  const groups = files.map((f) => getAnnotationMergeGroupForFile(f));
  if (groups.some((g) => g === 'other')) {
    return {
      ok: false,
      message: 'One or more selected files have an unsupported format and cannot be merged.',
    };
  }

  const unique = [...new Set(groups)];
  if (unique.length > 1) {
    const labels = unique.map((g) => ANNOTATION_MERGE_GROUP_LABELS[g as Exclude<AnnotationMergeGroup, 'other'>]).join(', ');
    return {
      ok: false,
      message: `All files must be the same annotation type. Selected: ${labels}. Merge Boxes with Boxes, Masks with Masks (mask-only and Masks + Boxes together), Class with Class.`,
    };
  }

  return { ok: true, mergeGroup: unique[0] as Exclude<AnnotationMergeGroup, 'other'> };
}

/** Whether a file can be added to the current merge selection. */
export function canAddFileToMergeSelection(
  file: AnnotationFile,
  selectedFiles: AnnotationFile[],
): { ok: boolean; reason?: string } {
  const fileGroup = getAnnotationMergeGroupForFile(file);
  if (fileGroup === 'other') {
    return { ok: false, reason: 'Unsupported format — this file cannot be merged.' };
  }
  if (selectedFiles.length === 0) {
    return { ok: true };
  }
  const anchorGroup = getAnnotationMergeGroupForFile(selectedFiles[0]);
  if (fileGroup !== anchorGroup) {
    return {
      ok: false,
      reason: `This file is "${ANNOTATION_MERGE_GROUP_LABELS[fileGroup]}". Your selection is "${ANNOTATION_MERGE_GROUP_LABELS[anchorGroup]}" — only matching types can be merged.`,
    };
  }
  return { ok: true };
}

export function pointsToTightBbox(points: Array<{ x: number; y: number }>): [number, number, number, number] {
  if (!points.length) return [0, 0, 0, 0];
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return [minX, minY, Math.max(1, maxX - minX), Math.max(1, maxY - minY)];
}

// Generate distinct random colors for classes
export function generateClassColors(classNames: string[]): { [className: string]: string } {
  const colors: { [className: string]: string } = {};
  const usedColors = new Set<string>();
  
  const predefinedColors = [
    "#ea384c", "#F97316", "#1EAEDB", "#8B5CF6", "#2ecc71", 
    "#f39c12", "#9b59b6", "#e74c3c", "#3498db", "#e67e22",
    "#95a5a6", "#34495e", "#1abc9c", "#16a085", "#27ae60",
    "#FF6B6B", "#4ECDC4", "#45B7D1", "#96CEB4", "#FECA57",
    "#FF9FF3", "#54A0FF", "#5F27CD", "#00D2D3", "#FF9F43",
    "#C44569", "#F8B500", "#6C5CE7", "#A29BFE", "#FD79A8",
    "#FF3838", "#FF9500", "#FFDD59", "#C44569", "#F8B500",
    "#6C5CE7", "#A29BFE", "#FD79A8", "#FDCB6E", "#E17055",
    "#74B9FF", "#0984E3", "#00B894", "#00CEC9", "#6C5CE7",
    "#A29BFE", "#FD79A8", "#FDCB6E", "#E17055", "#74B9FF"
  ];
  
  // Shuffle the predefined colors for more randomness
  const shuffledColors = [...predefinedColors];
  for (let i = shuffledColors.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffledColors[i], shuffledColors[j]] = [shuffledColors[j], shuffledColors[i]];
  }
  
  // Helper function to generate a random color
  const generateRandomColor = (): string => {
    const hue = Math.floor(Math.random() * 360);
    const saturation = 60 + Math.floor(Math.random() * 40); // 60-100%
    const lightness = 45 + Math.floor(Math.random() * 20);  // 45-65%
    return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
  };
  
  // Helper function to convert HSL to hex for consistency
  const hslToHex = (hsl: string): string => {
    const hslMatch = hsl.match(/hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)/);
    if (!hslMatch) return hsl;
    
    const h = parseInt(hslMatch[1]) / 360;
    const s = parseInt(hslMatch[2]) / 100;
    const l = parseInt(hslMatch[3]) / 100;
    
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };
    
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const r = Math.round(hue2rgb(p, q, h + 1/3) * 255);
    const g = Math.round(hue2rgb(p, q, h) * 255);
    const b = Math.round(hue2rgb(p, q, h - 1/3) * 255);
    
    return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
  };
  
  // Create a shuffled index array for more randomness
  const shuffledIndices = classNames.map((_, index) => index);
  for (let i = shuffledIndices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffledIndices[i], shuffledIndices[j]] = [shuffledIndices[j], shuffledIndices[i]];
  }
  
  classNames.forEach((className, originalIndex) => {
    let color: string;
    const randomIndex = shuffledIndices[originalIndex];
    
    // Use shuffled predefined colors, but with additional randomization
    if (Math.random() < 0.7 && randomIndex < shuffledColors.length) {
      // 70% chance to use a shuffled predefined color
      color = shuffledColors[randomIndex];
    } else {
      // 30% chance to generate a completely random color
      let attempts = 0;
      do {
        const hslColor = generateRandomColor();
        color = hslToHex(hslColor);
        attempts++;
      } while (usedColors.has(color) && attempts < 50); // Prevent infinite loop
    }
    
    colors[className] = color;
    usedColors.add(color);
  });
  
  return colors;
}

// Process COCO annotations
export async function processCOCOAnnotations(file: File, datasetId?: string): Promise<{
  stats: { className: string; count: number; color: string }[];
  samples: AnnotationSample[];
  matchedImages: string[];
  totalImageCount: number;   // Added field for total images in annotation file
  matchedImageCount: number; // Added field for matched images
  classColors: { [className: string]: string }; // Add class colors
  imageMapping: { [imageId: string]: string }; // Map COCO image IDs to filenames
  imageDetails: { [imageId: string]: { fileName: string; width: number; height: number } }; // ADDED: Full image details with dimensions
}>{
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = async (event) => {
      try {
        const jsonString = event.target?.result as string;
        const data = JSON.parse(jsonString);

        // Validate COCO format structure
        if (!data.images || !Array.isArray(data.images)) {
          throw new Error('Invalid COCO format: missing or invalid "images" field');
        }

        if (!data.annotations || !Array.isArray(data.annotations)) {
          throw new Error('Invalid COCO format: missing or invalid "annotations" field');
        }

        // Handle missing or invalid categories
        const categories = data.categories && Array.isArray(data.categories) ? data.categories : [];
        
        // Get all class names for color generation
        const classNames = categories.map((cat: any) => cat.name || `category_${cat.id || 'unknown'}`);
        const classColors = generateClassColors(classNames);
        
        console.log(`Generated colors for ${classNames.length} classes:`, classColors);
        
        const categoryColors: { [key: string]: string } = {};
        const processedCategories = categories.map((cat: any) => {
          const className = cat.name || `category_${cat.id || 'unknown'}`;
          const color = classColors[className];
          categoryColors[cat.id] = color;
          console.log(`Category ${cat.id} (${className}) assigned color: ${color}`);
          return { id: cat.id, name: className, color: color };
        });

        const imageMap: { [key: number]: string } = {};
        const imageDetailsMap: { [key: string]: { fileName: string; width: number; height: number } } = {};
        data.images.forEach((img: any) => {
          imageMap[img.id] = img.file_name;
          imageDetailsMap[String(img.id)] = {
            fileName: img.file_name,
            width: img.width || 640,
            height: img.height || 480
          };
        });

        const classCounts: { [key: string]: number } = {};
        // When mapping annotations, ensure segmentation is valid
        const samples = data.annotations.map((anno: any) => {
          const category = processedCategories.find(cat => cat.id === anno.category_id);
          const className = category ? category.name : `category_${anno.category_id || 'unknown'}`;
          const color = category ? category.color : '#808080'; // Default color

          if (!category) {
            console.warn(`No category found for annotation with category_id: ${anno.category_id}, using default color`);
          } else {
            console.log(`Annotation for class ${className} assigned color: ${color}`);
          }

          classCounts[className] = (classCounts[className] || 0) + 1;

          // Handle missing bbox or invalid image dimensions
          let bbox = [0, 0, 0, 0];
          if (anno.bbox && Array.isArray(anno.bbox) && anno.bbox.length === 4) {
            // Find the corresponding image to get dimensions
            const imageInfo = data.images.find((img: any) => img.id === anno.image_id);
            const imageWidth = imageInfo?.width || 1;
            const imageHeight = imageInfo?.height || 1;
            
            bbox = [
              anno.bbox[0] / imageWidth,
              anno.bbox[1] / imageHeight,
              anno.bbox[2] / imageWidth,
              anno.bbox[3] / imageHeight
            ];
          }

          let segmentation: number[][] | undefined = undefined;
          if (anno.segmentation && Array.isArray(anno.segmentation)) {
            // COCO polygons: array of arrays of numbers
            segmentation = anno.segmentation
              .filter((seg: any) => Array.isArray(seg) && seg.length >= 6)
              .map((seg: any) => seg.slice());
            if (segmentation.length === 0) segmentation = undefined;
          }

          return {
            id: anno.id ? anno.id.toString() : undefined, // Preserve original COCO annotation ID
            imageId: anno.image_id.toString(),
            datasetId: datasetId, // Add datasetId to each annotation
            className: className,
            bbox: bbox as [number, number, number, number],
            segmentation: segmentation,
            area: anno.area,
            color: color
          };
        });

        const stats = Object.keys(classCounts).map(className => {
          const category = processedCategories.find(cat => cat.name === className);
          return {
            className: className,
            count: classCounts[className],
            color: category ? category.color : '#808080' // Default color
          };
        });

        const matchedImages = Array.from(new Set(samples.map(anno => anno.imageId)));
        const totalImageCount = data.images.length;        resolve({
          stats: stats,
          samples: samples,
          matchedImages: (matchedImages as string[]),
          totalImageCount: totalImageCount,
          matchedImageCount: matchedImages.length,
          classColors: classColors,
          imageMapping: imageMap,
          imageDetails: imageDetailsMap
        });

      } catch (err) {
        reject(err);
      }
    };

    reader.onerror = () => {
      reject(new Error('Failed to read the file'));
    };

    reader.readAsText(file);
  });
}
