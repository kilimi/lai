/**
 * Type definitions for SAM (Segment Anything Model)
 */

// Simple coordinate point (for internal polygon processing)
export interface Coordinate {
  x: number;
  y: number;
}

// Point with label (for SAM prompt input)
export interface Point {
  x: number;
  y: number;
  label: number; // 1 for positive, 0 for negative
}

export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface EncodingOutput {
  imageEmbeddings: Float32Array;
  originalWidth: number;
  originalHeight: number;
  processedWidth: number;
  processedHeight: number;
  scale: number;
  offsetX: number;
  offsetY: number;
}

export interface SegmentationMask {
  mask: Uint8Array;
  width: number;
  height: number;
  score: number;
}

export interface SAMPrompt {
  points?: Point[];
  boxes?: Box[];
  labels?: number[]; // For points: 1=positive, 0=negative
}

export interface SAMResult {
  masks: SegmentationMask[];
  polygons: Coordinate[][];
  scores: number[];
}
