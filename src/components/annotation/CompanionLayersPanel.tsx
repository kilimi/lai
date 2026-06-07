/**
 * CompanionLayersPanel
 *
 * Side-by-side companion view for the annotation page.
 *
 * Concept (simplified — no calibration):
 *  - User annotates ONCE on the main canvas (the "primary" collection).
 *  - This panel shows the SAME logical image (matched by filename / groupId)
 *    from one or more OTHER collections in a small per-layer window.
 *  - Annotations are drawn directly in image-pixel space (identity mapping).
 *
 * Copy rule:
 *  - A layer can mirror the primary's annotations ("Copy annotations" ON) ONLY
 *    when its image has the SAME resolution as the primary image. In that case
 *    drawing on the primary is shown live on that layer and saves are mirrored.
 *  - If the resolution differs, copying is NOT allowed: the Copy toggle is
 *    disabled and a warning is shown. Such a layer only displays its own
 *    previously-saved annotations.
 */
import * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Layers,
  AlertTriangle,
  Eye,
  EyeOff,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  X,
  Copy,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { cn } from "@/lib/utils";
import { Image, ImageCollection } from "@/types";
import type { AnnotationShape } from "@/pages/image-annotation/types";
import { pointsToTightBbox } from "@/utils/annotations";
import {
  COMPANION_DUPLICATE_STORAGE_KEY,
  readCompanionDuplicateIds,
  readCopyOffCollectionIds,
  writeCompanionDuplicateIds,
  setCollectionCopyEnabled,
  isCollectionCopyEnabled,
} from "@/components/annotation/companionDuplicatePrefs";

// ---------------------------------------------------------------------------
// Helpers — mirror the matching logic used in ImageAnnotation.tsx.
// ---------------------------------------------------------------------------

function baseNameNoExt(fileName: string): string {
  if (!fileName.includes(".")) return fileName.toLowerCase();
  return fileName.slice(0, fileName.lastIndexOf(".")).toLowerCase();
}

function findCorrespondingImage(
  collection: ImageCollection,
  imageName: string,
  reference: Image | null,
): Image | null {
  const exact = collection.images.find((img) => img.fileName === imageName);
  if (exact) return exact;
  const target = baseNameNoExt(imageName);
  const byBase = collection.images.find(
    (img) => baseNameNoExt(img.fileName ?? "") === target,
  );
  if (byBase) return byBase;
  if (reference?.groupId) {
    const gid = reference.groupId;
    const byGroup = collection.images.find(
      (img) => img.groupId && img.groupId === gid,
    );
    if (byGroup) return byGroup;
  }
  return null;
}

/** True when both images have known, positive, identical pixel dimensions. */
function sameResolution(a: Image | null, b: Image | null): boolean {
  if (!a || !b) return false;
  if (!a.width || !a.height || !b.width || !b.height) return false;
  return a.width === b.width && a.height === b.height;
}

// ---------------------------------------------------------------------------
// Single companion canvas — renders one image + annotation overlay
// ---------------------------------------------------------------------------

interface CompanionCanvasProps {
  collection: ImageCollection;
  primaryImage: Image | null;
  imageName: string;
  annotations: AnnotationShape[];
  /** Primary image's natural dimensions, used to detect resolution mismatch. */
  primaryDims: { width: number; height: number } | null;
  /**
   * COCO image dimensions for the current image in the primary collection.
   * When annotation points were loaded from an API annotation file they are in
   * COCO pixel-space (imageWidth × imageHeight). We scale them to primary
   * natural-pixel-space before drawing. If null / equal to primary natural
   * dims, no scaling is needed.
   */
  primaryCocoDims: { width: number; height: number } | null;
  /** Whether this layer mirrors live primary annotations (Copy ON + same res). */
  isCopying: boolean;
}

