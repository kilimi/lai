import { describe, expect, it } from 'vitest';
import type { Image, ImageCollection } from '@/types';
import {
  findCorrespondingImageInCollection,
  imageLayerDimsKey,
  pickNewestImageByFileName,
} from '@/pages/image-annotation/utils';

function makeImage(id: string, fileName: string, url: string, groupId?: string): Image {
  return {
    id,
    datasetId: '1',
    fileName,
    fileSize: 100,
    width: 640,
    height: 480,
    url,
    thumbnailUrl: url,
    uploadedAt: new Date().toISOString(),
    annotationsCount: 0,
    groupId,
  };
}

describe('pickNewestImageByFileName', () => {
  it('returns the highest id when duplicate file names exist', () => {
    const images = [
      makeImage('10', '0001.jpg', '/static/old/0001.jpg'),
      makeImage('25', '0001.jpg', '/static/c2/0001.jpg'),
    ];
    expect(pickNewestImageByFileName(images, '0001.jpg')?.id).toBe('25');
  });
});

describe('findCorrespondingImageInCollection', () => {
  const collection: ImageCollection = {
    id: '2',
    name: 'Thermal',
    images: [
      makeImage('10', '0001.jpg', '/static/c1/0001.jpg'),
      makeImage('99', '0001.jpg', '/static/c2/0001.jpg'),
    ],
    currentPage: 1,
    totalPages: 1,
    paginatedImages: [],
  };

  it('prefers the newest row for duplicate sequential frame names', () => {
    const match = findCorrespondingImageInCollection(collection, '0001.jpg', null);
    expect(match?.id).toBe('99');
    expect(match?.url).toContain('c2/');
  });
});

describe('imageLayerDimsKey', () => {
  it('scopes dimensions by collection and file name', () => {
    expect(imageLayerDimsKey('3', '0001.jpg')).toBe('3::0001.jpg');
  });
});
