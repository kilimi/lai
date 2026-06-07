# SAM Browser Implementation Plan
## Fast Segment Anything Model for Semantic Segmentation

Based on analysis of GETI's efficient SAM implementation, here's a comprehensive step-by-step plan.

---

## 🎯 Overview

**Goal**: Implement fast SAM (Segment Anything Model) in the browser for semantic segmentation annotation, similar to GETI's efficient implementation.

**Key Technologies**:
- **ONNX Runtime Web** (`onnxruntime-web`) - Run ONNX models in browser
- **OpenCV.js** - Image preprocessing
- **Web Workers** + **Comlink** - Offload computation
- **React Query** - Cache encoder outputs
- **MobileSAM** - Smaller, faster encoder model

---

## 📋 Implementation Steps

### Phase 1: Setup & Dependencies

#### Step 1.1: Install Required Packages
```bash
npm install onnxruntime-web comlink @tanstack/react-query
```

**Why**: 
- `onnxruntime-web`: Runs ONNX models in browser using WebAssembly
- `comlink`: Simplifies Web Worker communication
- `@tanstack/react-query`: Caches encoder outputs (expensive operation)

#### Step 1.2: Download SAM Models
Download ONNX models:
- **MobileSAM Encoder** (`mobile_sam.encoder.onnx`) - ~40MB, faster
- **SAM Decoder** (`sam_vit_h_4b8939.decoder.onnx`) - ~350MB

**Sources**:
- MobileSAM: https://github.com/ChaoningZhang/MobileSAM
- SAM models: Convert from PyTorch using `torch.onnx.export()` or download pre-converted

**Place models in**: `public/models/sam/`

#### Step 1.3: Setup OpenCV.js (Optional but Recommended)
For image preprocessing, either:
- Use OpenCV.js (larger bundle ~8MB)
- Or implement custom preprocessing with Canvas API (smaller bundle)

**Recommendation**: Start with Canvas API, add OpenCV.js if needed for complex preprocessing.

---

### Phase 2: Core SAM Implementation

#### Step 2.1: Create ONNX Session Manager
**File**: `src/utils/sam/session.ts`

```typescript
import * as ort from 'onnxruntime-web';

export class SAMSession {
  private session: ort.InferenceSession | null = null;
  
  async init(modelPath: string) {
    ort.env.wasm.numThreads = navigator.hardwareConcurrency || 4;
    ort.env.wasm.simd = true; // Use SIMD for faster computation
    
    const modelData = await fetch(modelPath).then(r => r.arrayBuffer());
    
    this.session = await ort.InferenceSession.create(modelData, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
      executionMode: 'parallel',
    });
  }
  
  async run(inputs: ort.InferenceSession.OnnxValueMapType) {
    if (!this.session) throw new Error('Session not initialized');
    return await this.session.run(inputs);
  }
}
```

**Key Points**:
- Use WebAssembly with SIMD for performance
- Enable parallel execution
- Configure thread count based on CPU cores

#### Step 2.2: Create Image Preprocessor
**File**: `src/utils/sam/preprocessor.ts`

**Responsibilities**:
- Resize image to 1024x1024 (SAM input size)
- Normalize pixel values: `(pixel / 255 - mean) / std`
- Convert to tensor format
- Handle padding for non-square images

**Implementation Options**:
1. **Canvas API** (lighter):
   ```typescript
   function preprocessImage(imageData: ImageData): Float32Array {
     // Resize, normalize, convert to tensor
   }
   ```

2. **OpenCV.js** (more features):
   ```typescript
   import cv from 'opencv-js';
   // Use cv.resize(), cv.normalize(), etc.
   ```

#### Step 2.3: Create SAM Encoder
**File**: `src/utils/sam/encoder.ts`

**Responsibilities**:
- Load MobileSAM encoder model
- Process image through encoder
- Return image embeddings (cached per image)

**Key Features**:
- Cache encoder output (expensive operation, ~500ms-2s)
- Reuse embeddings for multiple decoder calls
- Handle image changes (invalidate cache)

```typescript
export class SAMEncoder {
  private session: SAMSession;
  private cache = new Map<string, EncodingOutput>();
  
  async encode(imageData: ImageData, imageId: string): Promise<EncodingOutput> {
    if (this.cache.has(imageId)) {
      return this.cache.get(imageId)!;
    }
    
    const preprocessed = preprocessImage(imageData);
    const output = await this.session.run({ image: preprocessed });
    
    const encoding = output.image_embeddings;
    this.cache.set(imageId, encoding);
    return encoding;
  }
}
```

#### Step 2.4: Create SAM Decoder
**File**: `src/utils/sam/decoder.ts`

**Responsibilities**:
- Load SAM decoder model
- Process prompts (points, boxes) with cached embeddings
- Return segmentation masks

**Key Features**:
- Fast inference (~50-150ms per call)
- Support multiple prompts (positive/negative points)
- Return polygon contours from masks

