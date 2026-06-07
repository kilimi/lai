import { describe, it, expect } from "vitest";
import { mergeAnnotationSamples } from "@/utils/mergeAnnotationSamples";
import type { AnnotationSample } from "@/utils/annotations";

function makeSample(id: string, imageId: string, className = "car"): AnnotationSample {
  return {
    id,
    imageId,
    className,
    bbox: [0.1, 0.2, 0.3, 0.4],
    segmentation: [[10, 10, 20, 20, 30, 30]],
    area: 100,
    confidence: 1,
    color: "#ff0000",
  };
}

describe("mergeAnnotationSamples", () => {
  it("keeps annotations from previous pages when next page annotations are loaded", () => {
    const page1 = [makeSample("ann-1", "img-1"), makeSample("ann-2", "img-2")];
    const page2 = [makeSample("ann-3", "img-3")];

    const merged = mergeAnnotationSamples(page1, page2);

    expect(merged).toHaveLength(3);
    expect(merged.map((s) => `${s.id}:${s.imageId}`)).toEqual(
      expect.arrayContaining(["ann-1:img-1", "ann-2:img-2", "ann-3:img-3"]),
    );
  });

  it("replaces duplicate annotation keys with latest loaded sample", () => {
    const original = [makeSample("ann-1", "img-1", "car")];
    const updated = [makeSample("ann-1", "img-1", "truck")];

    const merged = mergeAnnotationSamples(original, updated);

    expect(merged).toHaveLength(1);
    expect(merged[0].className).toBe("truck");
  });

  it("treats same annotation id on different images as distinct", () => {
    const page1 = [makeSample("ann-1", "img-1")];
    const page2 = [makeSample("ann-1", "img-2")];

    const merged = mergeAnnotationSamples(page1, page2);

    expect(merged).toHaveLength(2);
    expect(merged.map((s) => s.imageId).sort()).toEqual(["img-1", "img-2"]);
  });
});
