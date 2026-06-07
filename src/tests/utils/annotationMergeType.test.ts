import { describe, expect, it } from 'vitest';
import {
  validateAnnotationMergeSelection,
  canAddFileToMergeSelection,
  type AnnotationFile,
} from '@/utils/annotations';

function file(id: string, type: string, samples?: Parameters<typeof canAddFileToMergeSelection>[0]['samples']): AnnotationFile {
  return {
    id,
    name: `${id}.json`,
    date: '2026-01-01',
    format: 'COCO',
    type: type as AnnotationFile['type'],
    classCount: 1,
    imageCount: 1,
    matchedImageCount: 1,
    datasetId: '1',
    samples,
  };
}

describe('annotation merge type validation', () => {
  it('allows merging two bbox-only files', () => {
    const a = file('a', 'Segmentation (bbox)', [{ imageId: '1', className: 'cat', bbox: [0.1, 0.2, 0.3, 0.4] }]);
    const b = file('b', 'Segmentation (bbox)', [{ imageId: '2', className: 'dog', bbox: [0.2, 0.3, 0.1, 0.2] }]);
    expect(validateAnnotationMergeSelection([a, b])).toEqual({ ok: true, mergeGroup: 'bbox' });
  });

  it('allows merging mask-only with mask+bbox files', () => {
    const mask = file('mask', 'Segmentation (mask)', [{
      imageId: '1',
      className: 'cat',
      bbox: [0, 0, 0, 0],
      segmentation: [[0, 0, 10, 0, 10, 10, 0, 10]],
    }]);
    const maskBbox = file('both', 'Segmentation (mask+bbox)', [{
      imageId: '2',
      className: 'dog',
      bbox: [0.1, 0.2, 0.3, 0.4],
      segmentation: [[0, 0, 10, 0, 10, 10, 0, 10]],
    }]);
    expect(validateAnnotationMergeSelection([mask, maskBbox])).toEqual({ ok: true, mergeGroup: 'mask' });
    expect(canAddFileToMergeSelection(maskBbox, [mask]).ok).toBe(true);
  });

  it('blocks merging bbox with mask files', () => {
    const bbox = file('bbox', 'Segmentation (bbox)', [{ imageId: '1', className: 'cat', bbox: [0.1, 0.2, 0.3, 0.4] }]);
    const mask = file('mask', 'Segmentation (mask)', [{
      imageId: '1',
      className: 'cat',
      bbox: [0, 0, 0, 0],
      segmentation: [[0, 0, 10, 0, 10, 10, 0, 10]],
    }]);
    const result = validateAnnotationMergeSelection([bbox, mask]);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/same annotation type/i);
  });

  it('blocks adding incompatible file to selection', () => {
    const bbox = file('bbox', 'Segmentation (bbox)');
    const mask = file('mask', 'Segmentation (mask)');
    expect(canAddFileToMergeSelection(mask, [bbox]).ok).toBe(false);
    expect(canAddFileToMergeSelection(bbox, []).ok).toBe(true);
  });

  it('blocks merging classification with boxes', () => {
    const cls = file('cls', 'Classification', [{ imageId: '1', className: 'cat', bbox: [0, 0, 0, 0] }]);
    const bbox = file('bbox', 'Segmentation (bbox)', [{ imageId: '1', className: 'cat', bbox: [0.1, 0.2, 0.3, 0.4] }]);
    expect(validateAnnotationMergeSelection([cls, bbox]).ok).toBe(false);
  });
});
