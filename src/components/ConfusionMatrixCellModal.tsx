import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Grid3X3, ZoomIn } from "lucide-react";
import { getApiBaseUrl } from "@/config/api";

export interface CmSample {
  image_id?: number;
  file_name: string;
  pred_bbox?: [number, number, number, number] | null;
  gt_bbox?: [number, number, number, number] | null;
  pred_class_name?: string;
  gt_class_name?: string;
  conf?: number;
  iou?: number;
}

interface ConfusionMatrixCellModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  samples: CmSample[];
  rowClass: string;
  colClass: string;
  count: number;
  projectId: number;
  datasetId: number;
  taskId: number;
  imageIdToFilename?: Record<string, string>;
}

/**
 * Encode file path for URLs while preserving directory structure.
 * Validates input and handles edge cases.
 */
export function encodeFilePath(name: string | undefined | null): string {
  // Validate input - return empty string for invalid inputs
  if (name == null || typeof name !== 'string') {
    console.warn('encodeFilePath: invalid input', name);
    return '';
  }
  
  const normalized = name.trim();
  if (!normalized) {
    return '';
  }
  
  return normalized
    .replace(/\\/g, "/") // Convert Windows paths to forward slashes
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

/**
 * Build multiple fallback URLs for image loading.
 * Uses API config for base URL and handles both numeric and string image IDs.
 */
export function buildImageUrls(
  taskId: number,
  imageId: number | string | undefined,
  projectId: number,
  datasetId: number,
  fileName: string
): string[] {
  const encoded = encodeFilePath(fileName);
  if (!encoded) {
    console.warn('buildImageUrls: empty filename after encoding');
    return [];
  }
  
  const baseUrl = getApiBaseUrl().replace(/\/+$/, '');
  const urls: string[] = [];
  
  // Check if imageId is valid (can be number or string that represents a number)
  const imageIdNum = typeof imageId === 'string' ? parseInt(imageId, 10) : imageId;
  if (imageIdNum != null && Number.isFinite(imageIdNum) && imageIdNum > 0) {
    urls.push(`${baseUrl}/predictions/evaluation-image/${taskId}/${imageIdNum}`);
  }
  
  urls.push(
    `${baseUrl}/static/projects/${projectId}/${datasetId}/images/${encoded}`,
    `${baseUrl}/static/data/images/${datasetId}/${encoded}`,
  );
  return urls;
}

// Drawing constants
const CANVAS_DRAW_CONSTANTS = {
  LINE_WIDTH_DIVISOR: 300,
  FONT_SIZE_DIVISOR: 45,
  MIN_LINE_WIDTH: 1.5,
  MIN_FONT_SIZE: 10,
  LABEL_PADDING: 6,
  LABEL_VERTICAL_PADDING: 4,
} as const;

/**
 * Draw annotation boxes on a canvas that is sized to exactly match the
 * *rendered* image dimensions. The canvas pixel size equals the displayed
 * size, and we scale coordinates from natural → displayed.
 */
export function drawAnnotations(
  canvas: HTMLCanvasElement | null,
  img: HTMLImageElement | null,
  sample: CmSample,
): boolean {
  // Validate inputs
  if (!canvas || !img || !sample) {
    return false;
  }
  
  const dw = img.clientWidth;
  const dh = img.clientHeight;
  const nw = img.naturalWidth;
  const nh = img.naturalHeight;
  
  // Validate dimensions - return false instead of leaving canvas in undefined state
  if (dw === 0 || dh === 0 || nw === 0 || nh === 0) {
    console.warn('drawAnnotations: zero dimensions', { dw, dh, nw, nh });
    return false;
  }

  const dpr = window.devicePixelRatio || 1;
  canvas.width = dw * dpr;
  canvas.height = dh * dpr;
  canvas.style.width = `${dw}px`;
  canvas.style.height = `${dh}px`;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    console.warn('drawAnnotations: failed to get 2d context');
    return false;
  }
  
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, dw, dh);

  const sx = dw / nw;
  const sy = dh / nh;

  const lineW = Math.max(
    CANVAS_DRAW_CONSTANTS.MIN_LINE_WIDTH,
    Math.round(dw / CANVAS_DRAW_CONSTANTS.LINE_WIDTH_DIVISOR)
  );
  const fontSize = Math.max(
    CANVAS_DRAW_CONSTANTS.MIN_FONT_SIZE,
    Math.round(dw / CANVAS_DRAW_CONSTANTS.FONT_SIZE_DIVISOR)
  );

  function drawBox(
    bbox: [number, number, number, number],
    color: string,
    label: string,
    labelAbove: boolean,
  ) {
    if (!ctx) return;
    const x1 = bbox[0] * sx;
    const y1 = bbox[1] * sy;
    const x2 = bbox[2] * sx;
    const y2 = bbox[3] * sy;

    ctx.strokeStyle = color;
    ctx.lineWidth = lineW;
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);

    if (label) {
      ctx.font = `bold ${fontSize}px sans-serif`;
      const tw = ctx.measureText(label).width + CANVAS_DRAW_CONSTANTS.LABEL_PADDING;
      const th = fontSize + CANVAS_DRAW_CONSTANTS.LABEL_VERTICAL_PADDING;
      const ly = labelAbove
        ? (y1 > th + 2 ? y1 - 2 : y1 + (y2 - y1) + th)
        : (y2 + th + 2 < dh ? y2 + th : y1 - 2);
      ctx.fillStyle = color;
      ctx.fillRect(x1, ly - th, tw, th);
      ctx.fillStyle = "#fff";
      ctx.fillText(label, x1 + 3, ly - 3);
    }
  }

  if (sample.gt_bbox)
    drawBox(sample.gt_bbox, "#22c55e", sample.gt_class_name || "GT", true);
  if (sample.pred_bbox) {
    const conf = sample.conf != null ? ` ${(sample.conf * 100).toFixed(0)}%` : "";
    drawBox(sample.pred_bbox, "#ef4444", (sample.pred_class_name || "Pred") + conf, false);
  }
  
  return true;
}

