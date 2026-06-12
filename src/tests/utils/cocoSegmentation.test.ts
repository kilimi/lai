import { describe, expect, it } from "vitest";
import { cocoSegmentationToFlatCoords } from "@/utils/cocoSegmentation";

describe("cocoSegmentationToFlatCoords", () => {
  it("flattens YOLO point-pair polygons", () => {
    expect(
      cocoSegmentationToFlatCoords([
        [1908, 516],
        [1908, 534],
        [1890, 552],
      ]),
    ).toEqual([1908, 516, 1908, 534, 1890, 552]);
  });

  it("unwraps triple-nested exports", () => {
    expect(
      cocoSegmentationToFlatCoords([
        [
          [1908, 516],
          [1908, 534],
          [1890, 552],
        ],
      ]),
    ).toEqual([1908, 516, 1908, 534, 1890, 552]);
  });

  it("keeps standard COCO flat polygons", () => {
    expect(cocoSegmentationToFlatCoords([[10, 20, 30, 40, 50, 60]])).toEqual([
      10, 20, 30, 40, 50, 60,
    ]);
  });
});
