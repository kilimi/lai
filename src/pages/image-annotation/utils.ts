import type React from 'react';
import type { Image, ImageCollection } from '@/types';
import { pointsToTightBbox } from '@/utils/annotations';
import type { AnnotationShape, Point } from './types';

export const SAM_MODEL_WAIT_OVERLAY_MS = 500;

export const DEFAULT_COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
  '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9',
  '#F8C471', '#82E0AA', '#F1948A', '#85C1E9', '#D2B4DE',
];

export const pointsToBbox = (points: Point[]): [number, number, number, number] =>
  pointsToTightBbox(points);

export const bboxToRectPoints = (bbox: number[]): Point[] => {
  if (!Array.isArray(bbox) || bbox.length < 4) return [];
  const [x, y, w, h] = bbox.map((v) => Number(v) || 0);
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
};

export function isDepthLikeCollectionName(name: string): boolean {
  const n = name.toLowerCase();
  return /\bdepth\b/.test(n) || n.includes('depth map') || n.includes('depth-map');
}

export function pickPreferredRgbCollection(
  collections: ImageCollection[],
): ImageCollection | undefined {
  if (collections.length === 0) return undefined;
  const rgbLike = (n: string) => {
    const s = n.toLowerCase();
    return s.includes('rgb') || s.includes('color') || s.includes('visible') || s.includes('original');
  };
  const byName = collections.find((c) => rgbLike(c.name) && !isDepthLikeCollectionName(c.name));
  if (byName) return byName;
  const byDefault = collections.find((c) => c.is_default === true && !isDepthLikeCollectionName(c.name));
  if (byDefault) return byDefault;
  return collections[0];
}

export function resolveClassFilterToggleNavigation(
  baseNavigableImageNames: string[],
  classImageMap: { [className: string]: Set<string> },
  currentFilterName: string | null,
  targetClassName: string,
): {
  nextFilterName: string | null;
  nextList: string[];
  firstImage: string | null;
} {
  const nextFilterName = currentFilterName === targetClassName ? null : targetClassName;
  const nextFilterSet = nextFilterName ? classImageMap[nextFilterName] : null;
  const nextList =
    nextFilterSet && nextFilterSet.size > 0
      ? baseNavigableImageNames.filter((n) => nextFilterSet.has(n))
      : baseNavigableImageNames;
  return {
    nextFilterName,
    nextList,
    firstImage: nextList.length > 0 ? nextList[0] : null,
  };
}

export function buildAutoSegmentMaskOverlayStyle(
  imageOffset: { x: number; y: number },
  imageScale: number,
  naturalWidth: number,
  naturalHeight: number,
): React.CSSProperties {
  return {
    left: imageOffset.x,
    top: imageOffset.y,
    width: Math.max(0, naturalWidth) * imageScale,
    height: Math.max(0, naturalHeight) * imageScale,
  };
}

function baseNameNoExt(fileName: string): string {
  if (!fileName.includes('.')) return fileName.toLowerCase();
  return fileName.slice(0, fileName.lastIndexOf('.')).toLowerCase();
}

export function findCorrespondingImageInCollection(
  collection: ImageCollection,
  imageName: string,
  referenceImage: Image | null,
): Image | null {
  const exact = collection.images.find((img) => img.fileName === imageName);
  if (exact) return exact;
  const targetBase = baseNameNoExt(imageName);
  const byBase = collection.images.find((img) => baseNameNoExt(img.fileName ?? '') === targetBase);
  if (byBase) return byBase;
  if (referenceImage?.groupId) {
    const gid = referenceImage.groupId;
    const byGroup = collection.images.find((img) => img.groupId && img.groupId === gid);
    if (byGroup) return byGroup;
  }
  return null;
}

export const calculatePolygonArea = (points: Point[]): number => {
  if (points.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    area += points[i].x * points[j].y;
    area -= points[j].x * points[i].y;
  }
  return Math.abs(area / 2);
};

export const formatArea = (area: number): string => {
  if (area < 1000) {
    return `${Math.round(area)} px²`;
  }
  if (area < 1000000) {
    return `${(area / 1000).toFixed(1)}K px²`;
  }
  return `${(area / 1000000).toFixed(1)}M px²`;
};

export function findCocoImageForDatasetName(
  cocoImages: Array<{ id?: unknown; file_name?: string | null; width?: number; height?: number }> | undefined,
  datasetFileName: string,
): { id?: unknown; file_name?: string | null; width?: number; height?: number } | undefined {
  if (!cocoImages?.length || !datasetFileName) return undefined;

  const exact = cocoImages.find((img) => img.file_name === datasetFileName);
  if (exact) return exact;

  const lower = datasetFileName.toLowerCase();
  const byLower = cocoImages.find((img) => (img.file_name || '').toLowerCase() === lower);
  if (byLower) return byLower;

  const leaf = (s: string) => s.replace(/^.*[/\\]/, '');
  const dsLeaf = leaf(datasetFileName);
  const byLeaf = cocoImages.find((img) => leaf(img.file_name || '') === dsLeaf);
  if (byLeaf) return byLeaf;

  const byLeafCI = cocoImages.find(
    (img) => leaf(img.file_name || '').toLowerCase() === dsLeaf.toLowerCase(),
  );
  if (byLeafCI) return byLeafCI;

  const baseNoExt = (s: string) => {
    const x = leaf(s);
    const d = x.lastIndexOf('.');
    return d > 0 ? x.slice(0, d) : x;
  };
  const dsBase = baseNoExt(datasetFileName).toLowerCase();
  return cocoImages.find((img) => baseNoExt(img.file_name || '').toLowerCase() === dsBase);
}
