/**
 * CoverageMatrix
 *
 * Displays coverage of annotation files across image collections.
 * Rows = image collections (e.g. RGB, NIR, Thermal).
 * Cols = annotation files.
 * Cell value = how many images in that collection appear in the annotation file.
 *
 * No percentages, no progress bars — only honest counts. Datasets have a 1:N
 * relationship with annotation files and N:M with collections, so a single
 * "completion %" would lie. The matrix shows the full truth.
 */
import * as React from "react";
import { cn } from "@/lib/utils";
import { Files, Layers, ImageIcon, ChevronRight } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { AnnotationFile } from "@/utils/annotations";
import type { ImageCollection, Image } from "@/types";

interface CoverageMatrixProps {
  annotationFiles: AnnotationFile[];
  imageCollections: ImageCollection[];
  /** Fallback image list when no collections are defined. */
  images?: Image[];
  className?: string;
}

interface Cell {
  count: number;
  total: number;
}

function buildIndex(file: AnnotationFile): Set<string> {
  const ids = new Set<string>();

  // Image mapping: { imageId -> fileName }
  if (file.imageMapping) {
    Object.values(file.imageMapping).forEach((name) => name && ids.add(String(name)));
  }
  // Image details: { imageId -> { fileName } }
  if (file.imageDetails) {
    Object.values(file.imageDetails).forEach((d) => d?.fileName && ids.add(String(d.fileName)));
  }
  // COCO images
  if (file.cocoImages) {
    file.cocoImages.forEach((img) => img.file_name && ids.add(String(img.file_name)));
  }
  // Samples (last resort, by imageId)
  if (file.samples) {
    file.samples.forEach((s) => s.imageId && ids.add(String(s.imageId)));
  }
  return ids;
}

function imageKey(img: Image): string[] {
  // Match against either filename or id — annotation files reference both forms.
  const keys: string[] = [];
  if (img.fileName) keys.push(img.fileName);
  if (img.id) keys.push(String(img.id));
  return keys;
}

function intensityClass(count: number, total: number): string {
  if (total === 0 || count === 0) return "bg-muted/30 text-muted-foreground";
  const ratio = count / total;
  if (ratio >= 0.9) return "bg-primary/30 text-foreground";
  if (ratio >= 0.5) return "bg-primary/20 text-foreground";
  if (ratio >= 0.1) return "bg-primary/10 text-foreground";
  return "bg-primary/5 text-foreground";
}

export function CoverageMatrix({
  annotationFiles,
  imageCollections,
  images = [],
  className,
}: CoverageMatrixProps) {
  // Build row list: collections, or a synthetic single row from `images`.
  const rows = React.useMemo(() => {
    if (imageCollections && imageCollections.length > 0) {
      return imageCollections.map((c) => ({
        id: String(c.id),
        name: c.name,
        images: c.images || [],
      }));
    }
    if (images.length > 0) {
      return [{ id: "all", name: "All images", images }];
    }
    return [];
  }, [imageCollections, images]);

  // Per-file index of known image identifiers.
  const fileIndex = React.useMemo(
    () => annotationFiles.map((f) => ({ file: f, ids: buildIndex(f) })),
    [annotationFiles]
  );

  // Build matrix: rows × files.
  const matrix: Cell[][] = React.useMemo(() => {
    return rows.map((row) =>
      fileIndex.map(({ ids }) => {
        let count = 0;
        for (const img of row.images) {
          const keys = imageKey(img);
          if (keys.some((k) => ids.has(k))) count++;
        }
        return { count, total: row.images.length };
      })
    );
  }, [rows, fileIndex]);

  if (rows.length === 0 || annotationFiles.length === 0) {
    return (
      <div
        className={cn(
          "rounded-lg border border-dashed border-border bg-muted/20 p-6 text-center text-sm text-muted-foreground",
          className
        )}
      >
        Coverage matrix appears once you have at least one image collection and one annotation file.
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div
        className={cn(
          "rounded-lg border border-border bg-card overflow-hidden",
          className
        )}
      >
        <div className="px-4 py-2.5 border-b border-border bg-muted/30 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Layers className="h-4 w-4 text-primary" />
            Coverage matrix
            <span className="text-xs text-muted-foreground font-normal">
              · {rows.length} collection{rows.length === 1 ? "" : "s"} × {annotationFiles.length} file
              {annotationFiles.length === 1 ? "" : "s"}
            </span>
          </div>
          <span className="text-[11px] text-muted-foreground">
            cell = annotated images / total in collection
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left px-3 py-2 font-medium text-muted-foreground sticky left-0 bg-card z-10 min-w-[180px]">
                  <span className="inline-flex items-center gap-1.5">
                    <ImageIcon className="h-3.5 w-3.5" /> Collection
                  </span>
                </th>
                {annotationFiles.map((f) => (
                  <th
                    key={f.id}
                    className="text-left px-3 py-2 font-medium text-muted-foreground whitespace-nowrap"
                    title={f.name}
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <Files className="h-3.5 w-3.5" />
                      <span className="max-w-[140px] truncate">{f.name}</span>
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rIdx) => (
                <tr key={row.id} className="border-b border-border/50 last:border-0">
                  <td className="px-3 py-2 sticky left-0 bg-card z-10">
                    <div className="font-medium truncate max-w-[180px]" title={row.name}>
                      {row.name}
                    </div>
                    <div className="text-[11px] text-muted-foreground tabular-nums">
                      {row.images.length.toLocaleString()} image
                      {row.images.length === 1 ? "" : "s"}
                    </div>
                  </td>
                  {matrix[rIdx].map((cell, cIdx) => {
                    const file = annotationFiles[cIdx];
                    const empty = cell.count === 0;
                    return (
                      <td key={file.id} className="px-2 py-2">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div
                              className={cn(
                                "rounded-md px-2.5 py-1.5 text-center tabular-nums font-medium border border-transparent transition-colors",
                                intensityClass(cell.count, cell.total),
                                empty && "italic"
                              )}
                            >
                              {empty ? "—" : cell.count.toLocaleString()}
                            </div>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="text-xs">
                            <div className="font-medium">{file.name}</div>
                            <div className="text-muted-foreground">
                              {row.name}: {cell.count.toLocaleString()} of{" "}
                              {cell.total.toLocaleString()} images covered
                            </div>
                          </TooltipContent>
                        </Tooltip>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-2 border-t border-border bg-muted/20 text-[11px] text-muted-foreground flex items-center gap-1.5">
          <ChevronRight className="h-3 w-3" />
          Empty cells (—) mean the annotation file does not reference any image
          from that collection. This is expected when a file targets a single
          modality (e.g. RGB only).
        </div>
      </div>
    </TooltipProvider>
  );
}
