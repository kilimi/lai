import type { Image, ImageCollection } from '@/types';

export type AnnotationTool =
  | 'select'
  | 'rectangle'
  | 'circle'
  | 'polygon'
  | 'pencil'
  | 'auto-segment';

export type AnnotationMode = 'mask' | 'bbox';

export interface Point {
  x: number;
  y: number;
}

export interface AnnotationShape {
  id: string;
  type: 'rectangle' | 'circle' | 'polygon';
  points: Point[];
  label: string;
  color: string;
  visible: boolean;
  confidence?: number;
}

export interface AnnotationClass {
  id: string;
  name: string;
  color: string;
  visible: boolean;
  count: number;
}

export type { Image, ImageCollection };
