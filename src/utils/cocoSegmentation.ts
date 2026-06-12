/**
 * Normalize COCO segmentation to flat pixel coords [x1, y1, x2, y2, ...].
 * Handles flat polygons, standard COCO [[x1,y1,...]], and YOLO point pairs [[x,y],...].
 */
export function cocoSegmentationToFlatCoords(raw: unknown): number[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    return [];
  }

  let work: unknown[] = raw;
  while (
    Array.isArray(work) &&
    work.length === 1 &&
    Array.isArray(work[0]) &&
    work[0].length > 0 &&
    Array.isArray(work[0][0]) &&
    (work[0][0] as unknown[]).length >= 2 &&
    typeof (work[0][0] as unknown[])[0] === "number"
  ) {
    work = work[0] as unknown[];
  }

  if (typeof work[0] === "number") {
    return work as number[];
  }

  if (!Array.isArray(work[0])) {
    return [];
  }

  const first = work[0] as unknown[];
  if (first.length >= 6 && typeof first[0] === "number") {
    return first as number[];
  }

  const flat: number[] = [];
  for (const pt of work) {
    if (Array.isArray(pt) && pt.length >= 2 && typeof pt[0] === "number" && typeof pt[1] === "number") {
      flat.push(pt[0], pt[1]);
    }
  }
  return flat;
}
