import { SAMSession } from './session';
import { EncodingOutput, SAMPrompt, SAMResult, Point, Coordinate, SegmentationMask } from './types';
import * as ort from 'onnxruntime-web';

export class SAMDecoder {
  private session: SAMSession | null = null;

  async init(modelPath: string) {
    this.session = new SAMSession();
    await this.session.init(modelPath);
  }

  async decode(
    encoding: EncodingOutput,
    prompt: SAMPrompt
  ): Promise<SAMResult> {
    if (!this.session) {
      throw new Error('Decoder not initialized. Call init() first.');
    }

    try {
      // Prepare decoder inputs
      const inputs = this.prepareDecoderInputs(encoding, prompt);

      // Run decoder
      console.log('[SAM] Running decoder with inputs:', Object.keys(inputs));
      const outputs = await this.session.run(inputs);
      console.log('[SAM] Decoder outputs:', Object.keys(outputs));

      // Post-process outputs to get masks and polygons
      const result = this.postprocessOutputs(outputs, encoding);
      console.log('[SAM] Decoder result:', { 
        numMasks: result.masks.length, 
        numPolygons: result.polygons.length,
        polygonPoints: result.polygons[0]?.length || 0
      });
      
      return result;
    } catch (error) {
      console.error('[SAM] Decoder error:', error);
      throw error;
    }
  }

  private prepareDecoderInputs(encoding: EncodingOutput, prompt: SAMPrompt): Record<string, ort.Tensor> {
    const inputs: Record<string, ort.Tensor> = {};

    // Image embeddings
    inputs.image_embeddings = new ort.Tensor(
      'float32',
      encoding.imageEmbeddings,
      [1, 256, 64, 64] // Typical MobileSAM shape
    );

    // Points and labels
    if (prompt.points && prompt.points.length > 0) {
      const points = prompt.points;
      const labels = prompt.labels || points.map(p => p.label);
      
      // Scale points to processed image size (1024x1024)
      // Account for both scaling and padding offset
      // GETI approach: scale = 1024 / max(originalWidth, originalHeight)
      // Points are in original image coordinates, need to:
      // 1. Scale by the preprocessing scale factor
      // 2. Add the padding offset
      const scale = encoding.scale;
      const offsetX = encoding.offsetX;
      const offsetY = encoding.offsetY;
      
      console.log('[SAM] Point scaling:', {
        originalPoints: points.slice(0, 2),
        scale,
        offsetX,
        offsetY,
        originalSize: `${encoding.originalWidth}x${encoding.originalHeight}`,
        processedSize: `${encoding.processedWidth}x${encoding.processedHeight}`,
      });

      // Prepare point coordinates: [N, 2]
      const pointCoords = new Float32Array(points.length * 2);
      for (let i = 0; i < points.length; i++) {
        // Scale point and add offset to account for padding
        pointCoords[i * 2] = points[i].x * scale + offsetX;
        pointCoords[i * 2 + 1] = points[i].y * scale + offsetY;
      }
      
      console.log('[SAM] Scaled point coords:', Array.from(pointCoords).slice(0, 4));

      // Prepare point labels: [N]
      const pointLabels = new Float32Array(labels);

      inputs.point_coords = new ort.Tensor('float32', pointCoords, [1, points.length, 2]);
      inputs.point_labels = new ort.Tensor('float32', pointLabels, [1, points.length]);
    } else {
      // No points - use default
      inputs.point_coords = new ort.Tensor('float32', new Float32Array([0, 0]), [1, 1, 2]);
      inputs.point_labels = new ort.Tensor('float32', new Float32Array([-1]), [1, 1]);
    }

    // Box (optional)
    if (prompt.boxes && prompt.boxes.length > 0) {
      const box = prompt.boxes[0];
      const scaleX = encoding.processedWidth / encoding.originalWidth;
      const scaleY = encoding.processedHeight / encoding.originalHeight;
      
      const boxCoords = new Float32Array([
        box.x1 * scaleX,
        box.y1 * scaleY,
        box.x2 * scaleX,
        box.y2 * scaleY,
      ]);
      inputs.box = new ort.Tensor('float32', boxCoords, [1, 4]);
    }

    // Mask input (optional, for refinement)
    // Use zeros for first pass (no previous mask)
    const maskInput = new Float32Array(256 * 256).fill(0);
    inputs.mask_input = new ort.Tensor('float32', maskInput, [1, 1, 256, 256]);

    // Has mask input flag (0 = no mask, 1 = has mask)
    inputs.has_mask_input = new ort.Tensor('float32', new Float32Array([0]), [1]);

    // Original image size (required by SAM decoder)
    // SAM expects the actual original image dimensions in [height, width] format
    // NOT the scaled/preprocessed size
    inputs.orig_im_size = new ort.Tensor(
      'float32',
      new Float32Array([
        encoding.originalHeight,
        encoding.originalWidth
      ]),
      [2]
    );
    
    console.log('[SAM] orig_im_size:', {
      original: [encoding.originalHeight, encoding.originalWidth],
      processed: [encoding.processedHeight, encoding.processedWidth],
    });

    return inputs;
  }

