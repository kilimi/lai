
import React, { useRef, useEffect } from 'react';
import { Image } from '@/types';
import { resolveBackendMediaUrl } from '@/config/api';
import { AnnotationVisualizer } from '@/components/AnnotationVisualizer';
import { AnnotationSample } from '@/utils/annotations';

interface ImageViewportProps {
  image: Image;
  imageDimensions: { width: number; height: number };
  imageLoaded: boolean;
  zoom: number;
  pan: { x: number; y: number };
  isDragging: boolean;
  annotations: (AnnotationSample & { annotationFileName?: string })[];
  annotationKey: number;
  onImageLoad: (e: React.SyntheticEvent<HTMLImageElement>) => void;
  onWheel: (e: React.WheelEvent) => void;
  onMouseDown: (e: React.MouseEvent) => void;
  onMouseMove: (e: React.MouseEvent) => void;
  onMouseUp: () => void;
  onDoubleClick: () => void;
  onImageClick: (e: React.MouseEvent) => void;
  useFullSize?: boolean; // Option to use full-size image vs thumbnail
}

export const ImageViewport = ({
  image,
  imageDimensions,
  imageLoaded,
  zoom,
  pan,
  isDragging,
  annotations,
  annotationKey,
  onImageLoad,
  onWheel,
  onMouseDown,
  onMouseMove,
  onMouseUp,
  onDoubleClick,
  onImageClick,
  useFullSize = true // Default to true for backward compatibility
}: ImageViewportProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);

  // When showing full-size: start with thumbnail for instant display, then load original
  const placeholderUrl =
    resolveBackendMediaUrl(image?.thumbnailUrl) ||
    resolveBackendMediaUrl(image?.url) ||
    image?.thumbnailUrl ||
    image?.url;
  const fullUrl = resolveBackendMediaUrl(image?.url) || image?.url;
  const startWithPlaceholder = useFullSize && fullUrl && placeholderUrl && fullUrl !== placeholderUrl;
  const expectingFullLoadRef = useRef(false);

  useEffect(() => {
    if (!startWithPlaceholder || !imageRef.current || !fullUrl) return;
    expectingFullLoadRef.current = true;
    imageRef.current.src = fullUrl;
  }, [startWithPlaceholder, fullUrl, image?.id]);

  const initialSrc = useFullSize
    ? (startWithPlaceholder ? placeholderUrl : fullUrl)
    : (placeholderUrl || fullUrl);

  const handleLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    if (startWithPlaceholder && expectingFullLoadRef.current) {
      expectingFullLoadRef.current = false;
      onImageLoad(e);
    } else if (!startWithPlaceholder) {
      onImageLoad(e);
    }
  };

  return (
    <div 
      ref={containerRef}
      className="relative bg-gray-950 rounded-lg overflow-hidden flex items-center justify-center"
      style={{ 
        height: '60vh',
        cursor: zoom > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default'
      }}
      onWheel={onWheel}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onDoubleClick={onDoubleClick}
    >
      {/* Image and annotations in the same transformed wrapper so overlay and image always align (same zoom/pan) */}
      <div
        className="relative flex items-center justify-center"
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transformOrigin: '0 0',
          transition: isDragging ? 'none' : 'transform 0.1s ease-out',
          maxHeight: '60vh',
          maxWidth: '100%'
        }}
        onClick={onImageClick}
      >
        {/* Image container with natural dimensions */}
        <div className="relative">
          <img
            ref={imageRef}
            key={image?.id}
            src={initialSrc}
            alt={image.fileName}
            className="max-h-full max-w-full object-contain"
            onLoad={handleLoad}
            draggable={false}
            style={{ 
              maxHeight: '60vh',
              maxWidth: '100%',
              userSelect: 'none'
            }}
          />
        </div>
        {/* Overlay inside same transformed div so it shares the same coordinate system as the image */}
        {imageLoaded && annotations && annotations.length > 0 && (() => {
          const first = annotations[0];
          return (
            <AnnotationVisualizer
              key={`${image?.id}-${annotationKey}`}
              annotations={annotations}
              imageWidth={imageDimensions.width}
              imageHeight={imageDimensions.height}
              referenceImageWidth={first.referenceImageWidth}
              referenceImageHeight={first.referenceImageHeight}
              className="absolute inset-0 pointer-events-none"
              showFileName={false}
              zoom={1}
              pan={{ x: 0, y: 0 }}
            />
          );
        })()}
      </div>
    </div>
  );
};
