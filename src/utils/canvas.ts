/**
 * Shared Canvas Drawing Utilities
 * 
 * Provides consistent canvas drawing functions for bounding boxes,
 * labels, and coordinate transformations used across multiple components.
 */

export interface BBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface DrawBoxOptions {
  color?: string;
  lineWidth?: number;
  lineDash?: number[];
  fillAlpha?: number;
}

export interface DrawLabelOptions {
  color?: string;
  backgroundColor?: string;
  font?: string;
  padding?: number;
  position?: 'top' | 'bottom';
}

/**
 * Setup canvas with proper DPR (Device Pixel Ratio) for crisp rendering
 */
export function setupCanvas(
  canvas: HTMLCanvasElement,
  width: number,
  height: number
): CanvasRenderingContext2D | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  
  const dpr = window.devicePixelRatio || 1;
  
  // Set display size (css pixels)
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  
  // Set actual size in memory (scaled for retina)
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  
  // Scale all drawing operations by DPR
  ctx.scale(dpr, dpr);
  
  return ctx;
}

/**
 * Convert bbox from [x, y, width, height] to [x1, y1, x2, y2]
 */
export function xywhToXyxy(bbox: number[]): BBox {
  const [x, y, w, h] = bbox;
  return {
    x1: x,
    y1: y,
    x2: x + w,
    y2: y + h,
  };
}

/**
 * Convert bbox from [x1, y1, x2, y2] to [x, y, width, height]
 */
export function xyxyToXywh(bbox: BBox | number[]): number[] {
  if (Array.isArray(bbox)) {
    const [x1, y1, x2, y2] = bbox;
    return [x1, y1, x2 - x1, y2 - y1];
  }
  return [bbox.x1, bbox.y1, bbox.x2 - bbox.x1, bbox.y2 - bbox.y1];
}

/**
 * Scale bbox coordinates by a factor
 */
export function scaleBBox(bbox: BBox, scale: number): BBox {
  return {
    x1: bbox.x1 * scale,
    y1: bbox.y1 * scale,
    x2: bbox.x2 * scale,
    y2: bbox.y2 * scale,
  };
}

/**
 * Draw a bounding box on canvas
 */
export function drawBoundingBox(
  ctx: CanvasRenderingContext2D,
  bbox: BBox,
  options: DrawBoxOptions = {}
): void {
  const {
    color = '#00ff00',
    lineWidth = 2,
    lineDash = [],
    fillAlpha = 0,
  } = options;
  
  const { x1, y1, x2, y2 } = bbox;
  const width = x2 - x1;
  const height = y2 - y1;
  
  // Draw filled rectangle if fillAlpha > 0
  if (fillAlpha > 0) {
    ctx.fillStyle = `${color}${Math.round(fillAlpha * 255).toString(16).padStart(2, '0')}`;
    ctx.fillRect(x1, y1, width, height);
  }
  
  // Draw border
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.setLineDash(lineDash);
  ctx.strokeRect(x1, y1, width, height);
  ctx.setLineDash([]);
}

/**
 * Draw a label with background on canvas
 */
export function drawLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  options: DrawLabelOptions = {}
): void {
  const {
    color = '#ffffff',
    backgroundColor = '#000000',
    font = '12px sans-serif',
    padding = 4,
    position = 'top',
  } = options;
  
  ctx.font = font;
  const metrics = ctx.measureText(text);
  const textWidth = metrics.width;
  const textHeight = parseInt(font); // Approximate height from font size
  
  // Calculate label position
  const labelX = x;
  const labelY = position === 'top' ? y - textHeight - padding * 2 : y;
  const labelWidth = textWidth + padding * 2;
  const labelHeight = textHeight + padding * 2;
  
  // Draw background
  ctx.fillStyle = backgroundColor;
  ctx.fillRect(labelX, labelY, labelWidth, labelHeight);
  
  // Draw text
  ctx.fillStyle = color;
  ctx.textBaseline = 'top';
  ctx.fillText(text, labelX + padding, labelY + padding);
}

/**
 * Draw bounding box with label
 */
export function drawBBoxWithLabel(
  ctx: CanvasRenderingContext2D,
  bbox: BBox,
  label: string,
  options: DrawBoxOptions & DrawLabelOptions = {}
): void {
  // Draw box
  drawBoundingBox(ctx, bbox, options);
  
  // Draw label
  if (label) {
    drawLabel(ctx, label, bbox.x1, bbox.y1, {
      color: options.color || '#ffffff',
      backgroundColor: options.backgroundColor || options.color || '#000000',
      font: options.font,
      padding: options.padding,
      position: options.position,
    });
  }
}

/**
 * Clear canvas
 */
export function clearCanvas(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

/**
 * Get bbox area
 */
export function getBBoxArea(bbox: BBox): number {
  return (bbox.x2 - bbox.x1) * (bbox.y2 - bbox.y1);
}

/**
 * Get intersection of two bboxes
 */
export function getBBoxIntersection(bbox1: BBox, bbox2: BBox): BBox | null {
  const x1 = Math.max(bbox1.x1, bbox2.x1);
  const y1 = Math.max(bbox1.y1, bbox2.y1);
  const x2 = Math.min(bbox1.x2, bbox2.x2);
  const y2 = Math.min(bbox1.y2, bbox2.y2);
  
  if (x2 <= x1 || y2 <= y1) {
    return null; // No intersection (includes touching-edge case which has zero area)
  }
  
  return { x1, y1, x2, y2 };
}

/**
 * Calculate IoU (Intersection over Union) between two bboxes
 */
export function calculateIoU(bbox1: BBox, bbox2: BBox): number {
  const intersection = getBBoxIntersection(bbox1, bbox2);
  
  if (!intersection) {
    return 0;
  }
  
  const intersectionArea = getBBoxArea(intersection);
  const union = getBBoxArea(bbox1) + getBBoxArea(bbox2) - intersectionArea;
  
  return union > 0 ? intersectionArea / union : 0;
}

/**
 * Draw multiple bounding boxes with different colors
 */
export function drawMultipleBBoxes(
  ctx: CanvasRenderingContext2D,
  bboxes: Array<{ bbox: BBox; label?: string; color?: string }>
): void {
  bboxes.forEach(({ bbox, label, color = '#00ff00' }) => {
    if (label) {
      drawBBoxWithLabel(ctx, bbox, label, { color });
    } else {
      drawBoundingBox(ctx, bbox, { color });
    }
  });
}

/**
 * Get contrasting text color for a background color
 */
export function getContrastingColor(hexColor: string): string {
  // Remove # if present
  const hex = hexColor.replace('#', '');
  
  // Convert to RGB
  const r = parseInt(hex.substr(0, 2), 16);
  const g = parseInt(hex.substr(2, 2), 16);
  const b = parseInt(hex.substr(4, 2), 16);
  
  // Calculate luminance
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  
  // Return black or white depending on luminance
  return luminance > 0.5 ? '#000000' : '#ffffff';
}