  private postprocessOutputs(
    outputs: ort.InferenceSession.OnnxValueMapType,
    encoding: EncodingOutput
  ): SAMResult {
    // Get output names dynamically
    const outputNames = this.session.getOutputNames();
    
    // SAM decoder outputs: masks, iou_predictions, low_res_masks
    // Try to get full-resolution masks first, fallback to low-res if needed
    const masksTensor = outputs['masks'] || outputs['low_res_masks'] || outputs[outputNames.find(n => n.includes('mask') && !n.includes('low')) || outputNames[0]];
    const lowResMasksTensor = outputs['low_res_masks'] || outputs[outputNames.find(n => n.includes('low') && n.includes('mask'))];
    const iouPredictions = outputs['iou_predictions'] || outputs[outputNames.find(n => n.includes('iou')) || outputNames[1]];
    
    console.log('[SAM] Available outputs:', {
      outputNames,
      outputKeys: Object.keys(outputs),
      hasMasks: !!masksTensor,
      hasLowResMasks: !!lowResMasksTensor,
      hasIoU: !!iouPredictions,
    });
    
    if (!masksTensor && !lowResMasksTensor) {
      console.error('No masks tensor found in decoder output', outputNames, Object.keys(outputs));
      return { masks: [], polygons: [], scores: [] };
    }
    
    // Use full-res masks if available, otherwise use low-res
    const finalMasksTensor = masksTensor || lowResMasksTensor;

    const masks = finalMasksTensor.data as Float32Array;
    const iouScores = iouPredictions ? (iouPredictions.data as Float32Array) : null;
    
    // Get mask dimensions from tensor shape
    // SAM decoder outputs masks as [batch, num_masks, height, width]
    // GETI uses: masks.dims[2] for height, masks.dims[3] for width
    const dims = finalMasksTensor.dims;
    console.log('[SAM] Mask tensor dims:', dims);
    
    const numMasks = dims.length >= 4 ? dims[1] : 1;
    const maskHeight = dims.length >= 4 ? dims[2] : dims[dims.length - 2] || 256;
    const maskWidth = dims.length >= 4 ? dims[3] : dims[dims.length - 1] || 256;
    const maskSize = maskHeight * maskWidth; // Total pixels per mask
    
    console.log('[SAM] Mask dimensions:', {
      numMasks,
      maskHeight,
      maskWidth,
      maskSize,
      tensorShape: dims,
    });
    
    // Find best mask using IoU predictions (like GETI does)
    let bestMaskIdx = 0;
    if (iouScores && iouScores.length > 0) {
      console.log('[SAM] IoU scores:', Array.from(iouScores));
      for (let i = 0; i < Math.min(numMasks, iouScores.length); i++) {
        if (iouScores[i] > iouScores[bestMaskIdx]) {
          bestMaskIdx = i;
        }
      }
      console.log('[SAM] Best mask index:', bestMaskIdx, 'with IoU:', iouScores[bestMaskIdx]);
    }

    const resultMasks: SegmentationMask[] = [];
    const resultPolygons: Point[][] = [];
    const resultScores: number[] = [];

    // Process only the best mask (like GETI does)
    const score = iouScores && iouScores.length > bestMaskIdx ? iouScores[bestMaskIdx] : 1.0;
    
    // GETI calculates: maskOffset = maskIdx * size, where size = dims[2] * dims[3]
    const maskOffset = bestMaskIdx * maskSize;
    
    // Extract mask - SAM outputs logits that need to be thresholded
    // GETI uses: value = Number(masks.data[maskOffset + y * masks.dims[3] + x])
    const maskData = new Uint8Array(maskSize);
    let minVal = Infinity;
    let maxVal = -Infinity;
    let positiveCount = 0;
    
    // Try different thresholds if needed - sometimes SAM outputs need sigmoid
    // First pass: threshold at 0.0 (standard for logits)
    for (let y = 0; y < maskHeight; y++) {
      for (let x = 0; x < maskWidth; x++) {
        // GETI's indexing: maskOffset + y * width + x
        const dataIdx = maskOffset + y * maskWidth + x;
        const val = masks[dataIdx];
        const maskIdx = y * maskWidth + x;
        
        minVal = Math.min(minVal, val);
        maxVal = Math.max(maxVal, val);
        // SAM outputs logits - threshold at 0.0
        // Positive values = foreground, negative = background
        // Some models output after sigmoid, so try both thresholds
        const threshold = 0.0;
        const isPositive = val > threshold;
        if (isPositive) positiveCount++;
        maskData[maskIdx] = isPositive ? 255 : 0;
      }
    }
    
    // If threshold at 0.0 gives no results, try sigmoid threshold (0.5)
    if (positiveCount === 0 && minVal >= 0 && maxVal <= 1) {
      console.log('[SAM] No pixels with threshold 0.0, trying sigmoid threshold 0.5');
      positiveCount = 0;
      for (let y = 0; y < maskHeight; y++) {
        for (let x = 0; x < maskWidth; x++) {
          const dataIdx = maskOffset + y * maskWidth + x;
          const val = masks[dataIdx];
          const maskIdx = y * maskWidth + x;
          const isPositive = val > 0.5;
          if (isPositive) positiveCount++;
          maskData[maskIdx] = isPositive ? 255 : 0;
        }
      }
    }
    
    console.log('[SAM] Mask stats:', {
      minVal: minVal.toFixed(3),
      maxVal: maxVal.toFixed(3),
      positivePixels: positiveCount,
      totalPixels: maskSize,
      ratio: (positiveCount / maskSize).toFixed(3),
      maskDimensions: `${maskWidth}x${maskHeight}`,
    });
    
    // If no positive pixels, the mask is empty
    if (positiveCount === 0) {
      console.warn('[SAM] Mask is completely empty (no positive pixels)');
      return { masks: [], polygons: [], scores: [] };
    }

    const mask: SegmentationMask = {
      mask: maskData,
      width: maskWidth,
      height: maskHeight,
      score,
    };

    // Convert mask to polygon
    const polygon = this.maskToPolygon(mask, encoding);
    
    // Filter out masks that are too large (>90% of image area) or too small (<1%)
    if (polygon.length > 0) {
      const imageArea = encoding.originalWidth * encoding.originalHeight;
      const maskArea = this.calculatePolygonArea(polygon);
      const areaRatio = maskArea / imageArea;
      
      console.log('[SAM] Polygon stats:', {
        numPoints: polygon.length,
        area: maskArea.toFixed(0),
        imageArea: imageArea.toFixed(0),
        ratio: (areaRatio * 100).toFixed(2) + '%',
        firstFewPoints: polygon.slice(0, 5),
      });
      
      // Skip if mask is too large (likely wrong) or too small (likely noise)
      if (areaRatio > 0.9) {
        console.warn('[SAM] Mask too large, skipping', { areaRatio, maskArea, imageArea });
        return { masks: [], polygons: [], scores: [] };
      }
      
      if (areaRatio < 0.01) {
        console.warn('[SAM] Mask too small, skipping', { areaRatio, maskArea, imageArea });
        return { masks: [], polygons: [], scores: [] };
      }
    } else {
      console.warn('[SAM] No polygon found in mask');
      return { masks: [], polygons: [], scores: [] };
    }

    return {
      masks: [mask],
      polygons: [polygon],
      scores: [score],
    };
  }

