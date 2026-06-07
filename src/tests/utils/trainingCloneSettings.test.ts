import { describe, it, expect } from "vitest";
import { parseYoloPresetFromModelType } from "@/utils/trainingCloneSettings";

describe("parseYoloPresetFromModelType", () => {
  // ─── YOLOv8 ──────────────────────────────────────────────────────────────

  it("parses yolov8n.pt → version=yolov8, size=n, task=detection", () => {
    const result = parseYoloPresetFromModelType("yolov8n.pt");
    expect(result).not.toBeNull();
    expect(result!.version).toBe("yolov8");
    expect(result!.size).toBe("n");
    expect(result!.task).toBe("detection");
    expect(result!.modelSize).toBe("yolov8n.pt");
  });

  it("parses yolov8s-seg.pt → version=yolov8, size=s, task=segmentation", () => {
    const result = parseYoloPresetFromModelType("yolov8s-seg.pt");
    expect(result).not.toBeNull();
    expect(result!.version).toBe("yolov8");
    expect(result!.size).toBe("s");
    expect(result!.task).toBe("segmentation");
    expect(result!.modelSize).toBe("yolov8s-seg.pt");
  });

  it("parses yolov8m-cls.pt → version=yolov8, size=m, task=classification", () => {
    const result = parseYoloPresetFromModelType("yolov8m-cls.pt");
    expect(result).not.toBeNull();
    expect(result!.version).toBe("yolov8");
    expect(result!.size).toBe("m");
    expect(result!.task).toBe("classification");
    expect(result!.modelSize).toBe("yolov8m-cls.pt");
  });

  it("parses yolov8l.pt → version=yolov8, size=l", () => {
    const result = parseYoloPresetFromModelType("yolov8l.pt");
    expect(result).not.toBeNull();
    expect(result!.version).toBe("yolov8");
    expect(result!.size).toBe("l");
  });

  it("parses yolov8x.pt → version=yolov8, size=x", () => {
    const result = parseYoloPresetFromModelType("yolov8x.pt");
    expect(result).not.toBeNull();
    expect(result!.version).toBe("yolov8");
    expect(result!.size).toBe("x");
  });

  // ─── YOLO11 ──────────────────────────────────────────────────────────────

  it("parses yolo11n-seg.pt → version=yolo11, size=n, task=segmentation", () => {
    const result = parseYoloPresetFromModelType("yolo11n-seg.pt");
    expect(result).not.toBeNull();
    expect(result!.version).toBe("yolo11");
    expect(result!.size).toBe("n");
    expect(result!.task).toBe("segmentation");
    expect(result!.modelSize).toBe("yolo11n-seg.pt");
  });

  it("parses yolo11s.pt → version=yolo11, size=s, task=detection", () => {
    const result = parseYoloPresetFromModelType("yolo11s.pt");
    expect(result).not.toBeNull();
    expect(result!.version).toBe("yolo11");
    expect(result!.size).toBe("s");
    expect(result!.task).toBe("detection");
  });

  it("parses yolov11m-cls.pt → version=yolo11, size=m, task=classification", () => {
    const result = parseYoloPresetFromModelType("yolov11m-cls.pt");
    expect(result).not.toBeNull();
    expect(result!.version).toBe("yolo11");
    expect(result!.size).toBe("m");
    expect(result!.task).toBe("classification");
  });

  // ─── modelSize round-trip correctness ────────────────────────────────────

  it("modelSize of cloned yolov8 task matches original model_type", () => {
    // This is the key regression: cloning a yolov8n.pt task should produce
    // modelSize='yolov8n.pt', not 'yolo11n.pt' or 'yolo8n.pt'.
    const fixtures: Array<{ input: string; expectedModelSize: string }> = [
      { input: "yolov8n.pt", expectedModelSize: "yolov8n.pt" },
      { input: "yolov8s-seg.pt", expectedModelSize: "yolov8s-seg.pt" },
      { input: "yolov8m-cls.pt", expectedModelSize: "yolov8m-cls.pt" },
      { input: "yolov8l.pt", expectedModelSize: "yolov8l.pt" },
      { input: "yolo11n-seg.pt", expectedModelSize: "yolo11n-seg.pt" },
      { input: "yolo11s-cls.pt", expectedModelSize: "yolo11s-cls.pt" },
    ];

    for (const { input, expectedModelSize } of fixtures) {
      const result = parseYoloPresetFromModelType(input);
      expect(result, `failed for input: ${input}`).not.toBeNull();
      expect(result!.modelSize, `modelSize mismatch for input: ${input}`).toBe(expectedModelSize);
    }
  });

  // ─── Edge cases ──────────────────────────────────────────────────────────

  it("returns null for RT-DETR model names", () => {
    expect(parseYoloPresetFromModelType("rtdetr-l.pt")).toBeNull();
    expect(parseYoloPresetFromModelType("rtdetrv2-s.pt")).toBeNull();
  });

  it("returns null for null/undefined/empty input", () => {
    expect(parseYoloPresetFromModelType(null)).toBeNull();
    expect(parseYoloPresetFromModelType(undefined)).toBeNull();
    expect(parseYoloPresetFromModelType("")).toBeNull();
  });

  it("parses yolo_nas_s.pt correctly", () => {
    const result = parseYoloPresetFromModelType("yolo_nas_s.pt");
    expect(result).not.toBeNull();
    expect(result!.version).toBe("yolo_nas");
    expect(result!.size).toBe("s");
    expect(result!.modelSize).toBe("yolo_nas_s.pt");
  });

  it("normalizes legacy yolo_nass.pt into yolo_nas_s.pt", () => {
    const result = parseYoloPresetFromModelType("yolo_nass.pt");
    expect(result).not.toBeNull();
    expect(result!.version).toBe("yolo_nas");
    expect(result!.size).toBe("s");
    expect(result!.modelSize).toBe("yolo_nas_s.pt");
  });

  it("parses yolo26n.pt correctly", () => {
    const result = parseYoloPresetFromModelType("yolo26n.pt");
    expect(result).not.toBeNull();
    expect(result!.version).toBe("yolo26");
    expect(result!.size).toBe("n");
  });
});