function CompanionCanvas({
  collection,
  primaryImage,
  imageName,
  annotations,
  primaryDims,
  primaryCocoDims,
  isCopying,
}: CompanionCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [imgDims, setImgDims] = useState<{ width: number; height: number } | null>(
    null,
  );
  const [imgLoadError, setImgLoadError] = useState(false);

  const corresponding = useMemo(
    () => findCorrespondingImage(collection, imageName, primaryImage),
    [collection, imageName, primaryImage],
  );

  // Reset on image change
  useEffect(() => {
    setImgDims(null);
    setImgLoadError(false);
  }, [corresponding?.url]);

  // Draw annotations in image-pixel space (identity mapping).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !imgDims) return;
    canvas.width = imgDims.width;
    canvas.height = imgDims.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Coords are stored in the primary bitmap's natural pixel space (same as the
    // main canvas). Do not remap via DB metadata dimensions — that often disagrees
    // with decoded naturalWidth/Height and pushes boxes off-canvas on companion layers.
    annotations.forEach((ann) => {
      if (!ann.visible) return;
      ctx.strokeStyle = ann.color || "#22d3ee";
      ctx.fillStyle = (ann.color || "#22d3ee") + "33";
      ctx.lineWidth = Math.max(1.5, imgDims.width / 600);

      if (ann.type === "rectangle" && ann.points.length >= 2) {
        const [x, y, w, h] = pointsToTightBbox(ann.points);
        ctx.beginPath();
        ctx.rect(x, y, w, h);
        ctx.fill();
        ctx.stroke();
      } else if (ann.type === "circle" && ann.points.length >= 2) {
        const [c, edge] = ann.points;
        const r = Math.hypot(edge.x - c.x, edge.y - c.y);
        ctx.beginPath();
        ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      } else if (ann.type === "polygon" && ann.points.length >= 3) {
        const pts = ann.points;
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    });
  }, [annotations, imgDims]);

  const dimsMismatch =
    !!imgDims &&
    !!primaryDims &&
    (imgDims.width !== primaryDims.width || imgDims.height !== primaryDims.height);

  // Empty / missing-image states
  if (!corresponding) {
    return (
      <div className="h-full flex flex-col">
        <CompanionHeader name={collection.name} />
        <div className="flex-1 flex items-center justify-center text-center text-sm text-muted-foreground p-4">
          <div>
            <div className="text-2xl mb-2">📷</div>
            <div className="font-medium">No matching image</div>
            <div className="text-xs mt-1">
              "{imageName}" is not present in {collection.name}.
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-muted/20">
      <CompanionHeader name={collection.name} count={collection.images.length} isCopying={isCopying} />

      {/* Resolution-mismatch warning — copying is not possible at different resolutions. */}
      {dimsMismatch && (
        <div className="m-2 p-2 rounded-md border border-yellow-500/40 bg-yellow-500/10 text-xs flex items-start gap-2">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 text-yellow-600 dark:text-yellow-400 shrink-0" />
          <div className="space-y-1">
            <div className="font-medium text-foreground">
              Different resolution — copy disabled
            </div>
            <div className="text-muted-foreground">
              Main image is {primaryDims!.width}×{primaryDims!.height}; this layer is{" "}
              {imgDims!.width}×{imgDims!.height}. Annotations can only be copied between
              layers of the same resolution.
            </div>
          </div>
        </div>
      )}

      <div className="flex-1 relative overflow-hidden">
        {imgLoadError ? (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
            Failed to load {corresponding.fileName}
          </div>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center p-2">
            <div className="relative max-w-full max-h-full">
              <img
                ref={imgRef}
                src={corresponding.url}
                alt={corresponding.fileName || "companion"}
                crossOrigin="anonymous"
                className="block max-w-full max-h-full object-contain"
                onLoad={(e) => {
                  const el = e.currentTarget;
                  setImgDims({
                    width: el.naturalWidth,
                    height: el.naturalHeight,
                  });
                }}
                onError={() => setImgLoadError(true)}
              />
              <canvas
                ref={canvasRef}
                className="absolute inset-0 w-full h-full pointer-events-none"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function CompanionHeader({
  name,
  count,
  isCopying,
}: {
  name: string;
  count?: number;
  isCopying?: boolean;
}) {
  return (
    <div className="px-3 py-2 border-b bg-card/60 flex items-center justify-between gap-2">
      <div className="flex items-center gap-2 min-w-0">
        <div className="w-2 h-2 rounded-full bg-primary shrink-0" />
        <span className="text-sm font-semibold truncate">{name}</span>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {isCopying && (
          <span
            className="inline-flex items-center gap-1 text-[10px] font-medium rounded-md px-2 py-0.5 whitespace-nowrap border text-primary bg-primary/10 border-primary/30"
            title="Annotations from the main image are copied onto this layer"
          >
            <Copy className="h-3 w-3" />
            Copying
          </span>
        )}
        {typeof count === "number" && (
          <span className="text-[10px] text-muted-foreground">
            {count} {count === 1 ? "image" : "images"}
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public panel — toolbar + resizable companion canvases
// ---------------------------------------------------------------------------

interface CompanionLayersPanelProps {
  /** All collections in the dataset. */
  collections: ImageCollection[];
  /** The collection the user is annotating in. */
  primaryCollectionId: string;
  /** The image currently open in the main editor. */
  primaryImage: Image | null;
  /** Logical image name driving navigation (e.g. "0001.jpg"). */
  imageName: string;
  /**
   * Dataset id used to scope the per-collection annotation storage keys
   * (`annotations_${datasetId}_${collectionId}_${imageName}`).
   */
  datasetId?: string | number | null;
  /** Shared annotations from the main editor. */
  annotations: AnnotationShape[];
  /**
   * COCO image dimensions for the currently-shown image in the primary
   * collection. Used to scale stored coords to natural-pixel-space.
   */
  primaryCocoDims?: { width: number; height: number } | null;
  /** Called when the user clicks the X to close the entire companion panel. */
  onClose?: () => void;
  /** Navigate the main image. */
  onPrev?: () => void;
  onNext?: () => void;
  canPrev?: boolean;
  canNext?: boolean;
  /**
   * Notifies the parent which collections should receive a copy of every
   * annotation save. Only same-resolution layers are eligible.
   */
  onDuplicateChange?: (collectionIds: string[]) => void;
}

const STORAGE_KEY = "annotation-companion-selected-v1";

export function CompanionLayersPanel({
  collections,
  primaryCollectionId,
  primaryImage,
  imageName,
  datasetId,
  annotations,
  primaryCocoDims,
  onClose,
  onPrev,
  onNext,
  canPrev,
  canNext,
  onDuplicateChange,
}: CompanionLayersPanelProps) {
  const available = useMemo(() => collections, [collections]);

  // Persist selection across navigations within a session
  const [selectedIds, setSelectedIds] = useState<string[]>(() => {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch {}
    return [];
  });

  /**
   * Collections that should receive a mirrored copy of every saved annotation.
   * Default: copy ON for every same-resolution non-primary layer until the user
   * toggles copy off (persisted in sessionStorage).
   */
  const [duplicateIds, setDuplicateIds] = useState<string[]>([]);
  const duplicateDefaultsAppliedRef = useRef(false);
  /** After first hydrate, never re-read sessionStorage (would undo user toggles). */
  const duplicateHydratedRef = useRef(false);

  const datasetIdStr =
    datasetId === null || datasetId === undefined ? "" : String(datasetId);

  const clearCompanionLayerStorage = useCallback(
    (collectionId: string, forImageName: string) => {
      if (!datasetIdStr || !forImageName) return;
      try {
        localStorage.removeItem(
          `annotations_${datasetIdStr}_${collectionId}_${forImageName}`,
        );
        localStorage.removeItem(
          `annotations_${datasetIdStr}_${collectionId}_${forImageName}_dims`,
        );
      } catch {}
    },
    [datasetIdStr],
  );

  const notifyDuplicateIds = useCallback(
    (ids: string[]) => {
      const written = writeCompanionDuplicateIds(ids);
      onDuplicateChange?.(written);
      return written;
    },
    [onDuplicateChange],
  );

  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(selectedIds));
    } catch {}
  }, [selectedIds]);

  // Keep session in sync when duplicateIds changes from React state (e.g. prune effect).
  useEffect(() => {
    try {
      const existing = sessionStorage.getItem(COMPANION_DUPLICATE_STORAGE_KEY);
      if (existing === null && duplicateIds.length === 0) return;
      const serialized = JSON.stringify(duplicateIds);
      if (existing === serialized) return;
      writeCompanionDuplicateIds(duplicateIds);
    } catch {}
    onDuplicateChange?.(readCompanionDuplicateIds());
  }, [duplicateIds, onDuplicateChange]);

  /** True when this collection's matching image has the same resolution as primary. */
  const isSameResolution = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const c of available) {
      const cid = String(c.id);
      if (cid === String(primaryCollectionId)) {
        map.set(cid, true);
        continue;
      }
      const img = findCorrespondingImage(c, imageName, primaryImage);
      map.set(cid, sameResolution(primaryImage, img));
    }
    return map;
  }, [available, primaryCollectionId, primaryImage, imageName]);

  const sameResolutionEligibleIds = useMemo(() => {
    const primaryStr = String(primaryCollectionId);
    return available
      .map((c) => String(c.id))
      .filter(
        (id) => id !== primaryStr && isSameResolution.get(id) === true,
      );
  }, [available, primaryCollectionId, isSameResolution]);

  // Drop invalid selections; hydrate duplicate prefs once, then only prune ineligible.
  useEffect(() => {
    setSelectedIds((prev) =>
      prev.filter((id) => available.some((c) => String(c.id) === id)),
    );

    if (!duplicateHydratedRef.current) {
      if (sameResolutionEligibleIds.length === 0) return;

      duplicateHydratedRef.current = true;
      const hasStoredPref = (() => {
        try {
          return sessionStorage.getItem(COMPANION_DUPLICATE_STORAGE_KEY) !== null;
        } catch {
          return false;
        }
      })();

      if (hasStoredPref) {
        const filtered = readCompanionDuplicateIds().filter((cid) =>
          sameResolutionEligibleIds.includes(cid),
        );
        setDuplicateIds(filtered);
        notifyDuplicateIds(filtered);
      } else {
        duplicateDefaultsAppliedRef.current = true;
        const copyOff = readCopyOffCollectionIds();
        const defaults = sameResolutionEligibleIds.filter((cid) => !copyOff.has(cid));
        writeCompanionDuplicateIds(defaults);
        setDuplicateIds(defaults);
        notifyDuplicateIds(defaults);
      }
      return;
    }

    setDuplicateIds((prev) =>
      prev.filter((id) => sameResolutionEligibleIds.includes(id)),
    );
  }, [available, primaryCollectionId, sameResolutionEligibleIds, notifyDuplicateIds]);

  const selected = useMemo(
    () => available.filter((c) => selectedIds.includes(String(c.id))),
    [available, selectedIds],
  );

  /**
   * Per-companion annotation resolver.
   *  - PRIMARY collection → live `annotations`.
   *  - Copy ON + same resolution → live `annotations` (mirrored on save).
   *  - Otherwise → that collection's own previously-saved annotations.
   */
  const companionAnnotationsByCollection = useMemo(() => {
    const result: Record<string, AnnotationShape[]> = {};
    const primaryStr = String(primaryCollectionId);
    for (const c of selected) {
      const cid = String(c.id);
      const copying =
        cid !== String(primaryCollectionId)
        && isSameResolution.get(cid) === true
        && isCollectionCopyEnabled(cid);
      if (cid === primaryStr || copying) {
        result[cid] = annotations;
        continue;
      }
      if (!datasetIdStr || !imageName) {
        result[cid] = [];
        continue;
      }
      try {
        const raw = localStorage.getItem(
          `annotations_${datasetIdStr}_${cid}_${imageName}`,
        );
        result[cid] = raw ? (JSON.parse(raw) as AnnotationShape[]) : [];
      } catch {
        result[cid] = [];
      }
    }
    return result;
  }, [
    selected,
    primaryCollectionId,
    isSameResolution,
    annotations,
    datasetIdStr,
    imageName,
  ]);

  // Hide entirely when there's nothing to compare against
  if (available.length === 0) return null;

  const primaryDims =
    primaryCocoDims && primaryCocoDims.width > 0 && primaryCocoDims.height > 0
      ? primaryCocoDims
      : primaryImage && primaryImage.width && primaryImage.height
        ? { width: primaryImage.width, height: primaryImage.height }
        : null;

  const toggle = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const toggleDuplicate = (id: string) => {
    if (String(primaryCollectionId) === id) return;
    if (isSameResolution.get(id) !== true) return;
    const enabling = !isCollectionCopyEnabled(id);
    if (!enabling) {
      clearCompanionLayerStorage(id, imageName);
    }
    const next = setCollectionCopyEnabled(id, enabling);
    setDuplicateIds(next);
    onDuplicateChange?.(next);
  };

  return (
    <div className="h-full flex flex-col border-l bg-background min-w-[260px]">
      {/* Toolbar */}
      <div className="px-3 py-2 border-b flex items-center justify-between gap-2 bg-card/40">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Layers className="h-4 w-4 text-primary" />
          Image collections
        </div>
        <div className="flex items-center gap-1.5">
          {(onPrev || onNext) && (
            <div className="flex items-center gap-0.5 mr-1">
              <Button
                variant="outline"
                size="sm"
                className="h-8 w-8 p-0"
                onClick={onPrev}
                disabled={!onPrev || canPrev === false}
                title="Previous image"
                aria-label="Previous image"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 w-8 p-0"
                onClick={onNext}
                disabled={!onNext || canNext === false}
                title="Next image"
                aria-label="Next image"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 gap-1.5">
                {selected.length === 0
                  ? "Show layers"
                  : `${selected.length} shown`}
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
            </PopoverTrigger>
          <PopoverContent align="end" className="w-80 p-2">
            <div className="text-xs font-medium text-muted-foreground px-2 pb-1">
              Image collections
            </div>
            <div className="text-[10px] text-muted-foreground px-2 pb-2">
              Pick which collections to show alongside the primary canvas. Use the
              copy icon to also copy annotations onto a layer — only available for
              layers with the same resolution.
            </div>
            <div className="space-y-1 max-h-72 overflow-auto">
              {collections.map((c) => {
                const id = String(c.id);
                const isPrimary = String(primaryCollectionId) === id;
                const checked = selectedIds.includes(id);
                const isDuplicating = isCollectionCopyEnabled(id);
                const canCopy = isSameResolution.get(id) === true;
                return (
                  <div
                    key={id}
                    className={`flex items-center gap-2 px-2 py-1.5 rounded ${
                      isPrimary ? "bg-muted/40" : "hover:bg-accent"
                    }`}
                  >
                    <label className="flex items-center gap-2 cursor-pointer flex-1 min-w-0">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={() => toggle(id)}
                      />
                      <span className="text-sm flex-1 truncate">{c.name}</span>
                      {checked ? (
                        <Eye className="h-3.5 w-3.5 text-primary" />
                      ) : (
                        <EyeOff className="h-3.5 w-3.5 text-muted-foreground/50" />
                      )}
                    </label>
                    {isPrimary ? (
                      <span
                        className="inline-flex items-center justify-center h-6 px-1.5 rounded text-[10px] font-medium text-primary bg-primary/10 border border-primary/30"
                        title="You are annotating in this collection — saves always go here"
                      >
                        Active
                      </span>
                    ) : !canCopy ? (
                      <span
                        className="inline-flex items-center gap-1 h-6 px-1.5 rounded text-[10px] font-medium text-yellow-700 dark:text-yellow-400 bg-yellow-500/10 border border-yellow-500/30"
                        title="Different resolution from the main image — annotations cannot be copied"
                      >
                        <AlertTriangle className="h-3 w-3" />
                        Diff. size
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => toggleDuplicate(id)}
                        className={cn(
                          "inline-flex items-center justify-center h-6 w-6 rounded border transition-colors",
                          isDuplicating &&
                            "border-primary/40 bg-primary/10 text-primary hover:bg-primary/20",
                          !isDuplicating &&
                            "border-border text-muted-foreground/70 hover:bg-accent hover:text-foreground",
                        )}
                        title={
                          isDuplicating
                            ? "Copy ON — annotations are also saved onto this layer. Click to disable."
                            : "Copy OFF — click to also copy annotations onto this layer."
                        }
                        aria-label="Toggle annotation copy"
                      >
                        <Copy className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            {available.length > 0 && (
              <div className="border-t mt-2 pt-2 flex justify-between">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setSelectedIds([])}
                >
                  Hide all
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() =>
                    setSelectedIds(available.map((c) => String(c.id)))
                  }
                >
                  Show all
                </Button>
              </div>
            )}
          </PopoverContent>
          </Popover>
          {onClose && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0"
              onClick={onClose}
              title="Close companion panel"
              aria-label="Close companion panel"
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {/* Body */}
      {selected.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-center p-4 text-sm text-muted-foreground">
          <div>
            <Layers className="h-8 w-8 mx-auto mb-2 opacity-40" />
            <div className="font-medium">No image collections shown</div>
            <div className="text-xs mt-1">
              Pick collections above to view them side-by-side.
            </div>
          </div>
        </div>
      ) : (
        <ResizablePanelGroup
          direction={selected.length > 1 ? "vertical" : "horizontal"}
          className="flex-1"
        >
          {selected.map((c, i) => {
            const cid = String(c.id);
            const isCopying =
              cid !== String(primaryCollectionId)
              && isCollectionCopyEnabled(cid)
              && isSameResolution.get(cid) === true;
            return (
              <React.Fragment key={cid}>
                {i > 0 && <ResizableHandle withHandle />}
                <ResizablePanel defaultSize={100 / selected.length} minSize={15}>
                  <CompanionCanvas
                    collection={c}
                    primaryImage={primaryImage}
                    imageName={imageName}
                    annotations={companionAnnotationsByCollection[cid] ?? []}
                    primaryDims={primaryDims}
                    primaryCocoDims={primaryCocoDims ?? null}
                    isCopying={isCopying}
                  />
                </ResizablePanel>
              </React.Fragment>
            );
          })}
        </ResizablePanelGroup>
      )}
    </div>
  );
}
