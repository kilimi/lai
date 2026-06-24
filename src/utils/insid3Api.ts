/**
 * API client for INSID3 segmentation (segmentation editor only).
 */
import { getApiBaseUrl } from '@/config/api';
import type {
  Insid3PreviewResult,
  Insid3PropagateStartResponse,
  Insid3Reference,
} from '@/components/annotation/insid3Types';
import { pointsToPolygonPayload } from '@/components/annotation/insid3Types';

function apiBase(): string {
  return getApiBaseUrl();
}

export type Insid3ReadyStatus = {
  available: boolean;
  detail?: string;
  weightsMissing?: boolean;
};

export async function fetchInsid3Ready(): Promise<Insid3ReadyStatus> {
  try {
    const res = await fetch(`${apiBase()}/segment/ready/insid3`);
    if (res.ok) return { available: true };
    let detail: string | undefined;
    try {
      const body = await res.json();
      detail = typeof body.detail === 'string' ? body.detail : undefined;
    } catch {
      detail = undefined;
    }
    const weightsMissing = Boolean(detail?.toLowerCase().includes('weights missing'));
    return { available: false, detail, weightsMissing };
  } catch {
    return { available: false };
  }
}

function referenceToPayload(ref: Insid3Reference) {
  return {
    imageUrl: ref.imageB64 ? undefined : ref.imageUrl,
    imageB64: ref.imageB64,
    polygon: pointsToPolygonPayload(ref.polygon),
    width: ref.width,
    height: ref.height,
    imageName: ref.imageName,
    annotationId: ref.annotationId,
    className: ref.className,
  };
}

export async function fetchInsid3Preview(params: {
  references: Insid3Reference[];
  targetImageUrl?: string;
  targetImageB64?: string;
  targetWidth?: number;
  targetHeight?: number;
  minArea?: number;
  imageSize?: number;
}): Promise<Insid3PreviewResult> {
  const res = await fetch(`${apiBase()}/segment/insid3`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      references: params.references.map(referenceToPayload),
      targetImageUrl: params.targetImageUrl,
      targetImageB64: params.targetImageB64,
      targetWidth: params.targetWidth,
      targetHeight: params.targetHeight,
      min_area: params.minArea ?? 0,
      image_size: params.imageSize ?? 768,
      model_size: 'base',
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `INSID3 preview failed (${res.status})`);
  }
  return res.json();
}

export async function startInsid3Propagate(params: {
  datasetId: number;
  projectId?: number;
  collectionId?: number;
  className: string;
  classColor?: string;
  references: Insid3Reference[];
  excludeReferenceImages?: boolean;
  minArea?: number;
  imageSize?: number;
  layerImageFileNames?: string[];
}): Promise<Insid3PropagateStartResponse> {
  const res = await fetch(`${apiBase()}/segment/insid3/propagate/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dataset_id: params.datasetId,
      project_id: params.projectId,
      collection_id: params.collectionId,
      class_name: params.className,
      class_color: params.classColor,
      references: params.references.map(referenceToPayload),
      exclude_reference_images: params.excludeReferenceImages ?? true,
      target_image_names: params.layerImageFileNames,
      min_area: params.minArea ?? 0,
      image_size: params.imageSize ?? 768,
      model_size: 'base',
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Failed to start propagate (${res.status})`);
  }
  return res.json();
}

export async function fetchTask(taskId: number) {
  const res = await fetch(`${apiBase()}/tasks/${taskId}`);
  if (!res.ok) throw new Error('Failed to fetch task');
  return res.json();
}
