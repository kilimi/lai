import type { Point } from '@/pages/image-annotation/types';

const MAX_SIDE = 1024;

/**
 * Rasterize the visible image and polygon into a snapshot aligned with annotation
 * coordinate space (width × height). Used so INSID3 receives a mask that matches pixels.
 */
export function captureReferenceSnapshot(
  img: HTMLImageElement,
  polygon: Point[],
  coordWidth: number,
  coordHeight: number,
): { imageB64: string; width: number; height: number; polygon: Point[] } | null {
  if (!img.complete || coordWidth <= 0 || coordHeight <= 0 || polygon.length < 3) {
    return null;
  }

  let w = coordWidth;
  let h = coordHeight;
  const scaleDown = Math.max(w, h) > MAX_SIDE ? MAX_SIDE / Math.max(w, h) : 1;
  w = Math.round(w * scaleDown);
  h = Math.round(h * scaleDown);
  const scaledPoly =
    scaleDown === 1
      ? polygon
      : polygon.map((p) => ({ x: p.x * scaleDown, y: p.y * scaleDown }));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, w, h);

  return {
    imageB64: canvas.toDataURL('image/png'),
    width: w,
    height: h,
    polygon: scaledPoly,
  };
}
