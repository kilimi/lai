import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  EVAL_PREDICTION_DEFAULT_PAD_FRAC,
  EVAL_PREDICTION_MIN_BOX_EPS,
  drawPredictionSnapshotCrop,
  getPredictionBboxXyxy,
  paddedCropRegion,
} from "../../utils/evaluationPredictionDisplay";

describe("getPredictionBboxXyxy", () => {
  it("parses bbox_xyxy in order", () => {
    expect(getPredictionBboxXyxy({ bbox_xyxy: [10, 20, 100, 200] })).toEqual([10, 20, 100, 200]);
  });

  it("normalizes inverted xyxy corners", () => {
    expect(getPredictionBboxXyxy({ bbox_xyxy: [100, 100, 10, 50] })).toEqual([10, 50, 100, 100]);
  });

  it("converts COCO-style bbox [x,y,w,h] to xyxy", () => {
    expect(getPredictionBboxXyxy({ bbox: [5, 6, 10, 8] })).toEqual([5, 6, 15, 14]);
  });

  it("handles negative width/height in xywh via normalization", () => {
    expect(getPredictionBboxXyxy({ bbox: [20, 20, -10, -15] })).toEqual([10, 5, 20, 20]);
  });

  it("returns null for missing bbox fields", () => {
    expect(getPredictionBboxXyxy({})).toBeNull();
  });

  it("returns null for too-short arrays", () => {
    expect(getPredictionBboxXyxy({ bbox_xyxy: [1, 2, 3] })).toBeNull();
  });

  it("returns null when values are NaN", () => {
    expect(getPredictionBboxXyxy({ bbox_xyxy: [1, 2, 3, NaN] })).toBeNull();
  });

  it("returns null for zero-area xyxy", () => {
    expect(getPredictionBboxXyxy({ bbox_xyxy: [10, 10, 10, 50] })).toBeNull();
  });

  it("returns null for zero-area xywh", () => {
    expect(getPredictionBboxXyxy({ bbox: [10, 10, 0, 5] })).toBeNull();
  });

  it("prefers bbox_xyxy over bbox when both exist", () => {
    expect(
      getPredictionBboxXyxy({
        bbox_xyxy: [0, 0, 4, 4],
        bbox: [100, 100, 1, 1],
      })
    ).toEqual([0, 0, 4, 4]);
  });
});

describe("paddedCropRegion", () => {
  it("expands region by default pad fraction and clamps to image", () => {
    const box: [number, number, number, number] = [100, 100, 200, 200];
    const { sx, sy, sw, sh } = paddedCropRegion(box, 1000, 800);
    const bw = 100;
    const bh = 100;
    const pad = bw * EVAL_PREDICTION_DEFAULT_PAD_FRAC;
    expect(sx).toBe(100 - pad);
    expect(sy).toBe(100 - pad);
    expect(sw).toBe(bw + 2 * pad);
    expect(sh).toBe(bh + 2 * pad);
    expect(sx + sw).toBeLessThanOrEqual(1000);
    expect(sy + sh).toBeLessThanOrEqual(800);
  });

  it("clamps crop origin when padding would go past the top-left", () => {
    const { sx, sy } = paddedCropRegion([0, 0, 5, 5], 500, 400);
    expect(sx).toBe(0);
    expect(sy).toBe(0);
  });

  it("uses MIN_BOX_EPS for degenerate input width", () => {
    const { sw } = paddedCropRegion([50, 50, 50, 60], 200, 200);
    expect(sw).toBeGreaterThanOrEqual(1);
    const bw = EVAL_PREDICTION_MIN_BOX_EPS;
    const pad = bw * EVAL_PREDICTION_DEFAULT_PAD_FRAC;
    expect(sw).toBeGreaterThanOrEqual(bw + 2 * pad - 0.001);
  });
});

describe("drawPredictionSnapshotCrop", () => {
  let mockCtx: CanvasRenderingContext2D;

  beforeEach(() => {
    vi.stubGlobal("devicePixelRatio", 1);
    mockCtx = {
      setTransform: vi.fn(),
      scale: vi.fn(),
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
      fillText: vi.fn(),
      measureText: vi.fn().mockReturnValue({ width: 80 }),
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("no-ops when image natural size is zero", () => {
    const canvas = document.createElement("canvas");
    vi.spyOn(canvas, "getContext").mockReturnValue(mockCtx);
    const img = document.createElement("img");
    Object.defineProperty(img, "naturalWidth", { value: 0, configurable: true });
    Object.defineProperty(img, "naturalHeight", { value: 0, configurable: true });
    drawPredictionSnapshotCrop(canvas, img, [0, 0, 10, 10], "cat · 90.0%", 200, 200);
    expect(mockCtx.drawImage).not.toHaveBeenCalled();
  });

  it("draws crop, box, and label when dimensions are valid", () => {
    const canvas = document.createElement("canvas");
    vi.spyOn(canvas, "getContext").mockReturnValue(mockCtx);
    const img = document.createElement("img");
    Object.defineProperty(img, "naturalWidth", { value: 400, configurable: true });
    Object.defineProperty(img, "naturalHeight", { value: 300, configurable: true });
    drawPredictionSnapshotCrop(canvas, img, [50, 40, 120, 90], "dog · 88.0%", 160, 120);
    expect(mockCtx.drawImage).toHaveBeenCalled();
    expect(mockCtx.strokeRect).toHaveBeenCalled();
    expect(mockCtx.fillText).toHaveBeenCalledWith("dog · 88.0%", expect.any(Number), expect.any(Number));
  });

  it("returns early when canvas context is missing", () => {
    const canvas = document.createElement("canvas");
    vi.spyOn(canvas, "getContext").mockReturnValue(null);
    const img = document.createElement("img");
    Object.defineProperty(img, "naturalWidth", { value: 100, configurable: true });
    Object.defineProperty(img, "naturalHeight", { value: 100, configurable: true });
    drawPredictionSnapshotCrop(canvas, img, [0, 0, 10, 10], "x", 50, 50);
    expect(canvas.width).toBeGreaterThan(0);
  });
});
