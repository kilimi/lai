import { describe, expect, it } from 'vitest';
import { shouldScheduleAnnotationRedraw } from '@/utils/annotationRenderVisibility';

describe('shouldScheduleAnnotationRedraw', () => {
  it('schedules redraw when there are visible annotations and image is not ready', () => {
    const result = shouldScheduleAnnotationRedraw({
      expectedVisibleAnnotationsCount: 3,
      isLayerSwitching: false,
      imageReady: false,
      currentImageKey: 'img1.jpg',
      lastDrawImageKey: 'img1.jpg',
      lastDrawnVisibleAnnotations: 0,
    });

    expect(result).toBe(true);
  });

  it('schedules redraw when last draw rendered fewer annotations than expected', () => {
    const result = shouldScheduleAnnotationRedraw({
      expectedVisibleAnnotationsCount: 5,
      isLayerSwitching: false,
      imageReady: true,
      currentImageKey: 'img1.jpg',
      lastDrawImageKey: 'img1.jpg',
      lastDrawnVisibleAnnotations: 2,
    });

    expect(result).toBe(true);
  });

  it('does not schedule redraw while layer is switching', () => {
    const result = shouldScheduleAnnotationRedraw({
      expectedVisibleAnnotationsCount: 4,
      isLayerSwitching: true,
      imageReady: true,
      currentImageKey: 'img1.jpg',
      lastDrawImageKey: 'img1.jpg',
      lastDrawnVisibleAnnotations: 0,
    });

    expect(result).toBe(false);
  });

  it('does not schedule redraw when expected annotations are already drawn for current image', () => {
    const result = shouldScheduleAnnotationRedraw({
      expectedVisibleAnnotationsCount: 4,
      isLayerSwitching: false,
      imageReady: true,
      currentImageKey: 'img1.jpg',
      lastDrawImageKey: 'img1.jpg',
      lastDrawnVisibleAnnotations: 4,
    });

    expect(result).toBe(false);
  });
});
