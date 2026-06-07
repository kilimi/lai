import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearSamModelReadyCache,
  isSamModelCachedReady,
  setSamModelCachedReady,
} from '@/utils/samReadyCache';

describe('samReadyCache', () => {
  beforeEach(() => {
    clearSamModelReadyCache();
  });

  it('tracks readiness per model', () => {
    expect(isSamModelCachedReady('sam2')).toBe(false);
    setSamModelCachedReady('sam2', true);
    expect(isSamModelCachedReady('sam2')).toBe(true);
    expect(isSamModelCachedReady('sam3')).toBe(false);
  });

  it('clears one model or all', () => {
    setSamModelCachedReady('sam2', true);
    setSamModelCachedReady('sam3', true);
    clearSamModelReadyCache('sam2');
    expect(isSamModelCachedReady('sam2')).toBe(false);
    expect(isSamModelCachedReady('sam3')).toBe(true);
    clearSamModelReadyCache();
    expect(isSamModelCachedReady('sam3')).toBe(false);
  });
});
