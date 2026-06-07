import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildImageUrls } from '../../components/ConfusionMatrixCellModal';
import * as apiConfig from '@/config/api';

// Mock the API config module
vi.mock('@/config/api', () => ({
  getApiBaseUrl: vi.fn(() => 'http://localhost:9999'),
}));

describe('buildImageUrls', () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let getApiBaseUrlMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    getApiBaseUrlMock = vi.mocked(apiConfig.getApiBaseUrl);
    getApiBaseUrlMock.mockReturnValue('http://localhost:9999');
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
    vi.clearAllMocks();
  });

  describe('Valid numeric image IDs', () => {
    it('should include evaluation endpoint when imageId is a valid number', () => {
      const urls = buildImageUrls(42, 123, 1, 2, 'test.jpg');
      expect(urls).toHaveLength(3);
      expect(urls[0]).toBe('http://localhost:9999/predictions/evaluation-image/42/123');
      expect(urls[1]).toBe('http://localhost:9999/static/projects/1/2/images/test.jpg');
      expect(urls[2]).toBe('http://localhost:9999/static/data/images/2/test.jpg');
    });

    it('should handle imageId = 1', () => {
      const urls = buildImageUrls(1, 1, 1, 1, 'img.jpg');
      expect(urls[0]).toBe('http://localhost:9999/predictions/evaluation-image/1/1');
    });

    it('should handle large imageId values', () => {
      const urls = buildImageUrls(999, 999999, 10, 20, 'large.jpg');
      expect(urls[0]).toBe('http://localhost:9999/predictions/evaluation-image/999/999999');
    });
  });

  describe('String image IDs', () => {
    it('should parse valid numeric strings as imageId', () => {
      const urls = buildImageUrls(42, '123', 1, 2, 'test.jpg');
      expect(urls).toHaveLength(3);
      expect(urls[0]).toBe('http://localhost:9999/predictions/evaluation-image/42/123');
    });

    it('should handle string "1"', () => {
      const urls = buildImageUrls(1, '1', 1, 1, 'img.jpg');
      expect(urls[0]).toBe('http://localhost:9999/predictions/evaluation-image/1/1');
    });

    it('should skip evaluation endpoint for non-numeric strings', () => {
      const urls = buildImageUrls(42, 'abc', 1, 2, 'test.jpg');
      expect(urls).toHaveLength(2);
      expect(urls[0]).toBe('http://localhost:9999/static/projects/1/2/images/test.jpg');
      expect(urls[1]).toBe('http://localhost:9999/static/data/images/2/test.jpg');
    });
  });

  describe('Invalid or missing image IDs', () => {
    it('should skip evaluation endpoint when imageId is undefined', () => {
      const urls = buildImageUrls(42, undefined, 1, 2, 'test.jpg');
      expect(urls).toHaveLength(2);
      expect(urls[0]).toBe('http://localhost:9999/static/projects/1/2/images/test.jpg');
      expect(urls[1]).toBe('http://localhost:9999/static/data/images/2/test.jpg');
    });

    it('should skip evaluation endpoint when imageId is null', () => {
      const urls = buildImageUrls(42, null as any, 1, 2, 'test.jpg');
      expect(urls).toHaveLength(2);
      expect(urls[0]).toBe('http://localhost:9999/static/projects/1/2/images/test.jpg');
    });

    it('should skip evaluation endpoint when imageId is 0', () => {
      const urls = buildImageUrls(42, 0, 1, 2, 'test.jpg');
      expect(urls).toHaveLength(2);
      expect(urls[0]).toBe('http://localhost:9999/static/projects/1/2/images/test.jpg');
    });

    it('should skip evaluation endpoint when imageId is negative', () => {
      const urls = buildImageUrls(42, -1, 1, 2, 'test.jpg');
      expect(urls).toHaveLength(2);
      expect(urls[0]).toBe('http://localhost:9999/static/projects/1/2/images/test.jpg');
    });

    it('should skip evaluation endpoint when imageId is NaN', () => {
      const urls = buildImageUrls(42, NaN, 1, 2, 'test.jpg');
      expect(urls).toHaveLength(2);
      expect(urls[0]).toBe('http://localhost:9999/static/projects/1/2/images/test.jpg');
    });

    it('should skip evaluation endpoint when imageId is Infinity', () => {
      const urls = buildImageUrls(42, Infinity, 1, 2, 'test.jpg');
      expect(urls).toHaveLength(2);
      expect(urls[0]).toBe('http://localhost:9999/static/projects/1/2/images/test.jpg');
    });
  });

  describe('Filename encoding', () => {
    it('should encode filenames with spaces', () => {
      const urls = buildImageUrls(1, 1, 1, 1, 'my image.jpg');
      expect(urls[1]).toBe('http://localhost:9999/static/projects/1/1/images/my%20image.jpg');
      expect(urls[2]).toBe('http://localhost:9999/static/data/images/1/my%20image.jpg');
    });

    it('should encode filenames with special characters', () => {
      const urls = buildImageUrls(1, 1, 1, 1, 'file@2x.jpg');
      expect(urls[1]).toBe('http://localhost:9999/static/projects/1/1/images/file%402x.jpg');
    });

    it('should handle Windows-style paths', () => {
      const urls = buildImageUrls(1, 1, 1, 1, 'folder\\image.jpg');
      expect(urls[1]).toBe('http://localhost:9999/static/projects/1/1/images/folder/image.jpg');
    });

    it('should handle Unix-style paths', () => {
      const urls = buildImageUrls(1, 1, 1, 1, 'folder/image.jpg');
      expect(urls[1]).toBe('http://localhost:9999/static/projects/1/1/images/folder/image.jpg');
    });

    it('should return empty array for empty filename after encoding', () => {
      const urls = buildImageUrls(1, 1, 1, 1, '');
      expect(urls).toEqual([]);
      expect(consoleWarnSpy).toHaveBeenCalledWith('buildImageUrls: empty filename after encoding');
    });

    it('should return empty array for null filename', () => {
      const urls = buildImageUrls(1, 1, 1, 1, null as any);
      expect(urls).toEqual([]);
      expect(consoleWarnSpy).toHaveBeenCalled();
    });
  });

  describe('API base URL handling', () => {
    it('should use API base URL from config', () => {
      getApiBaseUrlMock.mockReturnValue('http://example.com:8080');
      const urls = buildImageUrls(1, 1, 1, 1, 'test.jpg');
      expect(urls[0]).toBe('http://example.com:8080/predictions/evaluation-image/1/1');
      expect(urls[1]).toBe('http://example.com:8080/static/projects/1/1/images/test.jpg');
      expect(urls[2]).toBe('http://example.com:8080/static/data/images/1/test.jpg');
    });

    it('should strip trailing slashes from base URL', () => {
      getApiBaseUrlMock.mockReturnValue('http://localhost:9999/');
      const urls = buildImageUrls(1, 1, 1, 1, 'test.jpg');
      expect(urls[0]).toBe('http://localhost:9999/predictions/evaluation-image/1/1');
      expect(urls[1]).toBe('http://localhost:9999/static/projects/1/1/images/test.jpg');
    });

    it('should strip multiple trailing slashes', () => {
      getApiBaseUrlMock.mockReturnValue('http://localhost:9999///');
      const urls = buildImageUrls(1, 1, 1, 1, 'test.jpg');
      expect(urls[0]).toBe('http://localhost:9999/predictions/evaluation-image/1/1');
    });

    it('should handle HTTPS URLs', () => {
      getApiBaseUrlMock.mockReturnValue('https://api.example.com');
      const urls = buildImageUrls(1, 1, 1, 1, 'test.jpg');
      expect(urls[0]).toBe('https://api.example.com/predictions/evaluation-image/1/1');
      expect(urls[1]).toBe('https://api.example.com/static/projects/1/1/images/test.jpg');
    });
  });

  describe('Real-world scenarios', () => {
    it('should generate correct URLs for typical confusion matrix cell', () => {
      const urls = buildImageUrls(42, 123, 5, 10, 'train/img_0001.jpg');
      expect(urls).toHaveLength(3);
      expect(urls[0]).toContain('/evaluation-image/42/123');
      expect(urls[1]).toContain('/projects/5/10/images/train/img_0001.jpg');
      expect(urls[2]).toContain('/data/images/10/train/img_0001.jpg');
    });

    it('should handle samples without image ID (only filename fallbacks)', () => {
      const urls = buildImageUrls(42, undefined, 5, 10, 'test/sample.jpg');
      expect(urls).toHaveLength(2);
      expect(urls[0]).toContain('/projects/5/10/images/test/sample.jpg');
      expect(urls[1]).toContain('/data/images/10/test/sample.jpg');
    });

    it('should generate URLs for dataset with complex structure', () => {
      const urls = buildImageUrls(100, 500, 25, 50, 'validation/batch_01/img_999.png');
      expect(urls[0]).toBe('http://localhost:9999/predictions/evaluation-image/100/500');
      expect(urls[1]).toBe('http://localhost:9999/static/projects/25/50/images/validation/batch_01/img_999.png');
      expect(urls[2]).toBe('http://localhost:9999/static/data/images/50/validation/batch_01/img_999.png');
    });
  });

  describe('URL structure and order', () => {
    it('should return evaluation URL first when imageId is valid', () => {
      const urls = buildImageUrls(1, 1, 1, 1, 'test.jpg');
      expect(urls[0]).toContain('/evaluation-image/');
    });

    it('should return project URL second', () => {
      const urls = buildImageUrls(1, 1, 5, 10, 'test.jpg');
      expect(urls[1]).toContain('/projects/5/10/images/');
    });

    it('should return data URL third', () => {
      const urls = buildImageUrls(1, 1, 5, 10, 'test.jpg');
      expect(urls[2]).toContain('/data/images/10/');
    });
  });

  describe('Parameter variations', () => {
    it('should handle all minimum valid values', () => {
      const urls = buildImageUrls(1, 1, 1, 1, 'a.jpg');
      expect(urls).toHaveLength(3);
      expect(urls[0]).toBe('http://localhost:9999/predictions/evaluation-image/1/1');
    });

    it('should handle taskId variations', () => {
      const urls1 = buildImageUrls(1, 1, 1, 1, 'test.jpg');
      const urls2 = buildImageUrls(999, 1, 1, 1, 'test.jpg');
      expect(urls1[0]).toContain('/evaluation-image/1/1');
      expect(urls2[0]).toContain('/evaluation-image/999/1');
    });

    it('should handle projectId and datasetId variations', () => {
      const urls = buildImageUrls(1, 1, 100, 200, 'test.jpg');
      expect(urls[1]).toContain('/projects/100/200/images/');
      expect(urls[2]).toContain('/images/200/');
    });
  });
});
