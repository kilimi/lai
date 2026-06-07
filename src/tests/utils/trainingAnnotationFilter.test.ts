import { describe, expect, it } from 'vitest';
import {
  annotationFileSupportsTrainingTask,
  filterAnnotationFilesForTrainingTask,
  mapAnnotationFileForTrainingPicker,
  type AnnotationFile,
} from '@/utils/annotations';

function stub(id: string, type: string): AnnotationFile {
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
  };
}

describe('training annotation file filtering', () => {
  it('allows bbox, mask, and mask+bbox for detection', () => {
    expect(annotationFileSupportsTrainingTask(stub('a', 'Segmentation (bbox)'), 'detection')).toBe(true);
    expect(
      annotationFileSupportsTrainingTask(stub('b', 'Segmentation (mask+bbox)'), 'detection'),
    ).toBe(true);
    expect(annotationFileSupportsTrainingTask(stub('c', 'Segmentation (mask)'), 'detection')).toBe(
      true,
    );
  });

  it('allows mask-only and mask+bbox for segmentation', () => {
    expect(annotationFileSupportsTrainingTask(stub('a', 'Segmentation (mask)'), 'segmentation')).toBe(
      true,
    );
    expect(
      annotationFileSupportsTrainingTask(stub('b', 'Segmentation (mask+bbox)'), 'segmentation'),
    ).toBe(true);
    expect(
      annotationFileSupportsTrainingTask(stub('c', 'Segmentation (bbox)'), 'segmentation'),
    ).toBe(false);
  });

  it('excludes classification-only files for detection', () => {
    expect(
      annotationFileSupportsTrainingTask(stub('a', 'Classification'), 'detection'),
    ).toBe(false);
    expect(annotationFileSupportsTrainingTask(stub('a', 'classification'), 'detection')).toBe(
      false,
    );
  });

  it('allows Other type for detection', () => {
    expect(annotationFileSupportsTrainingTask(stub('a', 'Other'), 'detection')).toBe(true);
  });

  it('filters picker files for detection training', () => {
    const files = [
      mapAnnotationFileForTrainingPicker({ id: 1, name: 'boxes', type: 'Segmentation (bbox)' }),
      mapAnnotationFileForTrainingPicker({ id: 2, name: 'masks', type: 'Segmentation (mask)' }),
      mapAnnotationFileForTrainingPicker({
        id: 3,
        name: 'both',
        type: 'Segmentation (mask+bbox)',
      }),
      mapAnnotationFileForTrainingPicker({ id: 4, name: 'labels', type: 'Classification' }),
    ];
    const filtered = filterAnnotationFilesForTrainingTask(files, 'detection');
    expect(filtered.map((f) => f.id)).toEqual(['1', '2', '3']);
  });
});
