import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Upload, Trash2, ChevronDown, ImageIcon, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Card, CardContent } from "@/components/ui/card";
import { Image } from "@/types";
import { resolveBackendMediaUrl } from "@/config/api";
import { AnnotationSample } from "@/utils/annotations";
import { AnnotationVisualizer } from "@/components/AnnotationVisualizer";

interface ImagesGridProps {
  images: Image[];
  imageSize: number;
  onOpenUploadDialog: () => void;
  onOpenVideoUploadDialog?: (collectionId?: string | number) => void;
  onDeleteImage: (imageId: string) => Promise<void>;
  onImageClick?: (image: Image) => void;
  annotations?: AnnotationSample[];
  annotationFiles?: any[];
}

// Helper: get annotation file name for an annotation
function getAnnotationFileName(annotation: any, annotationFiles: any[]): string {
  // First try to use the annotationFileName property if it exists
  if (annotation.annotationFileName) {
    return annotation.annotationFileName;
  }
  
  // Fallback: try to find the annotation file by matching samples
  if (!annotationFiles || annotationFiles.length === 0) {
    return 'Unknown';
  }
  
  const found = annotationFiles.find(f => {
    return Array.isArray(f.samples) && f.samples.some(s => {
      // Try multiple ways to match the annotation
      return s.id === annotation.id || 
             (s.imageId === annotation.imageId && s.className === annotation.className);
    });
  });
  
  return found ? (found.name || found.fileName || 'Unknown') : 'Unknown';
}

// Helper: get display name for annotation
function getAnnotationDisplayName(annotation: AnnotationSample): string {
  // Try different properties that could serve as a name
  if (annotation.id && annotation.id !== annotation.className) return annotation.id;
  if (annotation.annotationFileName) return annotation.annotationFileName;
  
  // If no unique identifier, just return the class name
  return annotation.className;
}

// Helper: group annotations by class and annotation file with counts
function groupAnnotationsByClassAndFile(annotations: AnnotationSample[]): Array<{
  className: string;
  annotationFileName: string;
  color: string;
  count: number;
}> {
  const groupMap = new Map<string, {
    className: string;
    annotationFileName: string;
    color: string;
    count: number;
  }>();

  annotations.forEach(annotation => {
    const fileName = annotation.annotationFileName || 'Unknown';
    const key = `${annotation.className}_${fileName}`;
    
    if (groupMap.has(key)) {
      groupMap.get(key)!.count++;
    } else {
      groupMap.set(key, {
        className: annotation.className,
        annotationFileName: fileName,
        color: annotation.color || '#ea384c',
        count: 1
      });
    }
  });

  return Array.from(groupMap.values()).sort((a, b) => {
    // Sort by class name first, then by annotation file name
    if (a.className !== b.className) {
      return a.className.localeCompare(b.className);
    }
    return a.annotationFileName.localeCompare(b.annotationFileName);
  });
}