// ── Thumbnail card for grid view ────────────────────────────────────────────

function ImageCard({
  sample,
  imageUrls,
  onClick,
}: {
  sample: CmSample;
  imageUrls: string[];
  onClick: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [srcIndex, setSrcIndex] = useState(0);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [allUrlsFailed, setAllUrlsFailed] = useState(false);
  const activeSrc = imageUrls[Math.min(srcIndex, Math.max(0, imageUrls.length - 1))] || "";

  useEffect(() => {
    setSrcIndex(0);
    setImageLoaded(false);
    setAllUrlsFailed(false);
  }, [imageUrls, sample.file_name]);

  const redraw = useCallback(() => {
    if (canvasRef.current && imgRef.current)
      drawAnnotations(canvasRef.current, imgRef.current, sample);
  }, [sample]);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => e.key === "Enter" && onClick()}
      className="group rounded-lg overflow-hidden border border-gray-700 bg-gray-900 cursor-pointer
                 hover:border-gray-400 hover:ring-1 hover:ring-gray-400 transition-all"
    >
      <div className="relative">
        <img
          ref={imgRef}
          src={activeSrc}
          alt={sample.file_name}
          className="w-full block"
          style={{ opacity: allUrlsFailed ? 0.3 : 1 }}
          onLoad={() => {
            setImageLoaded(true);
            redraw();
          }}
          onError={() => {
            setImageLoaded(false);
            const nextIndex = srcIndex + 1;
            if (nextIndex < imageUrls.length) {
              setSrcIndex(nextIndex);
            } else {
              // All URLs have failed
              setAllUrlsFailed(true);
            }
          }}
        />
        <canvas
          ref={canvasRef}
          className="absolute top-0 left-0"
          style={{ pointerEvents: "none", opacity: imageLoaded ? 1 : 0 }}
        />
        <div className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/30 transition-colors">
          <ZoomIn className="text-white opacity-0 group-hover:opacity-100 transition-opacity w-8 h-8 drop-shadow" />
        </div>
      </div>
      <div className="px-2 py-1 text-xs text-gray-400 truncate">
        {sample.file_name}
        {sample.iou != null && sample.iou > 0 && (
          <span className="ml-2 text-gray-500">IoU {sample.iou.toFixed(2)}</span>
        )}
      </div>
    </div>
  );
}

// ── Detail view (replaces grid inside the same dialog) ─────────────────────

