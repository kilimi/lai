import { expose } from 'comlink';
import { SAMEncoder } from '../utils/sam/encoder';
import { SAMDecoder } from '../utils/sam/decoder';
import { EncodingOutput, SAMPrompt, SAMResult, Point } from '../utils/sam/types';
import { imageToImageData } from '../utils/sam/preprocessor';

class SAMWorker {
  private encoder: SAMEncoder | null = null;
  private decoder: SAMDecoder | null = null;
  private isInitialized = false;

  async init(encoderPath: string, decoderPath: string) {
    if (this.isInitialized) {
      return;
    }

    this.encoder = new SAMEncoder();
    await this.encoder.init(encoderPath);

    this.decoder = new SAMDecoder();
    await this.decoder.init(decoderPath);

    this.isInitialized = true;
  }

  async encodeImage(
    image: HTMLImageElement | string | ImageData,
    imageId: string
  ): Promise<EncodingOutput> {
    if (!this.encoder) {
      throw new Error('SAM worker not initialized. Call init() first.');
    }

    return await this.encoder.encode(image, imageId);
  }

  async decodeMask(
    encoding: EncodingOutput,
    prompt: SAMPrompt
  ): Promise<SAMResult> {
    console.log('[SAM Worker] decodeMask called:', {
      hasDecoder: !!this.decoder,
      encoding: encoding ? {
        originalSize: `${encoding.originalWidth}x${encoding.originalHeight}`,
        processedSize: `${encoding.processedWidth}x${encoding.processedHeight}`,
        scale: encoding.scale,
        offsetX: encoding.offsetX,
        offsetY: encoding.offsetY,
        hasEmbeddings: !!encoding.imageEmbeddings,
        embeddingsLength: encoding.imageEmbeddings?.length || 0,
      } : null,
      prompt: {
        numPoints: prompt.points?.length || 0,
        points: prompt.points?.slice(0, 2),
        labels: prompt.labels?.slice(0, 2),
      },
    });

    if (!this.decoder) {
      throw new Error('SAM worker not initialized. Call init() first.');
    }

    try {
      const result = await this.decoder.decode(encoding, prompt);
      console.log('[SAM Worker] decodeMask result:', {
        numMasks: result.masks.length,
        numPolygons: result.polygons.length,
        polygonLengths: result.polygons.map(p => p.length),
      });
      return result;
    } catch (error) {
      console.error('[SAM Worker] decodeMask error:', error);
      throw error;
    }
  }

  clearCache() {
    this.encoder?.clearCache();
  }

  dispose() {
    this.encoder?.dispose();
    this.decoder?.dispose();
    this.encoder = null;
    this.decoder = null;
    this.isInitialized = false;
  }
}

const worker = new SAMWorker();
expose(worker);
