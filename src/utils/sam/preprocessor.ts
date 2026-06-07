/**
 * Image preprocessing for SAM models
 * Resizes and normalizes images to SAM's expected input format
 */

export interface PreprocessedImage {
  tensor: Float32Array;
  originalWidth: number;
  originalHeight: number;
  processedWidth: number;
  processedHeight: number;
  scale: number;
  offsetX: number;
  offsetY: number;
}

const SAM_INPUT_SIZE = 1024;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

/**
 * Preprocess image for SAM encoder
 * - Resize to 1024x1024 (maintaining aspect ratio with padding)
 * - Normalize: (pixel / 255 - mean) / std
 * - Convert to tensor format [1, 3, 1024, 1024]
 */
export function preprocessImage(imageData: ImageData, originalWidth?: number, originalHeight?: number): PreprocessedImage | Promise<PreprocessedImage> {
  // Use provided original dimensions if available (for downsampled images)
  // Otherwise use ImageData dimensions
  const width = originalWidth ?? imageData.width;
  const height = originalHeight ?? imageData.height;
  
  // GETI approach: scale = 1024 / max(width, height)
  // This ensures the longest side becomes 1024, maintaining aspect ratio
  // Use original dimensions for scale calculation to maintain correct point scaling
  const scale = SAM_INPUT_SIZE / Math.max(width, height);
  const newWidth = Math.round(width * scale);
  const newHeight = Math.round(height * scale);
  const offsetX = (SAM_INPUT_SIZE - newWidth) / 2;
  const offsetY = (SAM_INPUT_SIZE - newHeight) / 2;
  
  // Optimized: Use OffscreenCanvas if available (faster, runs off main thread)
  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      const canvas = new OffscreenCanvas(SAM_INPUT_SIZE, SAM_INPUT_SIZE);
      const ctx = canvas.getContext('2d');
      
      if (ctx) {
        // Create ImageBitmap for faster processing
        return createImageBitmap(imageData).then(bitmap => {
          // Clear canvas with black (padding)
          ctx.fillStyle = '#000000';
          ctx.fillRect(0, 0, SAM_INPUT_SIZE, SAM_INPUT_SIZE);
          
          // Draw resized image centered (single drawImage call is faster)
          ctx.drawImage(bitmap, offsetX, offsetY, newWidth, newHeight);
          
          // Get resized image data
          const resizedData = ctx.getImageData(0, 0, SAM_INPUT_SIZE, SAM_INPUT_SIZE);
          
          // Clean up ImageBitmap
          bitmap.close();
          
          // Optimized tensor creation using TypedArray operations
          const tensor = createTensorOptimized(resizedData.data);
          
          return {
            tensor,
            originalWidth: width,
            originalHeight: height,
            processedWidth: SAM_INPUT_SIZE,
            processedHeight: SAM_INPUT_SIZE,
            scale,
            offsetX,
            offsetY,
          };
        }).catch(() => {
          // Fallback if ImageBitmap fails
          return preprocessImageFallback(imageData, scale, newWidth, newHeight, offsetX, offsetY, width, height);
        });
      }
    } catch (e) {
      // Fallback if OffscreenCanvas fails
    }
  }
  
  // Fallback to regular canvas processing
  return preprocessImageFallback(imageData, scale, newWidth, newHeight, offsetX, offsetY, width, height);
}

/**
 * Optimized tensor creation using direct array operations
 */
function createTensorOptimized(imageData: Uint8ClampedArray): Float32Array {
  const tensor = new Float32Array(3 * SAM_INPUT_SIZE * SAM_INPUT_SIZE);
  const size = SAM_INPUT_SIZE * SAM_INPUT_SIZE;
  
  // Pre-calculate normalization factors
  const rMean = MEAN[0];
  const gMean = MEAN[1];
  const bMean = MEAN[2];
  const rStd = STD[0];
  const gStd = STD[1];
  const bStd = STD[2];
  const inv255 = 1.0 / 255.0;
  
  // Process pixels in a single pass with optimized indexing
  for (let i = 0; i < size; i++) {
    const srcIdx = i * 4; // RGBA
    const r = imageData[srcIdx] * inv255;
    const g = imageData[srcIdx + 1] * inv255;
    const b = imageData[srcIdx + 2] * inv255;
    
    // CHW format: [channel][height][width]
    // Channel 0 (R): i
    // Channel 1 (G): size + i
    // Channel 2 (B): 2 * size + i
    tensor[i] = (r - rMean) / rStd;
    tensor[size + i] = (g - gMean) / gStd;
    tensor[2 * size + i] = (b - bMean) / bStd;
  }
  
  return tensor;
}

/**
 * Fallback preprocessing using regular canvas (for browsers without OffscreenCanvas/ImageBitmap support)
 */
function preprocessImageFallback(
  imageData: ImageData,
  scale: number,
  newWidth: number,
  newHeight: number,
  offsetX: number,
  offsetY: number,
  originalWidth?: number,
  originalHeight?: number
): PreprocessedImage {
  const width = originalWidth ?? imageData.width;
  const height = originalHeight ?? imageData.height;
  
  // Create canvas for resizing
  const canvas = document.createElement('canvas');
  canvas.width = SAM_INPUT_SIZE;
  canvas.height = SAM_INPUT_SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: false });
  
  if (!ctx) {
    throw new Error('Failed to get canvas context');
  }
  
  // Create source canvas
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = width;
  tempCanvas.height = height;
  const tempCtx = tempCanvas.getContext('2d');
  if (tempCtx) {
    tempCtx.putImageData(imageData, 0, 0);
  }
  
  // Clear canvas with black (padding)
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, SAM_INPUT_SIZE, SAM_INPUT_SIZE);
  
  // Draw resized image centered
  ctx.drawImage(tempCanvas, offsetX, offsetY, newWidth, newHeight);
  
  // Get resized image data
  const resizedData = ctx.getImageData(0, 0, SAM_INPUT_SIZE, SAM_INPUT_SIZE);
  
  // Use optimized tensor creation
  const tensor = createTensorOptimized(resizedData.data);
  
  return {
    tensor,
    originalWidth: width,
    originalHeight: height,
    processedWidth: SAM_INPUT_SIZE,
    processedHeight: SAM_INPUT_SIZE,
    scale,
    offsetX,
    offsetY,
  };
}

