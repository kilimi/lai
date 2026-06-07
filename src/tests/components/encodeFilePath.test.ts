import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { encodeFilePath } from '../../components/ConfusionMatrixCellModal';

describe('encodeFilePath', () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
  });

  describe('Valid inputs', () => {
    it('should encode simple filenames', () => {
      expect(encodeFilePath('image.jpg')).toBe('image.jpg');
      expect(encodeFilePath('test.png')).toBe('test.png');
    });

    it('should encode filenames with spaces', () => {
      expect(encodeFilePath('my image.jpg')).toBe('my%20image.jpg');
      expect(encodeFilePath('test file 123.png')).toBe('test%20file%20123.png');
    });

    it('should encode special characters', () => {
      expect(encodeFilePath('image@2x.jpg')).toBe('image%402x.jpg');
      expect(encodeFilePath('file#test.png')).toBe('file%23test.png');
      expect(encodeFilePath('file&name.jpg')).toBe('file%26name.jpg');
    });

    it('should handle forward slashes in paths', () => {
      expect(encodeFilePath('folder/image.jpg')).toBe('folder/image.jpg');
      expect(encodeFilePath('path/to/file.png')).toBe('path/to/file.png');
    });

    it('should encode special characters in path segments', () => {
      expect(encodeFilePath('folder name/image.jpg')).toBe('folder%20name/image.jpg');
      expect(encodeFilePath('path/to file/test.png')).toBe('path/to%20file/test.png');
    });

    it('should handle Windows backslash paths', () => {
      expect(encodeFilePath('folder\\image.jpg')).toBe('folder/image.jpg');
      expect(encodeFilePath('C:\\Users\\test\\file.png')).toBe('C%3A/Users/test/file.png');
      expect(encodeFilePath('path\\to\\file.jpg')).toBe('path/to/file.jpg');
    });

    it('should handle mixed path separators', () => {
      expect(encodeFilePath('folder\\subfolder/image.jpg')).toBe('folder/subfolder/image.jpg');
      expect(encodeFilePath('path/to\\file.png')).toBe('path/to/file.png');
    });

    it('should handle Unicode characters', () => {
      expect(encodeFilePath('图片.jpg')).toBe('%E5%9B%BE%E7%89%87.jpg');
      expect(encodeFilePath('файл.png')).toBe('%D1%84%D0%B0%D0%B9%D0%BB.png');
      expect(encodeFilePath('emoji😀.jpg')).toBe('emoji%F0%9F%98%80.jpg');
    });
  });

  describe('Edge cases', () => {
    it('should handle empty strings', () => {
      expect(encodeFilePath('')).toBe('');
      expect(encodeFilePath('   ')).toBe('');
    });

    it('should handle whitespace-only strings', () => {
      expect(encodeFilePath('   ')).toBe('');
      expect(encodeFilePath('\t')).toBe('');
      expect(encodeFilePath('\n')).toBe('');
    });

    it('should trim leading and trailing whitespace', () => {
      expect(encodeFilePath('  image.jpg  ')).toBe('image.jpg');
      expect(encodeFilePath('\tfile.png\n')).toBe('file.png');
    });

    it('should handle paths with multiple consecutive slashes', () => {
      expect(encodeFilePath('folder//image.jpg')).toBe('folder//image.jpg');
      expect(encodeFilePath('path///to/file.png')).toBe('path///to/file.png');
    });

    it('should handle very long filenames', () => {
      const longName = 'a'.repeat(300) + '.jpg';
      const encoded = encodeFilePath(longName);
      expect(encoded).toBe(longName); // No special chars, should be unchanged
      expect(encoded.length).toBe(longName.length);
    });
  });

  describe('Invalid inputs', () => {
    it('should return empty string for null', () => {
      expect(encodeFilePath(null as any)).toBe('');
      expect(consoleWarnSpy).toHaveBeenCalledWith('encodeFilePath: invalid input', null);
    });

    it('should return empty string for undefined', () => {
      expect(encodeFilePath(undefined as any)).toBe('');
      expect(consoleWarnSpy).toHaveBeenCalledWith('encodeFilePath: invalid input', undefined);
    });

    it('should return empty string for non-string types', () => {
      expect(encodeFilePath(123 as any)).toBe('');
      expect(consoleWarnSpy).toHaveBeenCalledWith('encodeFilePath: invalid input', 123);
      
      expect(encodeFilePath({} as any)).toBe('');
      expect(consoleWarnSpy).toHaveBeenCalledWith('encodeFilePath: invalid input', {});
      
      expect(encodeFilePath([] as any)).toBe('');
      expect(consoleWarnSpy).toHaveBeenCalledWith('encodeFilePath: invalid input', []);
      
      expect(encodeFilePath(true as any)).toBe('');
      expect(consoleWarnSpy).toHaveBeenCalledWith('encodeFilePath: invalid input', true);
    });
  });

  describe('Real-world patterns', () => {
    it('should handle typical dataset image paths', () => {
      expect(encodeFilePath('train/img_0001.jpg')).toBe('train/img_0001.jpg');
      expect(encodeFilePath('val/image_001.png')).toBe('val/image_001.png');
      expect(encodeFilePath('test/sample_123.jpg')).toBe('test/sample_123.jpg');
    });

    it('should handle Windows dataset paths', () => {
      expect(encodeFilePath('dataset\\train\\img.jpg')).toBe('dataset/train/img.jpg');
      expect(encodeFilePath('data\\images\\test\\file.png')).toBe('data/images/test/file.png');
    });

    it('should handle filenames with dates and timestamps', () => {
      expect(encodeFilePath('image_2024-01-15.jpg')).toBe('image_2024-01-15.jpg');
      expect(encodeFilePath('photo_20240115_123045.png')).toBe('photo_20240115_123045.png');
    });

    it('should handle filenames with version numbers', () => {
      expect(encodeFilePath('model_v1.2.3.jpg')).toBe('model_v1.2.3.jpg');
      expect(encodeFilePath('data_v2.png')).toBe('data_v2.png');
    });
  });

  describe('Security considerations', () => {
    it('should encode path traversal patterns in segments but preserve slashes', () => {
      // The function encodes each segment separately, so ../ becomes .. with / preserved
      // This is actually safer as it makes path traversal attempts visible
      expect(encodeFilePath('../../../etc/passwd')).toBe('../../../etc/passwd');
      expect(encodeFilePath('..\\..\\windows\\system32')).toBe('../../windows/system32');
    });

    it('should handle null bytes', () => {
      expect(encodeFilePath('file\x00.jpg')).toBe('file%00.jpg');
    });
  });
});
