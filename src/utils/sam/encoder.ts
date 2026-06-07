import * as ort from 'onnxruntime-web';
import { SAMSession } from './session';
import { preprocessImage, imageToImageData, PreprocessedImage, ImageDataResult } from './preprocessor';
import { EncodingOutput } from './types';

export class SAMEncoder {
  private session: SAMSession | null = null;
  private cache = new Map<string, EncodingOutput>();

  async init(modelPath: string) {
    this.session = new SAMSession();
    await this.session.init(modelPath);
  }

  async encode(image: HTMLImageElement | string | ImageData, imageId: string): Promise<EncodingOutput> {
    // Check cache first
    if (this.cache.has(imageId)) {
      return this.cache.get(imageId)!;
    }

    if (!this.session) {
      throw new Error('Encoder not initialized. Call init() first.');
    }

    console.log('[SAM] Starting image encoding');

    // Convert to ImageData if needed (with downsampling for large images)
    let imageData: ImageData;
    let originalWidth: number;
    let originalHeight: number;
    
    if (image instanceof ImageData) {
      imageData = image;
      originalWidth = imageData.width;
      originalHeight = imageData.height;
    } else {
      // imageToImageData handles downsampling and returns original dimensions
      const result: ImageDataResult = await imageToImageData(image as HTMLImageElement | string);
      imageData = result.imageData;
      originalWidth = result.originalWidth;
      originalHeight = result.originalHeight;
      
      if (originalWidth !== imageData.width || originalHeight !== imageData.height) {
        console.log(`[SAM] Image downsampled: ${originalWidth}x${originalHeight} -> ${imageData.width}x${imageData.height} (${((imageData.width / originalWidth) * 100).toFixed(1)}%)`);
      }
    }

    // Preprocess image (may return Promise for optimized path)
    // Pass original dimensions if image was downsampled
    const preprocessed = await Promise.resolve(preprocessImage(imageData, originalWidth, originalHeight));

    // Acly MobileSAM encoder expects 'input_image' with rank 3 [H,W,C] (HWC); other encoders use 'images'/'x' with rank 4 [N,C,H,W] (NCHW)
    const inputNames = this.session.getInputNames();
    const inputName = inputNames[0] || 'images';
    const wantsHWC = inputName === 'input_image';

    let inputTensor: ort.Tensor;
    if (wantsHWC) {
      const H = preprocessed.processedHeight;
      const W = preprocessed.processedWidth;
      const size = H * W;
      const hwc = new Float32Array(H * W * 3);
      const chw = preprocessed.tensor;
      for (let i = 0; i < size; i++) {
        hwc[i * 3] = chw[i];           // R
        hwc[i * 3 + 1] = chw[size + i];   // G
        hwc[i * 3 + 2] = chw[2 * size + i]; // B
      }
      inputTensor = new ort.Tensor('float32', hwc, [H, W, 3]);
    } else {
      inputTensor = new ort.Tensor(
        'float32',
        preprocessed.tensor,
        [1, 3, preprocessed.processedHeight, preprocessed.processedWidth]
      );
    }

    const outputs = await this.session.run({ [inputName]: inputTensor });

    // Get output name dynamically (different models may use different names)
    const outputNames = this.session.getOutputNames();
    const outputTensor = outputs[outputNames[0]];
    
    // Extract image embeddings
    // Output shape is typically [1, 256, 64, 64] for MobileSAM
    const imageEmbeddings = outputTensor.data as Float32Array;

    const encoding: EncodingOutput = {
      imageEmbeddings,
      originalWidth: preprocessed.originalWidth,
      originalHeight: preprocessed.originalHeight,
      processedWidth: preprocessed.processedWidth,
      processedHeight: preprocessed.processedHeight,
      scale: preprocessed.scale,
      offsetX: preprocessed.offsetX,
      offsetY: preprocessed.offsetY,
    };

    // Cache the encoding
    this.cache.set(imageId, encoding);

    console.log('[SAM] encoding complete');

    return encoding;
  }

  clearCache() {
    this.cache.clear();
  }

  dispose() {
    this.session?.dispose();
    this.session = null;
    this.clearCache();
  }
}