  private maskToPolygon(mask: SegmentationMask, encoding: EncodingOutput): Coordinate[] {
    // SAM decoder outputs masks at different resolutions depending on the model
    // The mask coordinates are in the processed image space (1024x1024 with padding)
    // We need to:
    // 1. Scale from mask space to processed space (accounting for padding)
    // 2. Remove padding offset
    // 3. Scale from processed space to original space
    
    // Check if mask matches processed image size (1024x1024) - this means it's in processed space
    const isProcessedResolution = mask.width === encoding.processedWidth && mask.height === encoding.processedHeight;
    
    // Check if mask matches original image size - this means SAM already scaled it
    const isOriginalResolution = mask.width === encoding.originalWidth && mask.height === encoding.originalHeight;
    
    let scaleX: (x: number) => number;
    let scaleY: (y: number) => number;
    
    if (isOriginalResolution) {
      // Mask is at original resolution - SAM upsampled it from processed space
      // The mask pixel coordinates (0-5760, 0-3840) represent the processed image space
      // We need to map from processed space to original space
      console.log('[SAM] Mask is at original resolution, but coordinates are in processed space');
      console.log('[SAM] Transformation params:', {
        scale: encoding.scale,
        offsetX: encoding.offsetX,
        offsetY: encoding.offsetY,
        processedSize: `${encoding.processedWidth}x${encoding.processedHeight}`,
        originalSize: `${encoding.originalWidth}x${encoding.originalHeight}`,
      });
      
      // When SAM outputs a full-resolution mask, it's upsampled from the processed image
      // The mask pixel coordinates directly map to the processed image coordinates
      // But we need to account for the fact that the processed image was scaled and padded
      
      // The mask is upsampled: each mask pixel corresponds to a position in processed space
      // mask.width pixels map to processedWidth pixels
      const maskToProcessedX = encoding.processedWidth / mask.width;  // 1024 / 5760 ≈ 0.1778
      const maskToProcessedY = encoding.processedHeight / mask.height; // 1024 / 3840 ≈ 0.2667
      
      scaleX = (x: number) => {
        // x is a pixel index in the mask (0 to mask.width-1 = 0 to 5759)
        // The mask is upsampled from processed space, so:
        // mask pixel index -> processed coordinate -> original coordinate
        
        // Step 1: Convert mask pixel index to processed coordinate (0 to 1023)
        // mask.width (5760) pixels map to processedWidth (1024) pixels
        const processedX = x * maskToProcessedX;
        
        // Step 2: Remove padding offset (image was centered in 1024x1024 canvas)
        // offsetX is the left padding (0 in this case since image width fills 1024)
        const withoutPaddingX = processedX - encoding.offsetX;
        
        // Step 3: Scale from processed space back to original space
        // The processed image was scaled by: scale = 1024 / max(5760, 3840) = 1024 / 5760
        // To reverse: originalX = processedX / scale
        // But we need to account for the fact that the processed image is 1024 wide
        // and represents the scaled version of the original
        const originalX = withoutPaddingX / encoding.scale;
        
        return Math.max(0, Math.min(encoding.originalWidth - 1, Math.round(originalX)));
      };
      scaleY = (y: number) => {
        // y is a pixel index in the mask (0 to mask.height-1 = 0 to 3839)
        // The mask is upsampled from processed space
        
        // Step 1: Convert mask pixel index to processed coordinate (0 to 1023)
        // mask.height (3840) pixels map to processedHeight (1024) pixels
        const processedY = y * maskToProcessedY;
        
        // Step 2: Remove padding offset (image was centered vertically)
        // offsetY is the top padding (170.5 in this case)
        const withoutPaddingY = processedY - encoding.offsetY;
        
        // Step 3: Scale from processed space back to original space
        // The processed image height represents the scaled original height
        // originalY = processedY / scale, but we removed padding first
        const originalY = withoutPaddingY / encoding.scale;
        
        return Math.max(0, Math.min(encoding.originalHeight - 1, Math.round(originalY)));
      };
      
      // Test the transformation with known points to verify correctness
      const testMaskX = mask.width / 2; // Middle of mask
      const testMaskY = mask.height / 2;
      const testOriginalX = scaleX(testMaskX);
      const testOriginalY = scaleY(testMaskY);
      const expectedOriginalX = encoding.originalWidth / 2;
      const expectedOriginalY = encoding.originalHeight / 2;
      
      console.log('[SAM] Mask coordinate transformation:', {
        maskToProcessed: `${maskToProcessedX.toFixed(4)}x${maskToProcessedY.toFixed(4)}`,
        scale: encoding.scale,
        offset: `${encoding.offsetX}, ${encoding.offsetY}`,
        testTransform: {
          maskPoint: `(${testMaskX.toFixed(1)}, ${testMaskY.toFixed(1)})`,
          originalPoint: `(${testOriginalX}, ${testOriginalY})`,
          expectedOriginal: `(${expectedOriginalX.toFixed(1)}, ${expectedOriginalY.toFixed(1)})`,
          xError: Math.abs(testOriginalX - expectedOriginalX),
          yError: Math.abs(testOriginalY - expectedOriginalY),
        },
      });
      
      // If the transformation is significantly off, the mask coordinates might be in original space already
      const xError = Math.abs(testOriginalX - expectedOriginalX);
      const yError = Math.abs(testOriginalY - expectedOriginalY);
      
      console.log('[SAM] Transformation test results:', {
        xError,
        yError,
        threshold: 10,
        willUseDirectMapping: xError > 10 || yError > 10,
      });
      
      // When mask is at original resolution, SAM typically outputs coordinates in original space
      // Test both approaches and use the one with smaller error
      const directScaleX = (x: number) => Math.max(0, Math.min(encoding.originalWidth - 1, Math.round(x)));
      const directScaleY = (y: number) => Math.max(0, Math.min(encoding.originalHeight - 1, Math.round(y)));
      
      const directX = directScaleX(testMaskX);
      const directY = directScaleY(testMaskY);
      const directXError = Math.abs(directX - expectedOriginalX);
      const directYError = Math.abs(directY - expectedOriginalY);
      const directTotalError = directXError + directYError;
      const transformTotalError = xError + yError;
      
      console.log('[SAM] Comparing mapping approaches:', {
        directMapping: { result: `(${directX}, ${directY})`, error: directTotalError },
        transformMapping: { result: `(${testOriginalX}, ${testOriginalY})`, error: transformTotalError },
      });
      
      // For full-resolution masks, SAM outputs coordinates in processed space (upsampled)
      // The center point test might be misleading - always use transformation mapping
      // Only fall back to direct mapping if transformation error is extremely large
      if (transformTotalError > 500) {
        console.warn('[SAM] Transformation error extremely large, falling back to direct mapping');
        scaleX = directScaleX;
        scaleY = directScaleY;
      } else {
        console.log('[SAM] Using transformation mapping for full-resolution mask (default)');
        // Keep the existing scaleX and scaleY functions (transformation-based)
        // This correctly handles SAM's upsampled full-res masks
      }
      
      // Log a few sample transformations to verify
      const sampleMaskPoints = [
        { x: 0, y: 0 },
        { x: mask.width / 2, y: mask.height / 2 },
        { x: mask.width - 1, y: mask.height - 1 },
      ];
      console.log('[SAM] Sample coordinate transformations:', 
        sampleMaskPoints.map(p => ({
          mask: `(${p.x}, ${p.y})`,
          original: `(${scaleX(p.x)}, ${scaleY(p.y)})`,
        }))
      );
    } else if (isProcessedResolution) {
      // Mask is at processed resolution (1024x1024) - need to scale and remove padding
      console.log('[SAM] Mask is at processed resolution, scaling to original');
      // Scale from processed space to original space, accounting for the preprocessing scale
      const processedToOriginalX = encoding.originalWidth / encoding.processedWidth;
      const processedToOriginalY = encoding.originalHeight / encoding.processedHeight;
      
      // Remove padding offset and scale
      scaleX = (x: number) => {
        // Remove padding offset, then scale to original
        const withoutPadding = (x - encoding.offsetX) / encoding.scale;
        return Math.round(withoutPadding);
      };
      scaleY = (y: number) => {
        // Remove padding offset, then scale to original
        const withoutPadding = (y - encoding.offsetY) / encoding.scale;
        return Math.round(withoutPadding);
      };
    } else {
      // Mask is at a different resolution (e.g., 256x256) - scale through processed space
      console.log('[SAM] Mask is at intermediate resolution, scaling through processed space');
      const maskToProcessedX = encoding.processedWidth / mask.width;
      const maskToProcessedY = encoding.processedHeight / mask.height;
      const processedToOriginalX = encoding.originalWidth / encoding.processedWidth;
      const processedToOriginalY = encoding.originalHeight / encoding.processedHeight;
      
      scaleX = (x: number) => {
        // Scale to processed, remove padding, scale to original
        const inProcessed = x * maskToProcessedX;
        const withoutPadding = (inProcessed - encoding.offsetX) / encoding.scale;
        return Math.round(withoutPadding);
      };
      scaleY = (y: number) => {
        // Scale to processed, remove padding, scale to original
        const inProcessed = y * maskToProcessedY;
        const withoutPadding = (inProcessed - encoding.offsetY) / encoding.scale;
        return Math.round(withoutPadding);
      };
      
      console.log('[SAM] Mask scaling factors:', {
        maskSize: `${mask.width}x${mask.height}`,
        processedSize: `${encoding.processedWidth}x${encoding.processedHeight}`,
        originalSize: `${encoding.originalWidth}x${encoding.originalHeight}`,
        scale: encoding.scale,
        offset: `${encoding.offsetX}, ${encoding.offsetY}`,
      });
    }

    // Find contours in mask (in mask space, 256x256)
    const contours = this.findContours(mask.mask, mask.width, mask.height);

    if (contours.length === 0) {
      console.warn('[SAM] No contours found in mask');
      return [];
    }

    // Get largest contour
    const largestContour = contours.reduce((a, b) => 
      a.length > b.length ? a : b
    );

    console.log('[SAM] Contour found:', {
      numContours: contours.length,
      largestContourPoints: largestContour.length,
      maskSize: `${mask.width}x${mask.height}`,
      originalSize: `${encoding.originalWidth}x${encoding.originalHeight}`,
      firstFewPoints: largestContour.slice(0, 5),
    });

    // Scale points from mask space to original image space
    const scaledPoints = largestContour.map(p => {
      const x = scaleX(p.x);
      const y = scaleY(p.y);
      // Validate coordinates are within bounds
      const validX = Math.max(0, Math.min(encoding.originalWidth - 1, x));
      const validY = Math.max(0, Math.min(encoding.originalHeight - 1, y));
      return { x: validX, y: validY };
    });
    
    // Remove invalid points (NaN, Infinity, or out of bounds)
    const validPoints = scaledPoints.filter(p => 
      isFinite(p.x) && isFinite(p.y) && 
      p.x >= 0 && p.x < encoding.originalWidth &&
      p.y >= 0 && p.y < encoding.originalHeight
    );
    
    if (validPoints.length < 3) {
      console.warn('[SAM] Not enough valid points after scaling:', {
        original: scaledPoints.length,
        valid: validPoints.length,
        firstFew: scaledPoints.slice(0, 5),
      });
      return [];
    }
    
    // Ensure polygon is closed (first point == last point)
    if (validPoints.length > 0) {
      const first = validPoints[0];
      const last = validPoints[validPoints.length - 1];
      if (first.x !== last.x || first.y !== last.y) {
        validPoints.push({ x: first.x, y: first.y });
      }
    }
    
    // Use valid points for further processing
    const pointsToSimplify = validPoints;
    
    // Simplify polygon (remove duplicate/close points)
    const simplified = this.simplifyPolygon(pointsToSimplify);
    
    // Ensure simplified polygon is also closed
    if (simplified.length > 0) {
      const first = simplified[0];
      const last = simplified[simplified.length - 1];
      if (first.x !== last.x || first.y !== last.y) {
        simplified.push({ x: first.x, y: first.y });
      }
    }
    
    // Debug: Check coordinate ranges
    if (simplified.length > 0) {
      const xValues = simplified.map(p => p.x);
      const yValues = simplified.map(p => p.y);
      const minX = Math.min(...xValues);
      const maxX = Math.max(...xValues);
      const minY = Math.min(...yValues);
      const maxY = Math.max(...yValues);
      
      console.log('[SAM] Scaled polygon:', {
        originalPoints: largestContour.length,
        simplifiedPoints: simplified.length,
        isClosed: simplified.length > 0 && simplified[0].x === simplified[simplified.length - 1].x && simplified[0].y === simplified[simplified.length - 1].y,
        coordinateRanges: {
          x: `[${minX}, ${maxX}] (image width: ${encoding.originalWidth}, coverage: ${((maxX - minX) / encoding.originalWidth * 100).toFixed(1)}%)`,
          y: `[${minY}, ${maxY}] (image height: ${encoding.originalHeight}, coverage: ${((maxY - minY) / encoding.originalHeight * 100).toFixed(1)}%)`,
        },
        samplePoints: {
          first: simplified[0],
          middle: simplified[Math.floor(simplified.length / 2)],
          last: simplified[simplified.length - 1],
        },
        firstFewScaled: simplified.slice(0, 5),
        lastFewScaled: simplified.slice(-5),
      });
      
      // Check for invalid coordinates
      const invalidCoords = simplified.filter(p => 
        !isFinite(p.x) || !isFinite(p.y) || 
        p.x < 0 || p.x >= encoding.originalWidth ||
        p.y < 0 || p.y >= encoding.originalHeight
      );
      if (invalidCoords.length > 0) {
        console.warn('[SAM] Invalid coordinates found:', {
          count: invalidCoords.length,
          examples: invalidCoords.slice(0, 5),
        });
      }
    }
    
    // Validate polygon has at least 3 points
    if (simplified.length < 3) {
      console.warn('[SAM] Polygon has too few points:', simplified.length);
      return [];
    }
    
    return simplified;
  }
  
