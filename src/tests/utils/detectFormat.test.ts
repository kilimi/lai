import { describe, it, expect } from "vitest";
import { detectFormat } from "@/utils/detectFormat";

describe("detectFormat", () => {
  it("detects COCO format from filename containing 'coco'", () => {
    expect(detectFormat("coco_annotations.json")).toBe("COCO");
    expect(detectFormat("dataset_coco.json")).toBe("COCO");
    expect(detectFormat("COCO_train.json")).toBe("COCO");
  });

  it("detects COCO format from .json extension", () => {
    expect(detectFormat("annotations.json")).toBe("COCO");
    expect(detectFormat("dataset.JSON")).toBe("COCO");
  });

  it("detects YOLO format from filename containing 'yolo'", () => {
    expect(detectFormat("yolo_labels.txt")).toBe("YOLO");
    expect(detectFormat("dataset_yolo.txt")).toBe("YOLO");
    expect(detectFormat("YOLO_train.txt")).toBe("YOLO");
  });

  it("detects YOLO format from .txt extension", () => {
    expect(detectFormat("labels.txt")).toBe("YOLO");
    expect(detectFormat("annotations.TXT")).toBe("YOLO");
  });

  it("detects Masks format from filename containing 'mask'", () => {
    expect(detectFormat("masks_dataset.png")).toBe("Masks");
    expect(detectFormat("segmentation_masks.json")).toBe("Masks");
    expect(detectFormat("MASK_annotations.txt")).toBe("Masks");
  });

  it("detects Masks format from filename containing 'seg'", () => {
    expect(detectFormat("seg_labels.json")).toBe("Masks");
    expect(detectFormat("segmentation.txt")).toBe("Masks");
  });

  it("detects VOC format from filename containing 'voc'", () => {
    expect(detectFormat("voc_annotations.xml")).toBe("VOC");
    expect(detectFormat("dataset_voc.xml")).toBe("VOC");
    expect(detectFormat("VOC_train.xml")).toBe("VOC");
  });

  it("detects VOC format from .xml extension", () => {
    expect(detectFormat("annotations.xml")).toBe("VOC");
    expect(detectFormat("labels.XML")).toBe("VOC");
  });

  it("returns 'Other' for unknown formats", () => {
    expect(detectFormat("unknown.csv")).toBe("Other");
    expect(detectFormat("dataset.pdf")).toBe("Other");
    expect(detectFormat("random_file")).toBe("Other");
  });

  it("returns 'Other' for empty string", () => {
    expect(detectFormat("")).toBe("Other");
  });

  it("handles case-insensitive matching", () => {
    expect(detectFormat("COCO_LABELS.JSON")).toBe("COCO");
    expect(detectFormat("yolo_TRAIN.TXT")).toBe("YOLO");
    expect(detectFormat("VOC_data.XML")).toBe("VOC");
  });

  it("prioritizes specific keywords over extensions", () => {
    // 'coco' keyword should match before .txt extension
    expect(detectFormat("coco_dataset.txt")).toBe("COCO");
    // 'yolo' keyword should match before .json extension  
    expect(detectFormat("yolo_labels.json")).toBe("YOLO");
  });
});