export function ImagesGrid({
  images,
  imageSize,
  onOpenUploadDialog,
  onOpenVideoUploadDialog,
  onDeleteImage,
  onImageClick,
  annotations = [],
  annotationFiles = [],
}: ImagesGridProps) {
  // Only show annotations that are visible (if isVisible is defined, must be true)
  const filteredAnnotations = useMemo(
    () => annotations.filter(a => a.isVisible === undefined || a.isVisible),
    [annotations],
  );

  const [deletingImageId, setDeletingImageId] = useState<string | null>(null);
  const [loadedImages, setLoadedImages] = useState<Set<string>>(new Set());
  const [imageDimensions, setImageDimensions] = useState<{ [key: string]: { width: number; height: number } }>({});

  // --- Annotation index map (O(1) lookups instead of O(n) per image) --------
  // Direct: annotation.imageId → annotations[]
  const directAnnotationMap = useMemo(() => {
    const map = new Map<string, typeof filteredAnnotations>();
    for (const ann of filteredAnnotations) {
      const key = String(ann.imageId);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(ann);
    }
    return map;
  }, [filteredAnnotations]);

  // Only show annotations stored against this image row (collection-specific).
  // Do not borrow from RGB/depth peers — copy OFF must not show overlays on other layers.
  const getImageAnnotations = useCallback(
    (imageId: string) => directAnnotationMap.get(imageId) ?? [],
    [directAnnotationMap],
  );
  // -------------------------------------------------------------------------

  const handleDeleteClick = async (e: React.MouseEvent, imageId: string) => {
    e.stopPropagation();
    try {
      setDeletingImageId(imageId);
      await onDeleteImage(imageId);
    } catch (error) {
      // deletion failure surfaced by parent
    } finally {
      setDeletingImageId(null);
    }
  };

  const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>, imageId: string) => {
    const img = e.currentTarget;
    setImageDimensions(prev => ({
      ...prev,
      [imageId]: { width: img.naturalWidth, height: img.naturalHeight },
    }));
    setLoadedImages(prev => new Set(prev).add(imageId));
  };

  // --- Virtual scrolling ----------------------------------------------------
  const GAP = 16; // matches gap-4 (1rem)
  const CARD_EXTRA = 56; // filename + size row below the image thumbnail
  const scrollParentRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    const el = scrollParentRef.current;
    if (!el) return;
    // Inside a Radix ScrollArea viewport (display: table), the element itself
    // shrinks to content width (≈0 with virtualized absolute children), which
    // would collapse the grid to a single column. Measure the nearest ancestor
    // that has a real layout width instead.
    const findSizedAncestor = (start: HTMLElement): HTMLElement => {
      let node: HTMLElement | null = start.parentElement;
      while (node) {
        const w = node.getBoundingClientRect().width;
        if (w > 0) return node;
        node = node.parentElement;
      }
      return start;
    };
    const target = findSizedAncestor(el);
    const observer = new ResizeObserver(([entry]) => {
      setContainerWidth(entry.contentRect.width);
    });
    observer.observe(target);
    setContainerWidth(target.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);

  // Number of columns derived from container width + imageSize (mirrors CSS auto-fill)
  const columnsCount = containerWidth > 0
    ? Math.max(1, Math.floor((containerWidth + GAP) / (imageSize + GAP)))
    : 1;

  const rowCount = Math.ceil(images.length / columnsCount);
  const rowHeight = imageSize + CARD_EXTRA + GAP;

  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: () => rowHeight,
    overscan: 3,
  });
  // -------------------------------------------------------------------------

  if (images.length === 0) {
    const uploadButton = onOpenVideoUploadDialog ? (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="lg" className="gap-2">
            <Upload className="w-4 h-4" />
            Upload
            <ChevronDown className="w-4 h-4 opacity-70" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center">
          <DropdownMenuItem onClick={onOpenUploadDialog} className="gap-2">
            <ImageIcon className="w-4 h-4" />
            Upload Images
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onOpenVideoUploadDialog?.()} className="gap-2">
            <Video className="w-4 h-4" />
            Upload Video
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    ) : (
      <Button onClick={onOpenUploadDialog} size="lg" className="gap-2">
        <Upload className="w-4 h-4" />
        Upload Images
      </Button>
    );
    return (
      <div className="flex-1 flex items-center justify-center py-16">
        <div className="text-center max-w-md mx-auto">
          <div
            className="w-40 h-40 mx-auto mb-6 rounded-2xl border-2 border-dashed border-muted-foreground/30 flex flex-col items-center justify-center bg-muted/30 hover:bg-muted/50 hover:border-primary/50 transition-all duration-300 cursor-pointer group"
            onClick={onOpenUploadDialog}
          >
            <Upload className="w-10 h-10 text-muted-foreground/50 group-hover:text-primary transition-colors mb-2" />
            <span className="text-xs text-muted-foreground/50 group-hover:text-primary transition-colors">
              Drop images here
            </span>
          </div>
          <h3 className="text-lg font-semibold mb-2">No images in this collection</h3>
          <p className="text-sm text-muted-foreground mb-5">
            Upload images or extract frames from a video. Supports JPG, PNG, TIFF, WebP, and video files.
          </p>
          {uploadButton}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={scrollParentRef}
      className="overflow-y-auto p-2"
      style={{ height: '100%' }}
    >
      {/* Total height spacer so the scrollbar reflects the full list */}
      <div
        style={{
          height: `${rowVirtualizer.getTotalSize()}px`,
          position: 'relative',
        }}
      >
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const startIndex = virtualRow.index * columnsCount;
          const rowImages = images.slice(startIndex, startIndex + columnsCount);

          return (
            <div
              key={virtualRow.index}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualRow.start}px)`,
                display: 'grid',
                gap: `${GAP}px`,
                gridTemplateColumns: `repeat(${columnsCount}, minmax(0, 1fr))`,
                paddingBottom: `${GAP}px`,
              }}
            >
              {rowImages.map((image) => {
                const imageAnnotations = getImageAnnotations(String(image.id));
                const imageIsLoaded = loadedImages.has(image.id);
                const dimensions = imageDimensions[image.id];

                return (
                  <Card
                    key={image.id}
                    className="group cursor-pointer hover:ring-2 hover:ring-primary transition-all duration-200"
                    onClick={() => onImageClick?.(image)}
                  >
                    <CardContent className="p-0 relative">
                      <div
                        className="relative overflow-hidden rounded-lg"
                        style={{ height: `${imageSize}px` }}
                      >
                        {!imageIsLoaded && (
                          <div className="absolute inset-0 flex items-center justify-center bg-muted">
                            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                          </div>
                        )}
                        <img
                          src={
                            resolveBackendMediaUrl(image.thumbnailUrl) ||
                            resolveBackendMediaUrl(image.url) ||
                            image.thumbnailUrl ||
                            image.url
                          }
                          alt={image.fileName}
                          className={`w-full h-full object-contain ${imageIsLoaded ? 'opacity-100' : 'opacity-0'}`}
                          loading="lazy"
                          onLoad={(e) => handleImageLoad(e, image.id)}
                        />

                        {/* Annotation overlay */}
                        {imageIsLoaded && imageAnnotations.length > 0 && dimensions?.width && dimensions?.height && (() => {
                          const first = imageAnnotations[0];
                          const refW = first.referenceImageWidth ?? image.width;
                          const refH = first.referenceImageHeight ?? image.height;
                          if (!refW || !refH) return null;
                          return (
                            <div className="absolute inset-0">
                              <AnnotationVisualizer
                                annotations={imageAnnotations}
                                imageWidth={dimensions.width}
                                imageHeight={dimensions.height}
                                referenceImageWidth={refW}
                                referenceImageHeight={refH}
                                className="w-full h-full"
                                showFileName={false}
                                globalShowMasks={true}
                              />
                            </div>
                          );
                        })()}

                        {/* Delete button */}
                        <Button
                          variant="destructive"
                          size="icon"
                          className="absolute top-2 right-2 w-8 h-8 opacity-0 group-hover:opacity-100 transition-opacity duration-200"
                          onClick={(e) => handleDeleteClick(e, image.id)}
                          disabled={deletingImageId === image.id}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>

                        {/* Annotation labels */}
                        {imageAnnotations.length > 0 && (
                          <div className="absolute bottom-2 left-2 bg-black/80 text-white text-xs px-2 py-1 rounded max-w-[90%] break-words flex flex-wrap gap-x-2 gap-y-1">
                            {groupAnnotationsByClassAndFile(imageAnnotations).map((group, index) => (
                              <span key={`${group.className}-${group.annotationFileName}-${index}`} className="inline-flex items-center">
                                <span
                                  style={{
                                    display: 'inline-block',
                                    width: 8,
                                    height: 8,
                                    backgroundColor: group.color,
                                    borderRadius: '50%',
                                    marginRight: '4px',
                                  }}
                                />
                                {group.className} ({group.annotationFileName}) ({group.count})
                              </span>
                            ))}
                          </div>
                        )}
                      </div>

                      <div className="p-3">
                        <p className="text-sm font-medium truncate" title={image.fileName}>
                          {image.fileName}
                        </p>
                        <div className="flex justify-between items-center mt-1">
                          <p className="text-xs text-muted-foreground">
                            {dimensions ? `${dimensions.width} × ${dimensions.height}` : `${image.width || 0} × ${image.height || 0}`}
                          </p>
                          {image.fileSize && (
                            <p className="text-xs text-muted-foreground">
                              {(image.fileSize / 1024 / 1024).toFixed(1)} MB
                            </p>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
