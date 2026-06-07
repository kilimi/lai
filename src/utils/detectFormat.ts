/**
 * Detect annotation format from filename
 * @param name - The filename to analyze
 * @returns Detected format: COCO, YOLO, Masks, VOC, or Other
 */
export function detectFormat(name: string): string {
  if (!name) return "Other";

  const n = name.toLowerCase();

  // Filename keywords take precedence over generic extension guesses.
  if (n.includes("coco")) return "COCO";
  if (n.includes("yolo")) return "YOLO";
  if (n.includes("mask") || n.includes("seg")) return "Masks";
  if (n.includes("voc")) return "VOC";

  if (n.endsWith(".json")) return "COCO";
  if (n.endsWith(".txt")) return "YOLO";
  if (n.endsWith(".xml")) return "VOC";

  return "Other";
}
