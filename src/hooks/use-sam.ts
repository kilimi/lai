import { useQuery } from '@tanstack/react-query';
import { wrap, Remote } from 'comlink';
import { useCallback, useRef, useState } from 'react';
import { SAMResult, Point } from '../utils/sam/types';

// Import worker with Vite's worker syntax
import SAMWorker from '../workers/sam.worker?worker';

const ENCODER_MODEL_PATH = '/models/sam/mobile_sam.encoder.onnx';
// Use MobileSAM decoder (matches encoder). ViT-H decoder is incompatible and returns rectangles.
const DECODER_MODEL_PATH = '/models/sam/sam_mask_decoder_single.onnx';

interface UseSAMOptions {
  image: HTMLImageElement | string | ImageData | null;
  imageId: string;
  enabled?: boolean;
  preloadModels?: boolean; // If true, start loading models immediately, not waiting for image
}

export function useSAM({ image, imageId, enabled = true, preloadModels = false }: UseSAMOptions) {
  const workerRef = useRef<Remote<any> | null>(null);
  const [isInitializing, setIsInitializing] = useState(false);

  // Initialize worker - start loading models immediately if preloadModels is true
  // Otherwise, wait for image to be available (backward compatibility)
  // When preloadModels is true, start loading immediately regardless of image availability
  const shouldInitWorker = preloadModels || (enabled && !!image);

  const { data: worker, isLoading: isWorkerLoading } = useQuery({
    queryKey: ['sam-worker'],
    queryFn: async () => {
      if (workerRef.current) return workerRef.current;
      setIsInitializing(true);
      try {
        const w = wrap<any>(new SAMWorker());
        await w.init(ENCODER_MODEL_PATH, DECODER_MODEL_PATH);
        workerRef.current = w;
        return w;
      } catch (error) {
        console.error('[SAM] Worker init failed:', error);
        throw error;
      } finally {
        setIsInitializing(false);
      }
    },
    staleTime: Infinity,
    enabled: shouldInitWorker && !workerRef.current, // Only start if we should init and don't have a worker yet
  });
  
  // Encode image only when not a URL (URL = backend is used; encoding large URLs hangs)
  const isImageUrl = typeof image === 'string';
  const { data: encoding, isLoading: isEncoding, error: encodingError } = useQuery({
    queryKey: ['sam-encoding', imageId],
    queryFn: async () => {
      if (!worker || !image) throw new Error('Worker or image not available');
      return worker.encodeImage(image, imageId);
    },
    enabled: enabled && !!worker && !!image && !!imageId && !isImageUrl,
    staleTime: Infinity,
    gcTime: 3600 * 1000,
  });

  /** Run browser SAM on a data URL image (e.g. when backend fails or returns placeholder). Points must be in the image's pixel coords (same as the data URL image). */
  const runFallbackSegment = useCallback(
    async (imageDataUrl: string, points: Point[]): Promise<SAMResult | null> => {
      if (!worker || !imageDataUrl || points.length === 0) return null;
      try {
        const encoding = await worker.encodeImage(imageDataUrl, `fallback-${imageId}-${Date.now()}`);
        return await worker.decodeMask(encoding, { points, labels: points.map(p => p.label) });
      } catch (error) {
        console.error('[SAM] fallback segment error:', error);
        return null;
      }
    },
    [worker, imageId]
  );

  return {
    runFallbackSegment,
    isLoading: isWorkerLoading || isInitializing || isEncoding,
    isReady: !!worker && !!encoding,
    isWorkerReady: !!worker,
    error: encodingError,
  };
}
