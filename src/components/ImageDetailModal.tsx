
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Image } from "@/types";
import { Button } from "@/components/ui/button";
import { Trash2, Download } from "lucide-react";
import { AnnotationSample } from "@/utils/annotations";
import { useState, useEffect, useRef } from "react";
import { ImageZoomControls } from "@/components/ImageZoomControls";
import { ImageNavigation } from "@/components/ImageNavigation";
import { ImageViewport } from "@/components/ImageViewport";
import { ImageAnnotationDisplay } from "@/components/ImageAnnotationDisplay";

interface ImageDetailModalProps {
  image: Image | null;
  isOpen: boolean;
  onClose: () => void;
  onDelete?: (imageId: string) => Promise<void>;
  annotations?: AnnotationSample[];
  onPrev?: () => void;
  onNext?: () => void;
  hasPrev?: boolean;
  hasNext?: boolean;
  imageIndex?: number | null;
  imageCount?: number;
}

// Helper: get annotation file name for an annotation
function getAnnotationFileName(annotation, annotationFiles) {
  if (!annotationFiles) return '?';
  const found = annotationFiles.find(f => Array.isArray(f.samples) && f.samples.some(s => s.id === annotation.id));
  return found ? found.name : '?';
}

export function ImageDetailModal({ 
  image, 
  isOpen, 
  onClose, 
  onDelete,
  annotations = [],
  onPrev,
  onNext,
  hasPrev = false,
  hasNext = false,
  imageIndex = null,
  imageCount = undefined,
  annotationFiles = [],
}: ImageDetailModalProps & { annotationFiles?: any[] }) {
  const [imageDimensions, setImageDimensions] = useState({ width: 0, height: 0 });
  const [imageLoaded, setImageLoaded] = useState(false);
  const [annotationKey, setAnnotationKey] = useState(0); // Force re-render key
  // Tracks the pending load-settle timeout so we can cancel it on navigation.
  const loadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Always show original in popup (thumbnail used as fast placeholder until load)
  
  // Zoom and pan state
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });

  // Reset state when image changes; cancel any pending load-settle timeout so
  // a slow-loading previous image cannot overwrite the current image's state.
  useEffect(() => {
    if (loadTimeoutRef.current !== null) {
      clearTimeout(loadTimeoutRef.current);
      loadTimeoutRef.current = null;
    }
    setImageLoaded(false);
    setImageDimensions({ width: 0, height: 0 });
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setIsDragging(false);
    setAnnotationKey(prev => prev + 1);
  }, [image?.id]);

  const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    const dimensions = {
      width: img.naturalWidth,
      height: img.naturalHeight,
    };
    setImageDimensions(dimensions);

    // Short settle delay so the browser completes layout after the image renders.
    // We cancel any previous timeout (set by the previous image) before starting
    // a new one, preventing a stale timeout from overwriting current state.
    if (loadTimeoutRef.current !== null) {
      clearTimeout(loadTimeoutRef.current);
    }
    loadTimeoutRef.current = setTimeout(() => {
      loadTimeoutRef.current = null;
      setImageLoaded(true);
      setAnnotationKey(prev => prev + 1);
    }, 50);
  };

  // Zoom functions
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    const newZoom = Math.max(0.1, Math.min(5, zoom + delta));
    setZoom(newZoom);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (zoom > 1) {
      setIsDragging(true);
      setDragStart({ x: e.clientX, y: e.clientY });
      setPanStart({ x: pan.x, y: pan.y });
      e.preventDefault();
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isDragging && zoom > 1) {
      const deltaX = e.clientX - dragStart.x;
      const deltaY = e.clientY - dragStart.y;
      
      setPan({
        x: panStart.x + deltaX,
        y: panStart.y + deltaY
      });
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const handleDoubleClick = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const zoomIn = () => {
    const newZoom = Math.min(5, zoom + 0.25);
    setZoom(newZoom);
  };

  const zoomOut = () => {
    const newZoom = Math.max(0.1, zoom - 0.25);
    setZoom(newZoom);
    
    // If zooming out to 1 or less, reset pan
    if (newZoom <= 1) {
      setPan({ x: 0, y: 0 });
    }
  };

  const resetZoom = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  // Keyboard navigation and mouse events
  useEffect(() => {
    if (!isOpen) return;
    
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft" && hasPrev && onPrev && !isDragging) {
        e.preventDefault();
        onPrev();
      } else if (e.key === "ArrowRight" && hasNext && onNext && !isDragging) {
        e.preventDefault();
        onNext();
      } else if (e.key === "Escape") {
        onClose();
      }
    };

    const handleGlobalMouseMove = (e: MouseEvent) => {
      if (isDragging && zoom > 1) {
        const deltaX = e.clientX - dragStart.x;
        const deltaY = e.clientY - dragStart.y;
        
        setPan({
          x: panStart.x + deltaX,
          y: panStart.y + deltaY
        });
      }
    };

    const handleGlobalMouseUp = () => {
      setIsDragging(false);
    };

    window.addEventListener("keydown", handleKeyDown);
    
    if (isDragging) {
      window.addEventListener("mousemove", handleGlobalMouseMove);
      window.addEventListener("mouseup", handleGlobalMouseUp);
    }
    
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("mousemove", handleGlobalMouseMove);
      window.removeEventListener("mouseup", handleGlobalMouseUp);
    };
  }, [isOpen, hasPrev, hasNext, onPrev, onNext, isDragging, dragStart, panStart, zoom, onClose]);

  if (!image) return null;

  // Extract filename from URL if fileName is empty
  const getImageName = () => {
    if (image.fileName && image.fileName.trim() !== '') {
      return image.fileName;
    }
    if (image.url) {
      const urlParts = image.url.split('/');
      return urlParts[urlParts.length - 1] || 'Unknown Image';
    }
    return 'Unknown Image';
  };

  const imageName = getImageName();

  // Add annotationFileName to each annotation for display
  const annotationsWithFileName = annotations.map(ann => ({
    ...ann,
    annotationFileName: getAnnotationFileName(ann, annotationFiles)
  }));

  const handleImageClick = (e: React.MouseEvent) => {
    if (!isDragging && annotationsWithFileName.length > 0) {
      setAnnotationKey(prev => prev + 1);
    }
  };

  const handleDownload = async () => {
    if (!image?.url) return;
    try {
      const res = await fetch(image.url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch image");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = image.fileName ?? "image";
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // Fallback: open in new tab so user can save manually
      window.open(image.url, "_blank", "noopener,noreferrer");
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-6xl max-h-[90vh] bg-gray-900 text-white border-gray-700">
        {/* Image Info Header - Image name first, then dimensions */}
        <div className="border-b border-gray-700 pb-2 mb-4">
          <DialogTitle className="text-sm font-medium text-white">
            {imageName} • {imageDimensions.width > 0 ? `${imageDimensions.width} × ${imageDimensions.height}` : 'Loading...'} • {((image?.fileSize || 0) / (1024 * 1024)).toFixed(2)} MB
          </DialogTitle>
        </div>
        
        {/* Controls Row */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-4">
            <ImageZoomControls
              zoom={zoom}
              onZoomIn={zoomIn}
              onZoomOut={zoomOut}
              onResetZoom={resetZoom}
            />
          </div>
          <div className="flex items-center gap-4">
            {imageIndex !== null && imageCount !== undefined && (
              <span className="text-sm text-gray-400">{imageIndex} of {imageCount}</span>
            )}
          </div>
        </div>
        <div className="flex flex-col space-y-2">
          <div className="text-sm text-gray-400">
            {zoom > 1 && (
              <span className="text-blue-400">
                🔍 Scroll to zoom • Drag to pan • Double-click to reset
              </span>
            )}
          </div>
          <div className="relative">
            <ImageViewport
              image={image}
              imageDimensions={imageDimensions}
              imageLoaded={imageLoaded}
              zoom={zoom}
              pan={pan}
              isDragging={isDragging}
              annotations={annotationsWithFileName}
              annotationKey={annotationKey}
              onImageLoad={handleImageLoad}
              onWheel={handleWheel}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onDoubleClick={handleDoubleClick}
              onImageClick={handleImageClick}
              useFullSize={true}
            />
            
            <ImageNavigation
              hasPrev={hasPrev}
              hasNext={hasNext}
              onPrev={onPrev}
              onNext={onNext}
            />
          </div>
          <div className="flex justify-between items-center pt-2">
            <ImageAnnotationDisplay annotations={annotationsWithFileName} />
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleDownload}
                disabled={!image?.url}
                className="inline-flex items-center"
              >
                <Download className="mr-2 h-4 w-4" />
                Download
              </Button>
              {onDelete && (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => {
                    onDelete(image.id);
                    onClose();
                  }}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete Image
                </Button>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