  private calculatePolygonArea(points: Coordinate[]): number {
    if (points.length < 3) {
      console.warn('[SAM] calculatePolygonArea: Not enough points', points.length);
      return 0;
    }
    
    // Remove duplicate consecutive points
    const cleanedPoints: Coordinate[] = [points[0]];
    for (let i = 1; i < points.length; i++) {
      const prev = cleanedPoints[cleanedPoints.length - 1];
      const curr = points[i];
      // Only add if point is different from previous
      if (curr.x !== prev.x || curr.y !== prev.y) {
        cleanedPoints.push(curr);
      }
    }
    
    // Remove the closing point if it's a duplicate of the first
    if (cleanedPoints.length > 2) {
      const first = cleanedPoints[0];
      const last = cleanedPoints[cleanedPoints.length - 1];
      if (first.x === last.x && first.y === last.y) {
        cleanedPoints.pop(); // Remove duplicate closing point
      }
    }
    
    if (cleanedPoints.length < 3) {
      console.warn('[SAM] calculatePolygonArea: Not enough points after cleaning', cleanedPoints.length);
      return 0;
    }
    
    // Shoelace formula for polygon area
    // Formula: area = 0.5 * |sum(x_i * y_{i+1} - x_{i+1} * y_i)|
    let area = 0;
    const n = cleanedPoints.length;
    
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n; // Wrap around to first point
      area += cleanedPoints[i].x * cleanedPoints[j].y;
      area -= cleanedPoints[j].x * cleanedPoints[i].y;
    }
    
