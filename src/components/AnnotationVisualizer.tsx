
import React, { useRef, useLayoutEffect, useState } from "react";
import { AnnotationSample } from "@/utils/annotations";
import { cn } from "@/lib/utils";

interface AnnotationVisualizerProps {
  annotations: (AnnotationSample & { annotationFileName?: string })[];
  imageWidth: number;
  imageHeight: number;
  /** When annotation coords are in a different space (e.g. full image), scale them to imageWidth x imageHeight for correct overlay alignment */
  referenceImageWidth?: number;
  referenceImageHeight?: number;
  className?: string;
  showFileName?: boolean;
  zoom?: number;
  pan?: { x: number; y: number };
  globalShowMasks?: boolean;
}

export const AnnotationVisualizer = ({
  annotations,
  imageWidth,
  imageHeight,
  referenceImageWidth,
  referenceImageHeight,
  className,
  showFileName = true,
  zoom = 1,
  pan = { x: 0, y: 0 },
  globalShowMasks = true,
}: AnnotationVisualizerProps) => {
  // Scale from reference coord space to display (imageWidth x imageHeight) when they differ
  const useRefScale =
    referenceImageWidth != null &&
    referenceImageHeight != null &&
    referenceImageWidth > 0 &&
    referenceImageHeight > 0 &&
    (referenceImageWidth !== imageWidth || referenceImageHeight !== imageHeight);
  const scaleFromRefX = useRefScale ? imageWidth / referenceImageWidth! : 1;
  const scaleFromRefY = useRefScale ? imageHeight / referenceImageHeight! : 1;
  const toDisplayX = (x: number) => x * scaleFromRefX;
  const toDisplayY = (y: number) => y * scaleFromRefY;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // A simple counter incremented by ResizeObserver so the drawing effect re-runs
  // on container size changes. We do NOT store dimensions in state to avoid the
  // timing race where the drawing effect fires with stale {0,0} dimensions.
  const [drawTick, setDrawTick] = useState(0);

  useLayoutEffect(() => {
    const obs = new ResizeObserver(() => setDrawTick((t) => t + 1));
    if (containerRef.current) obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  // Guarantee a redraw after the very next browser paint.
  // When the component mounts inside a dialog or after an image load callback,
  // getBoundingClientRect() can return 0 in the synchronous useLayoutEffect
  // because the browser hasn't completed layout for the new content yet.
  // The rAF fires after that first paint, by which time layout is always settled.
  useLayoutEffect(() => {
    const id = requestAnimationFrame(() => setDrawTick((t) => t + 1));
    return () => cancelAnimationFrame(id);
  }, []); // Only on mount

  const visibleAnnotations = annotations.filter(
    (a) => a.isVisible === undefined || a.isVisible,
  );

  // Draw annotations on canvas.
  // Container dimensions are measured fresh here — never from state — so there
  // is no render-cycle race between ResizeObserver firing and this effect.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Measure the container at effect time (always current, never stale).
    const rect = container.getBoundingClientRect();
    const containerW = rect.width;
    const containerH = rect.height;

    if (
      !containerW ||
      !containerH ||
      !imageWidth ||
      !imageHeight ||
      visibleAnnotations.length === 0
    ) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    // Set canvas buffer size with DPR support; this also clears the canvas.
    const dpr = window.devicePixelRatio || 1;
    canvas.width = containerW * dpr;
    canvas.height = containerH * dpr;
    canvas.style.width = `${containerW}px`;
    canvas.style.height = `${containerH}px`;
    ctx.scale(dpr, dpr);

    // Object-contain scale: fit imageWidth×imageHeight into containerW×containerH.
    // finalScale includes zoom so the overlay matches the CSS-transformed image.
    // displayWidth/Height use finalScale so that the center of the image stays
    // at the center of the container when zoom changes (zoom from center).
    const baseScale = Math.min(containerW / imageWidth, containerH / imageHeight);
    const finalScale = baseScale * zoom;
    const displayWidth = imageWidth * finalScale;
    const displayHeight = imageHeight * finalScale;
    const offsetX = (containerW - displayWidth) / 2 + pan.x;
    const offsetY = (containerH - displayHeight) / 2 + pan.y;

    visibleAnnotations.forEach((annotation) => {
      const rawColor = annotation.color || "#ea384c";
      const hexColor = rawColor.startsWith("#") ? rawColor : `#${rawColor}`;
      const opacity = (annotation as any).opacity ?? 0.25;

      let r = 234, g = 56, b = 76;
      try {
        r = parseInt(hexColor.slice(1, 3), 16);
        g = parseInt(hexColor.slice(3, 5), 16);
        b = parseInt(hexColor.slice(5, 7), 16);
      } catch {
        /* keep defaults */
      }

      // ── Segmentation masks ────────────────────────────────────────────────
      if (globalShowMasks && annotation.segmentation && annotation.segmentation.length > 0) {
        annotation.segmentation.forEach((segment) => {
          if (!Array.isArray(segment) || segment.length < 6) return;

          // Detect normalized (0-1) vs pixel coordinates. The threshold 1.5
          // gives room for small float-precision overshoots above 1.
          const maxVal = Math.max(...segment.map((v: number) => Math.abs(v)));
          const isNormalized = maxVal <= 1.5;
          const toPixelX = (v: number) =>
            isNormalized ? v * imageWidth : toDisplayX(v);
          const toPixelY = (v: number) =>
            isNormalized ? v * imageHeight : toDisplayY(v);

          ctx.beginPath();
          ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${opacity})`;
          ctx.strokeStyle = hexColor;
          ctx.lineWidth = Math.max(1, finalScale * 2);

          let first = true;
          for (let i = 0; i + 1 < segment.length; i += 2) {
            const x = offsetX + toPixelX(segment[i]) * finalScale;
            const y = offsetY + toPixelY(segment[i + 1]) * finalScale;
            if (first) {
              ctx.moveTo(x, y);
              first = false;
            } else {
              ctx.lineTo(x, y);
            }
          }
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        });
      }

      // ── Bounding boxes ────────────────────────────────────────────────────
      if (annotation.showBboxes && annotation.bbox && annotation.bbox.length === 4) {
        const [bx, by, bw, bh] = annotation.bbox;

        let pixelX: number, pixelY: number, pixelW: number, pixelH: number;
        if (bx <= 1 && by <= 1 && bw <= 1 && bh <= 1) {
          // Normalized coords
          pixelX = bx * imageWidth;
          pixelY = by * imageHeight;
          pixelW = bw * imageWidth;
          pixelH = bh * imageHeight;
        } else {
          // Pixel coords (may need reference-space scaling)
          pixelX = toDisplayX(bx);
          pixelY = toDisplayY(by);
          pixelW = toDisplayX(bw);
          pixelH = toDisplayY(bh);
        }

        const canvasX = offsetX + pixelX * finalScale;
        const canvasY = offsetY + pixelY * finalScale;
        const canvasW = pixelW * finalScale;
        const canvasH = pixelH * finalScale;

        ctx.strokeStyle = hexColor;
        ctx.lineWidth = Math.max(3, finalScale * 4);
        ctx.setLineDash([]);
        ctx.strokeRect(canvasX, canvasY, canvasW, canvasH);

        // Corner markers
        ctx.fillStyle = hexColor;
        const m = 8;
        ctx.fillRect(canvasX - m / 2, canvasY - m / 2, m, m);
        ctx.fillRect(canvasX + canvasW - m / 2, canvasY - m / 2, m, m);
        ctx.fillRect(canvasX - m / 2, canvasY + canvasH - m / 2, m, m);
        ctx.fillRect(canvasX + canvasW - m / 2, canvasY + canvasH - m / 2, m, m);
      }
    });
  }, [
    visibleAnnotations,
    imageWidth,
    imageHeight,
    zoom,
    pan,
    globalShowMasks,
    scaleFromRefX,
    scaleFromRefY,
    drawTick,
  ]);

  return (
    <div
      ref={containerRef}
      className={cn("relative w-full h-full", className)}
      data-testid="annotation-overlay"
      data-image-width={imageWidth}
      data-image-height={imageHeight}
    >
      <canvas ref={canvasRef} className="absolute top-0 left-0 pointer-events-none" />
      {showFileName && visibleAnnotations.length > 0 && (
        <div className="absolute top-1 left-1 z-10 bg-black/70 text-white text-xs rounded px-2 py-0.5 pointer-events-auto select-none max-w-[90%] overflow-hidden whitespace-nowrap text-ellipsis">
          {Array.from(
            new Set(visibleAnnotations.map((a) => a.annotationFileName).filter(Boolean)),
          ).join(", ")}
        </div>
      )}
    </div>
  );
};