```typescript
export class SAMDecoder {
  private session: SAMSession;
  
  async decode(
    encoding: EncodingOutput,
    prompts: { points: Point[], labels: number[] }
  ): Promise<SegmentationMask> {
    const decoderInput = prepareDecoderInput(encoding, prompts);
    const output = await this.session.run(decoderInput);
    
    return postprocessMask(output.masks);
  }
}
```

---

### Phase 3: Web Worker Integration

#### Step 3.1: Create SAM Worker
**File**: `src/workers/sam.worker.ts`

**Purpose**: Run SAM models in background thread to avoid blocking UI

```typescript
import { expose } from 'comlink';
import { SAMEncoder } from '../utils/sam/encoder';
import { SAMDecoder } from '../utils/sam/decoder';

class SAMWorker {
  private encoder: SAMEncoder;
  private decoder: SAMDecoder;
  
  async init() {
    this.encoder = new SAMEncoder();
    await this.encoder.init('/models/sam/mobile_sam.encoder.onnx');
    
    this.decoder = new SAMDecoder();
    await this.decoder.init('/models/sam/sam_vit_h_4b8939.decoder.onnx');
  }
  
  async encodeImage(imageData: ImageData, imageId: string) {
    return await this.encoder.encode(imageData, imageId);
  }
  
  async decodeMask(encoding: EncodingOutput, prompts: Prompt[]) {
    return await this.decoder.decode(encoding, prompts);
  }
}

expose(new SAMWorker());
```

#### Step 3.2: Create Worker Hook
**File**: `src/hooks/use-sam-worker.ts`

```typescript
import { useQuery } from '@tanstack/react-query';
import { wrap, Remote } from 'comlink';
import SAMWorker from '../workers/sam.worker?worker';

export function useSAMWorker() {
  const { data: worker } = useQuery({
    queryKey: ['sam-worker'],
    queryFn: async () => {
      const w = wrap<typeof SAMWorker>(new SAMWorker());
      await w.init();
      return w;
    },
    staleTime: Infinity,
  });
  
  return worker;
}
```

---

### Phase 4: React Integration

#### Step 4.1: Create SAM Hook
**File**: `src/hooks/use-sam.ts`

**Features**:
- Cache encoder outputs per image
- Throttle decoder calls (150ms) for mouse movement
- Preload next image encoding

```typescript
export function useSAM(imageData: ImageData | null, imageId: string) {
  const worker = useSAMWorker();
  
  // Cache encoder output
  const { data: encoding } = useQuery({
    queryKey: ['sam-encoding', imageId],
    queryFn: () => worker?.encodeImage(imageData!, imageId),
    enabled: !!imageData && !!worker,
    staleTime: Infinity,
    gcTime: 3600 * 1000, // 1 hour
  });
  
  // Throttled decoder
  const decodeThrottled = useThrottledCallback(
    async (points: Point[]) => {
      if (!encoding || !worker) return null;
      return await worker.decodeMask(encoding, points);
    },
    150 // ms
  );
  
  return { encoding, decode: decodeThrottled, isLoading: !encoding };
}
```

#### Step 4.2: Create SAM Tool Component
**File**: `src/components/annotation/SAMTool.tsx`

**Features**:
- Click to add positive/negative points
- Real-time preview on mouse hover
- Accept/reject segmentation
- Interactive mode toggle

**UI Elements**:
- Loading indicator during encoder processing
- Point markers (green=positive, red=negative)
- Preview polygon overlay
- Accept/Reject buttons

```typescript
export function SAMTool() {
  const { imageData, imageId } = useImageContext();
  const { encoding, decode, isLoading } = useSAM(imageData, imageId);
  const [points, setPoints] = useState<Point[]>([]);
  const [preview, setPreview] = useState<Polygon | null>(null);
  
  const handleMouseMove = useThrottledCallback(async (e: MouseEvent) => {
    const point = getRelativePoint(e);
    const result = await decode([...points, point]);
    setPreview(result);
  }, 150);
  
  const handleClick = async (e: MouseEvent) => {
    const point = getRelativePoint(e);
    const isPositive = !e.ctrlKey; // Ctrl = negative point
    
    setPoints([...points, { ...point, label: isPositive ? 1 : 0 }]);
    
    const result = await decode([...points, { ...point, label: isPositive ? 1 : 0 }]);
    setPreview(result);
  };
  
  return (
    <div>
      {isLoading && <LoadingIndicator>Extracting image features...</LoadingIndicator>}
      <Canvas onMouseMove={handleMouseMove} onClick={handleClick}>
        {points.map(renderPoint)}
        {preview && <Polygon path={preview} />}
      </Canvas>
      <Button onClick={acceptAnnotation}>Accept</Button>
    </div>
  );
}
```

---

### Phase 5: Performance Optimizations

#### Step 5.1: Model Optimization
- **Quantize models**: Use INT8 quantization (4x smaller, ~2x faster)
- **Use MobileSAM**: Smaller encoder (~40MB vs ~350MB)
- **Lazy load**: Load decoder only when needed

#### Step 5.2: Caching Strategy
- **Encoder cache**: Per image, persist in IndexedDB
- **Decoder cache**: Not needed (fast enough)
- **Preload**: Encode next image in background