function DetailView({
  samples,
  index,
  imageUrls,
  onBack,
  onPrev,
  onNext,
}: {
  samples: CmSample[];
  index: number;
  imageUrls: string[];
  onBack: () => void;
  onPrev: () => void;
  onNext: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const sample = samples[index];
  const [srcIndex, setSrcIndex] = useState(0);
  const activeSrc = imageUrls[Math.min(srcIndex, Math.max(0, imageUrls.length - 1))] || "";

  useEffect(() => {
    setSrcIndex(0);
  }, [imageUrls, index]);

  const redraw = useCallback(() => {
    if (canvasRef.current && imgRef.current)
      drawAnnotations(canvasRef.current, imgRef.current, sample);
  }, [sample]);

  // Redraw on index change (cached images may not fire onLoad again)
  useEffect(() => {
    const img = imgRef.current;
    if (img && img.complete && img.naturalWidth > 0) redraw();
  }, [index, redraw]);

  // Keyboard navigation - check if we're actually focused on the modal
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Ignore if typing in an input field
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }
      
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onBack();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        onPrev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        onNext();
      }
    }
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [onBack, onPrev, onNext]);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-800 flex-shrink-0">
        <button
          type="button"
          aria-label="Back to grid"
          onClick={onBack}
          className="flex items-center gap-1.5 text-sm text-gray-300 hover:text-white transition-colors"
        >
          <Grid3X3 className="w-4 h-4" />
          Back to grid
        </button>
        <span className="text-sm text-gray-400 truncate max-w-[50%] text-center">
          {sample.file_name}
          {sample.conf != null && sample.conf > 0 && (
            <span className="ml-2 text-gray-600">conf {(sample.conf * 100).toFixed(0)}%</span>
          )}
          {sample.iou != null && sample.iou > 0 && (
            <span className="ml-2 text-gray-600">IoU {sample.iou.toFixed(2)}</span>
          )}
        </span>
        <span className="text-sm text-gray-500 tabular-nums">
          {index + 1} / {samples.length}
        </span>
      </div>

      {/* Image area with arrows */}
      <div className="flex items-center gap-2 flex-1 min-h-0 px-2 py-3">
        {/* Prev */}
        <button
          type="button"
          aria-label="Previous image"
          onClick={onPrev}
          disabled={samples.length <= 1}
          className="flex-shrink-0 p-2 rounded-full bg-gray-800 hover:bg-gray-700
                     text-gray-300 hover:text-white transition-colors disabled:opacity-20"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>

        {/* Image + canvas wrapper — inline-block so it shrinks to image size */}
        <div className="flex-1 min-w-0 flex items-center justify-center min-h-0">
          <div className="relative inline-block max-w-full max-h-full">
            <img
              ref={imgRef}
              key={activeSrc}
              src={activeSrc}
              alt={sample.file_name}
              className="block max-w-full max-h-[60vh] object-contain rounded"
              onLoad={redraw}
              onError={() => {
                setSrcIndex((prev) => (prev + 1 < imageUrls.length ? prev + 1 : prev));
              }}
            />
            <canvas
              ref={canvasRef}
              className="absolute top-0 left-0"
              style={{ pointerEvents: "none" }}
            />
          </div>
        </div>

        {/* Next */}
        <button
          type="button"
          aria-label="Next image"
          onClick={onNext}
          disabled={samples.length <= 1}
          className="flex-shrink-0 p-2 rounded-full bg-gray-800 hover:bg-gray-700
                     text-gray-300 hover:text-white transition-colors disabled:opacity-20"
        >
          <ChevronRight className="w-5 h-5" />
        </button>
      </div>

      {/* Legend */}
      <div className="flex items-center justify-center gap-5 pb-3 text-xs text-gray-500 flex-shrink-0">
        {sample.gt_bbox && (
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded-sm bg-green-500" />
            GT: {sample.gt_class_name}
          </span>
        )}
        {sample.pred_bbox && (
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded-sm bg-red-500" />
            Pred: {sample.pred_class_name}
          </span>
        )}
        <span className="text-gray-600">← → navigate · Esc back to grid</span>
      </div>
    </div>
  );
}

// ── Main modal ──────────────────────────────────────────────────────────────

