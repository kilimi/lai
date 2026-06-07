/**
 * API helpers for the image annotation workspace.
 * Centralizes base URL resolution (see src/config/api.ts).
 */
import { getApiBaseUrl } from "@/config/api";

export function imageAnnotationApiBase(): string {
  return getApiBaseUrl();
}

export function segmentApiUrl(): string {
  return `${imageAnnotationApiBase()}/segment`;
}

export function patchAnnotationImageUrl(
  datasetId: string | number,
  annotationId: string,
  imageName: string,
): string {
  const base = imageAnnotationApiBase();
  return `${base}/datasets/${datasetId}/annotations/${annotationId}/image/${encodeURIComponent(imageName)}`;
}
