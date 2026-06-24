/** Types for INSID3 reference picking in the segmentation editor. */

import type { Point } from '@/pages/image-annotation/types';

export type Insid3SegmentModel = 'insid3';

export interface Insid3Reference {
  id: string;
  imageName: string;
  annotationId: string;
  className: string;
  polygon: Point[];
  imageUrl?: string;
  /** Embedded snapshot so reference mask aligns with pixels (preferred over imageUrl). */
  imageB64?: string;
  width?: number;
  height?: number;
}

export interface Insid3PreviewResult {
  polygons: number[][][];
  maskBase64?: string;
  referenceCount?: number;
}

export interface Insid3PropagateStartResponse {
  success: boolean;
  task_id: number;
  message?: string;
}

export const INSID3_MAX_REFERENCES = 8;

export function referenceKey(imageName: string, annotationId: string): string {
  return `${imageName}::${annotationId}`;
}

export function pointsToPolygonPayload(points: Point[]): number[][] {
  return points.map((p) => [p.x, p.y]);
}