#### Step 5.3: Throttling & Debouncing
- **Mouse move**: Throttle to 150ms
- **Decoder calls**: Queue and process sequentially
- **UI updates**: Use `requestAnimationFrame`

#### Step 5.4: Memory Management
- **Clear cache**: After 1 hour or 10 images
- **Dispose sessions**: When component unmounts
- **Monitor memory**: Use `performance.memory` API

---

### Phase 6: Integration with Existing Annotation System

#### Step 6.1: Add SAM Tool to Toolbar
**File**: `src/pages/ImageAnnotation.tsx`

Add SAM tool button alongside existing tools:
```typescript
<ToolButton 
  icon={<Sparkles />} 
  label="Auto Segment" 
  onClick={() => setTool('sam')}
  active={tool === 'sam'}
/>
```

#### Step 6.2: Convert SAM Output to Annotation Format
**File**: `src/utils/sam/converters.ts`

```typescript
export function samMaskToPolygon(mask: SegmentationMask): Polygon {
  // Convert binary mask to polygon contour
  const contours = findContours(mask);
  const largestContour = contours[0]; // Get largest contour
  return contourToPolygon(largestContour);
}
```

#### Step 6.3: Handle Annotation Updates
- Convert SAM polygon to your annotation format
- Save to backend via existing API
- Update annotation list

---

## 📊 Performance Targets

Based on GETI's implementation:

| Operation | Target Time | Notes |
|-----------|-------------|-------|
| Encoder (first time) | 500ms - 2s | Cached after first run |
| Encoder (cached) | < 10ms | From memory |
| Decoder (single point) | 50-150ms | Real-time preview |
| Decoder (multiple points) | 100-250ms | With refinement |
| Memory usage | < 500MB | Including models |

---

## 🔧 Technical Decisions

### Why ONNX Runtime Web?
- ✅ Runs in browser (no server needed)
- ✅ WebAssembly for performance
- ✅ Supports SIMD instructions
- ✅ Multi-threading support
- ✅ Smaller than TensorFlow.js

### Why Web Workers?
- ✅ Non-blocking UI
- ✅ Better performance isolation
- ✅ Can use multiple CPU cores

### Why MobileSAM Encoder?
- ✅ 10x smaller than SAM ViT-H encoder
- ✅ 5x faster inference
- ✅ Similar quality for most use cases

### Why React Query?
- ✅ Automatic caching
- ✅ Background refetching
- ✅ Preloading support
- ✅ Memory management

---

## 📁 File Structure

```
src/
├── components/
│   └── annotation/
│       ├── SAMTool.tsx          # Main SAM tool component
│       └── SAMPointMarker.tsx    # Point visualization
├── hooks/
│   ├── use-sam.ts               # Main SAM hook
│   └── use-sam-worker.ts        # Worker management
├── utils/
│   └── sam/
│       ├── session.ts            # ONNX session manager
│       ├── encoder.ts            # SAM encoder
│       ├── decoder.ts            # SAM decoder
│       ├── preprocessor.ts       # Image preprocessing
│       └── converters.ts         # Format conversions
└── workers/
    └── sam.worker.ts             # SAM Web Worker
public/
└── models/
    └── sam/
        ├── mobile_sam.encoder.onnx
        └── sam_vit_h_4b8939.decoder.onnx
```

---

## 🚀 Implementation Order

1. **Week 1**: Setup dependencies, download models, create basic ONNX session
2. **Week 2**: Implement encoder and decoder classes
3. **Week 3**: Create Web Worker integration
4. **Week 4**: Build React components and hooks
5. **Week 5**: Performance optimization and testing
6. **Week 6**: Integration with existing annotation system

---

## 🧪 Testing Strategy

1. **Unit Tests**: Test encoder/decoder independently
2. **Integration Tests**: Test worker communication
3. **Performance Tests**: Measure inference times
4. **E2E Tests**: Test full annotation workflow
5. **Browser Compatibility**: Test in Chrome, Firefox, Safari

---

## 📚 Resources

- **ONNX Runtime Web**: https://onnxruntime.ai/docs/tutorials/web/
- **MobileSAM**: https://github.com/ChaoningZhang/MobileSAM
- **SAM Paper**: https://arxiv.org/abs/2304.02643
- **Comlink**: https://github.com/GoogleChromeLabs/comlink
- **React Query**: https://tanstack.com/query/latest

---

## ⚠️ Considerations

1. **Model Size**: ~400MB total (consider CDN hosting)
2. **Browser Support**: Requires WebAssembly support
3. **Memory**: Monitor memory usage, especially on mobile
4. **Network**: Consider progressive loading for models
5. **Fallback**: Provide server-side SAM if browser fails

---

## 🎯 Success Criteria

- ✅ SAM tool loads in < 3 seconds
- ✅ Encoder processes image in < 2 seconds
- ✅ Decoder responds in < 150ms
- ✅ Smooth 60fps UI during interaction
- ✅ Works on modern browsers (Chrome, Firefox, Safari)
- ✅ Memory usage < 500MB
- ✅ Integrates seamlessly with existing annotation system
