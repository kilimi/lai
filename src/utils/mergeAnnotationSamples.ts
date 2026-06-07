import { AnnotationSample } from "@/utils/annotations";

// Merge samples loaded from multiple pages while de-duplicating by annotation+image identity.
export function mergeAnnotationSamples(
  existing: AnnotationSample[] = [],
  incoming: AnnotationSample[] = [],
): AnnotationSample[] {
  const byKey = new Map<string, AnnotationSample>();

  existing.forEach((sample) => {
    byKey.set(`${sample.id}::${sample.imageId}`, sample);
  });

  incoming.forEach((sample) => {
    byKey.set(`${sample.id}::${sample.imageId}`, sample);
  });

  return Array.from(byKey.values());
}