export function ConfusionMatrixCellModal({
  open,
  onOpenChange,
  samples,
  rowClass,
  colClass,
  count,
  projectId,
  datasetId,
  taskId,
  imageIdToFilename = {},
}: ConfusionMatrixCellModalProps) {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

  const isTP = rowClass === colClass;
  const isFP = rowClass === "background";
  const isFN = colClass === "background";

  let title: string;
  let description: string;
  let headerBg: string;
  let borderColor: string;

  if (isTP) {
    title = `True Positives — ${rowClass}`;
    description = `Correctly detected. Showing ${samples.length} of ${count}.`;
    headerBg = "bg-green-950/60";
    borderColor = "border-green-700";
  } else if (isFP) {
    title = `False Positives — predicted "${colClass}"`;
    description = `Model predicted "${colClass}" but no matching GT. Showing ${samples.length} of ${count}.`;
    headerBg = "bg-orange-950/60";
    borderColor = "border-orange-700";
  } else if (isFN) {
    title = `False Negatives — missed "${rowClass}"`;
    description = `GT "${rowClass}" exists but model missed it. Showing ${samples.length} of ${count}.`;
    headerBg = "bg-yellow-950/60";
    borderColor = "border-yellow-700";
  } else {
    title = `Confusion — "${rowClass}" predicted as "${colClass}"`;
    description = `Actual: "${rowClass}", predicted: "${colClass}". Showing ${samples.length} of ${count}.`;
    headerBg = "bg-red-950/60";
    borderColor = "border-red-700";
  }

  const filenameToImageId = useMemo(() => {
    const m = new Map<string, number>();
    for (const [idStr, name] of Object.entries(imageIdToFilename)) {
      const idNum = Number(idStr);
      if (Number.isFinite(idNum) && typeof name === "string" && name.length > 0) {
        m.set(name, idNum);
      }
    }
    return m;
  }, [imageIdToFilename]);

  function imageUrlsForSample(s: CmSample) {
    const imageId = ((s as any).image_id as number | undefined) ?? filenameToImageId.get(s.file_name);
    return buildImageUrls(taskId, imageId, projectId, datasetId, s.file_name);
  }

  const goBack = useCallback(() => setSelectedIndex(null), []);
  const goPrev = useCallback(
    () => setSelectedIndex((i) => (i != null ? (i - 1 + samples.length) % samples.length : null)),
    [samples.length],
  );
  const goNext = useCallback(
    () => setSelectedIndex((i) => (i != null ? (i + 1) % samples.length : null)),
    [samples.length],
  );

  // Reset to grid when dialog closes
  useEffect(() => {
    if (!open) setSelectedIndex(null);
  }, [open]);

  const showDetail = selectedIndex != null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={`max-w-5xl flex flex-col bg-gray-950 border ${borderColor} p-0 gap-0`}
        style={{ maxHeight: "88vh" }}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>

        {/* Header — always visible */}
        <div className={`${headerBg} border-b ${borderColor} px-5 pt-5 pb-3 rounded-t-lg flex-shrink-0`}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-bold text-white" data-testid="cm-modal-visible-heading">
                {title}
              </h2>
              <p className="text-xs text-gray-400 mt-0.5">{description}</p>
            </div>
          </div>
          {!showDetail && (
            <div className="flex gap-5 mt-2 text-xs text-gray-500">
              <span className="flex items-center gap-1">
                <span className="inline-block w-3 h-3 rounded-sm bg-green-500" /> GT box
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-3 h-3 rounded-sm bg-red-500" /> Prediction
              </span>
              <span className="text-gray-600">Click an image to enlarge</span>
            </div>
          )}
        </div>

        {/* Body — switches between grid and detail */}
        {samples.length === 0 ? (
          <div className="flex-1 flex items-center justify-center py-16 text-gray-500">
            No samples available
          </div>
        ) : showDetail ? (
          <DetailView
            samples={samples}
            index={selectedIndex}
            imageUrls={imageUrlsForSample(samples[selectedIndex])}
            onBack={goBack}
            onPrev={goPrev}
            onNext={goNext}
          />
        ) : (
          <div className="flex-1 overflow-y-auto p-4">
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {samples.map((sample, i) => (
                <div key={i}>
                  <ImageCard
                    sample={sample}
                    imageUrls={imageUrlsForSample(sample)}
                    onClick={() => setSelectedIndex(i)}
                  />
                </div>
              ))}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
