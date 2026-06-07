import * as ort from 'onnxruntime-web';

export class SAMSession {
  private session: ort.InferenceSession | null = null;

  async init(modelPath: string) {
    // Configure ONNX Runtime for optimal performance
    // Don't set numThreads (let it auto-detect) to avoid cross-origin isolation issues
    ort.env.wasm.simd = true; // Use SIMD for faster computation
    
    // Suppress verbose warnings (CPU vendor warning is harmless)
    ort.env.logLevel = 'warning'; // Only show warnings and errors, not verbose info
    
    // Configure WASM paths - point to public/wasm directory
    // We've copied the WASM files there so Vite can serve them correctly
    // Include all WASM files that onnxruntime-web might need
    // Use paths that work in both main thread and worker contexts
    // In workers, we can use self.location or relative paths
    // In main thread, we can use window.location or relative paths
    let wasmBaseUrl: string;
    if (typeof window !== 'undefined') {
      // Main thread - use window.location
      wasmBaseUrl = new URL('/wasm/', window.location.origin).href;
    } else if (typeof self !== 'undefined' && self.location) {
      // Web Worker - use self.location
      wasmBaseUrl = new URL('/wasm/', self.location.origin).href;
    } else {
      // Fallback to relative path
      wasmBaseUrl = '/wasm/';
    }
    console.log('[SAM] Configuring WASM paths with base URL:', wasmBaseUrl);
    
    // Set WASM path prefix (simpler approach)
    ort.env.wasm.wasmPaths = wasmBaseUrl;
    
    console.log('[SAM] WASM paths configured:', ort.env.wasm.wasmPaths);
    
    console.log('[SAM] Loading model from:', modelPath);
    
    // Load model
    const modelData = await fetch(modelPath).then(r => {
      if (!r.ok) {
        throw new Error(`Failed to fetch model: ${r.status} ${r.statusText}`);
      }
      return r.arrayBuffer();
    });
    
    if (!modelData || modelData.byteLength === 0) {
      throw new Error(`Unable to load model from "${modelPath}" - file is empty or not found`);
    }

    console.log('[SAM] Model loaded, size:', (modelData.byteLength / 1024 / 1024).toFixed(2), 'MB');
    console.log('[SAM] Creating inference session...');

    // Create inference session with optimizations
    this.session = await ort.InferenceSession.create(modelData, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
      executionMode: 'parallel',
    });
    
    console.log('[SAM] Session created successfully');
    console.log('[SAM] Input names:', this.session.inputNames);
    console.log('[SAM] Output names:', this.session.outputNames);
  }

  async run(inputs: ort.InferenceSession.OnnxValueMapType): Promise<ort.InferenceSession.OnnxValueMapType> {
    if (!this.session) {
      throw new Error('Session not initialized. Call init() first.');
    }
    return await this.session.run(inputs);
  }

  getInputNames(): readonly string[] {
    if (!this.session) {
      throw new Error('Session not initialized');
    }
    return this.session.inputNames;
  }

  getOutputNames(): readonly string[] {
    if (!this.session) {
      throw new Error('Session not initialized');
    }
    return this.session.outputNames;
  }

  dispose() {
    this.session = null;
  }
}
