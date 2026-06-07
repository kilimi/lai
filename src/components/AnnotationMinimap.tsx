import React, { useRef, useEffect } from 'react';

interface AnnotationMinimapProps {
  imageRef: React.RefObject<HTMLImageElement>;
  containerRef: React.RefObject<HTMLDivElement>;
  imageScale: number;
  imageOffset: { x: number; y: number };
  onNavigate: (offset: { x: number; y: number }) => void;
}

export const AnnotationMinimap = ({
  imageRef,
  containerRef,
  imageScale,
  imageOffset,
  onNavigate,
}: AnnotationMinimapProps) => {
  const minimapCanvasRef = useRef<HTMLCanvasElement>(null);
  const MINIMAP_SIZE = 160;

  useEffect(() => {
    const canvas = minimapCanvasRef.current;
    const img = imageRef.current;
    const container = containerRef.current;
    if (!canvas || !img || !container || !img.naturalWidth) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const containerRect = container.getBoundingClientRect();
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;

    // Calculate minimap scale to fit image
    const minimapScale = Math.min(MINIMAP_SIZE / nw, MINIMAP_SIZE / nh);
    const mw = nw * minimapScale;
    const mh = nh * minimapScale;

    canvas.width = MINIMAP_SIZE;
    canvas.height = MINIMAP_SIZE;

    // Clear
    ctx.clearRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE);

    // Background
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE);

    // Draw thumbnail
    const offsetX = (MINIMAP_SIZE - mw) / 2;
    const offsetY = (MINIMAP_SIZE - mh) / 2;
    ctx.drawImage(img, offsetX, offsetY, mw, mh);

    // Calculate viewport rectangle
    const viewLeft = -imageOffset.x / imageScale;
    const viewTop = -imageOffset.y / imageScale;
    const viewWidth = containerRect.width / imageScale;
    const viewHeight = containerRect.height / imageScale;

    // Clamp to image bounds
    const vx = Math.max(0, viewLeft) * minimapScale + offsetX;
    const vy = Math.max(0, viewTop) * minimapScale + offsetY;
    const vw = Math.min(viewWidth, nw) * minimapScale;
    const vh = Math.min(viewHeight, nh) * minimapScale;

    // Draw viewport rect
    ctx.strokeStyle = 'hsl(var(--primary))';
    ctx.lineWidth = 2;
    ctx.strokeRect(vx, vy, vw, vh);

    // Semi-transparent fill
    ctx.fillStyle = 'hsla(var(--primary), 0.1)';
    ctx.fillRect(vx, vy, vw, vh);
  }, [imageRef, containerRef, imageScale, imageOffset]);

  const handleMinimapClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = minimapCanvasRef.current;
    const img = imageRef.current;
    const container = containerRef.current;
    if (!canvas || !img || !container || !img.naturalWidth) return;

    const rect = canvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    const minimapScale = Math.min(MINIMAP_SIZE / nw, MINIMAP_SIZE / nh);
    const mw = nw * minimapScale;
    const mh = nh * minimapScale;
    const offsetX = (MINIMAP_SIZE - mw) / 2;
    const offsetY = (MINIMAP_SIZE - mh) / 2;

    // Convert click to image coordinates
    const imgX = (clickX - offsetX) / minimapScale;
    const imgY = (clickY - offsetY) / minimapScale;

    const containerRect = container.getBoundingClientRect();
    // Center viewport on clicked point
    const newOffsetX = containerRect.width / 2 - imgX * imageScale;
    const newOffsetY = containerRect.height / 2 - imgY * imageScale;

    onNavigate({ x: newOffsetX, y: newOffsetY });
  };

  // Only show when zoomed in
  if (imageScale <= 1.1) return null;

  return (
    <div className="absolute bottom-20 right-4 z-30 rounded-lg overflow-hidden border border-border/50 shadow-lg bg-background/80 backdrop-blur-sm">
      <canvas
        ref={minimapCanvasRef}
        width={MINIMAP_SIZE}
        height={MINIMAP_SIZE}
        className="cursor-pointer block"
        onClick={handleMinimapClick}
        title="Click to navigate"
      />
    </div>
  );
};