    const calculatedArea = Math.abs(area / 2);
    
    // Validate the area makes sense
    if (isNaN(calculatedArea) || !isFinite(calculatedArea) || calculatedArea <= 0) {
      console.warn('[SAM] Invalid polygon area calculated:', {
        area: calculatedArea,
        rawArea: area,
        numPoints: cleanedPoints.length,
        firstFew: cleanedPoints.slice(0, 5),
        lastFew: cleanedPoints.slice(-5),
      });
      return 0;
    }
    
    return calculatedArea;
  }
  
  private simplifyPolygon(points: Coordinate[], threshold: number = 2): Coordinate[] {
    if (points.length <= 3) return points;
    
    // Adaptive threshold based on image size
    // For large images, use a larger threshold to avoid over-simplification
    // For small images, use a smaller threshold
    const imageSize = Math.max(
      points.reduce((max, p) => Math.max(max, p.x), 0),
      points.reduce((max, p) => Math.max(max, p.y), 0)
    );
    // Scale threshold based on image size: 2px for 1000px images, proportionally larger for bigger images
    const adaptiveThreshold = Math.max(2, Math.min(10, (imageSize / 1000) * 2));
    
    const simplified: Coordinate[] = [points[0]];
    let skippedCount = 0;
    
    for (let i = 1; i < points.length - 1; i++) {
      const prev = simplified[simplified.length - 1];
      const curr = points[i];
      const next = points[i + 1];
      
      // Calculate distance from current point to line between prev and next
      const dx = next.x - prev.x;
      const dy = next.y - prev.y;
      const lineLength = Math.sqrt(dx * dx + dy * dy);
      
      if (lineLength < 0.001) {
        // Points are too close, skip
        skippedCount++;
        continue;
      }
      
      const dist = Math.abs((dy * curr.x - dx * curr.y + next.x * prev.y - next.y * prev.x) / lineLength);
      
      // Keep point if it's far enough from the line
      if (dist > adaptiveThreshold) {
        simplified.push(curr);
      } else {
        skippedCount++;
      }
    }
    
    // Always keep the last point
    simplified.push(points[points.length - 1]);
    
    // If we removed too many points (>90%), the threshold might be too high
    // Return original points if simplification was too aggressive
    const removalRatio = skippedCount / (points.length - 2);
    if (removalRatio > 0.9) {
      console.warn('[SAM] Polygon simplification too aggressive, using original points', {
        original: points.length,
        simplified: simplified.length,
        removalRatio: (removalRatio * 100).toFixed(1) + '%',
        threshold: adaptiveThreshold,
      });
      return points;
    }
    
    console.log('[SAM] Polygon simplification:', {
      original: points.length,
      simplified: simplified.length,
      removed: skippedCount,
      removalRatio: (removalRatio * 100).toFixed(1) + '%',
      threshold: adaptiveThreshold,
    });
    
    return simplified;
  }

  private findContours(mask: Uint8Array, width: number, height: number): Coordinate[][] {
    // Improved contour finding - find edge pixels (255 adjacent to 0 or boundary)
    const contours: Coordinate[][] = [];
    const visited = new Set<string>();
    
    // Count foreground pixels for debugging
    let foregroundCount = 0;
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] === 255) foregroundCount++;
    }
    console.log('[SAM] Contour finding - foreground pixels:', foregroundCount, 'out of', mask.length);

    // Find edge pixels - pixels that are 255 and have at least one 0 neighbor or are on boundary
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (mask[idx] === 255 && !visited.has(`${x},${y}`)) {
          // Check if this is an edge pixel (has 0 neighbor or is on boundary)
          const isEdge = this.isEdgePixel(mask, width, height, x, y);
          if (isEdge) {
            // Found a new contour starting point
            const contour = this.traceContour(mask, width, height, x, y, visited);
            if (contour.length >= 3) { // Need at least 3 points for a valid polygon
              contours.push(contour);
            }
          }
        }
      }
    }
    
    console.log('[SAM] Found', contours.length, 'contours');
    return contours;
  }
  
  private isEdgePixel(mask: Uint8Array, width: number, height: number, x: number, y: number): boolean {
    // Check if pixel is on boundary
    if (x === 0 || x === width - 1 || y === 0 || y === height - 1) {
      return true;
    }
    
    // Check neighbors - if any neighbor is 0, this is an edge pixel
    const neighbors = [
      [x - 1, y - 1], [x, y - 1], [x + 1, y - 1],
      [x - 1, y],                 [x + 1, y],
      [x - 1, y + 1], [x, y + 1], [x + 1, y + 1]
    ];
    
    for (const [nx, ny] of neighbors) {
      if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
        const nIdx = ny * width + nx;
        if (mask[nIdx] === 0) {
          return true;
        }
      }
    }
    
    return false;
  }

  private traceContour(
    mask: Uint8Array,
    width: number,
    height: number,
    startX: number,
    startY: number,
    visited: Set<string>
  ): Coordinate[] {
    const contour: Coordinate[] = [];
    // Use 4-connectivity for faster tracing (up, right, down, left)
    const directions = [
      [0, -1], [1, 0], [0, 1], [-1, 0]  // up, right, down, left
    ];

    let x = startX;
    let y = startY;
    let dir = 0; // Start going up
    const maxIterations = width * height; // Safety limit
    let iterations = 0;

    do {
      const key = `${x},${y}`;
      if (visited.has(key) && contour.length > 0) {
        // We've looped back
        break;
      }
      visited.add(key);
      contour.push({ x, y });

      // Find next edge pixel in clockwise direction
      let found = false;
      for (let i = 0; i < 4; i++) {
        const checkDir = (dir + i) % 4;
        const [dx, dy] = directions[checkDir];
        const nx = x + dx;
        const ny = y + dy;

        if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
          const idx = ny * width + nx;
          if (mask[idx] === 255) {
            x = nx;
            y = ny;
            dir = (checkDir + 3) % 4; // Turn right (for clockwise tracing)
            found = true;
            break;
          }
        }
      }

      if (!found) break;
      iterations++;
    } while ((x !== startX || y !== startY || contour.length < 3) && iterations < maxIterations);

    // If we didn't close the contour, it might be incomplete
    if (contour.length < 3) {
      return [];
    }

    return contour;
  }

  dispose() {
    this.session?.dispose();
    this.session = null;
  }
}