/**
 * Result of imageToImageData conversion
 */
export interface ImageDataResult {
  imageData: ImageData;
  originalWidth: number;
  originalHeight: number;
}

/**
 * Convert image element or URL to ImageData
 * Optimized: Downsamples large images before processing to speed up encoding
 * SAM will resize to 1024x1024 anyway, so we can downsample first
 * Returns both ImageData and original dimensions for proper point scaling
 */
export async function imageToImageData(image: HTMLImageElement | string): Promise<ImageDataResult> {
  console.log('[SAM] imageToImageData: Starting conversion');
  
  let img: ImageBitmap;
  let originalWidth: number;
  let originalHeight: number;
  
  try {
    if (typeof image === 'string') {
      console.log('[SAM] Loading image from URL:', image);
      // Use ImageBitmap for faster loading and processing
      const response = await fetch(image);
      if (!response.ok) {
        throw new Error(`Failed to fetch image: ${response.statusText}`);
      }
      const blob = await response.blob();
      img = await createImageBitmap(blob);
      originalWidth = img.width;
      originalHeight = img.height;
      console.log('[SAM] Image loaded from URL:', { width: originalWidth, height: originalHeight });
    } else {
      // For HTMLImageElement, get dimensions first, then create ImageBitmap
      originalWidth = image.naturalWidth;
      originalHeight = image.naturalHeight;
      console.log('[SAM] Creating ImageBitmap from HTMLImageElement:', { width: originalWidth, height: originalHeight });
      img = await createImageBitmap(image);
    }
    
    // Downsample large images before creating ImageData
    // SAM will resize to 1024x1024 anyway, so we can downsample to ~2048px max
    // This dramatically reduces memory usage and processing time for large images
    const MAX_DOWNSAMPLE_SIZE = 2048; // Downsample to max 2048px on longest side
    const maxDimension = Math.max(originalWidth, originalHeight);
    
    let finalWidth = originalWidth;
    let finalHeight = originalHeight;
    
    if (maxDimension > MAX_DOWNSAMPLE_SIZE) {
      // Calculate downsampled dimensions maintaining aspect ratio
      const downscale = MAX_DOWNSAMPLE_SIZE / maxDimension;
      finalWidth = Math.round(originalWidth * downscale);
      finalHeight = Math.round(originalHeight * downscale);
      
      console.log(`[SAM] Downsampling image from ${originalWidth}x${originalHeight} to ${finalWidth}x${finalHeight} (${(downscale * 100).toFixed(1)}%)`);
      
      // Will resize via canvas drawImage (more reliable)
      console.log('[SAM] Will resize via canvas during drawImage');
    }
    
    // Create canvas with target size (will resize during drawImage if needed)
    // Use OffscreenCanvas if available (works in Web Workers), fallback to regular canvas
    console.log('[SAM] Creating canvas:', { width: finalWidth, height: finalHeight });
    
    let canvas: HTMLCanvasElement | OffscreenCanvas;
    let ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    
    if (typeof OffscreenCanvas !== 'undefined') {
      // Use OffscreenCanvas (works in Web Workers)
      canvas = new OffscreenCanvas(finalWidth, finalHeight);
      ctx = canvas.getContext('2d');
    } else if (typeof document !== 'undefined') {
      // Fallback to regular canvas (main thread only)
      canvas = document.createElement('canvas');
      canvas.width = finalWidth;
      canvas.height = finalHeight;
      ctx = canvas.getContext('2d', { willReadFrequently: false });
    } else {
      throw new Error('Neither OffscreenCanvas nor document is available. Cannot create canvas.');
    }
    
    if (!ctx) {
      throw new Error('Failed to get canvas context');
    }
    
    // Draw image to canvas (canvas will resize if dimensions differ)
    // This is much faster than creating ImageData from full-size image
    console.log('[SAM] Drawing image to canvas:', { 
      imageSize: `${img.width}x${img.height}`, 
      canvasSize: `${finalWidth}x${finalHeight}` 
    });
    ctx.drawImage(img, 0, 0, finalWidth, finalHeight);
    
    console.log('[SAM] Getting ImageData from canvas');
    // Both CanvasRenderingContext2D and OffscreenCanvasRenderingContext2D have getImageData()
    const imageData = ctx.getImageData(0, 0, finalWidth, finalHeight);
    
    console.log('[SAM] ImageData created:', { width: imageData.width, height: imageData.height, dataLength: imageData.data.length });
    
    // Clean up ImageBitmap
    img.close();
    
    // Return both ImageData and original dimensions
    // Original dimensions are needed for proper point coordinate scaling
    return {
      imageData,
      originalWidth,
      originalHeight,
    };
  } catch (error) {
    console.error('[SAM] Error in imageToImageData:', error);
    throw error;
  }
}
