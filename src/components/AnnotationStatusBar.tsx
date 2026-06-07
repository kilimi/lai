import React from 'react';
import { MousePointer2, ZoomIn, Image, Layers, Save, AlertCircle } from 'lucide-react';

interface AnnotationStatusBarProps {
  cursorPosition: { x: number; y: number } | null;
  zoom: number;
  imageWidth: number;
  imageHeight: number;
  annotationCount: number;
  currentImageIndex: number;
  totalImages: number;
  hasUnsavedChanges: boolean;
  isAutoSaving: boolean;
  activeTool: string;
  annotationMode?: 'mask' | 'bbox';
}

const TOOL_LABELS: Record<string, string> = {
  'select': 'Select (V)',
  'rectangle': 'Rectangle',
  'polygon': 'Polygon (P)',
  'auto-segment': 'AI Segment (A)',
};

export const AnnotationStatusBar = ({
  cursorPosition,
  zoom,
  imageWidth,
  imageHeight,
  annotationCount,
  currentImageIndex,
  totalImages,
  hasUnsavedChanges,
  isAutoSaving,
  activeTool,
  annotationMode = 'mask',
}: AnnotationStatusBarProps) => {
  return (
    <div className="flex items-center justify-between px-4 py-1.5 bg-card border-t border-border text-xs text-muted-foreground select-none">
      {/* Left section */}
      <div className="flex items-center gap-4">
        {/* Active tool */}
        <div className="flex items-center gap-1.5">
          <MousePointer2 className="w-3 h-3" />
          <span>{TOOL_LABELS[activeTool] || activeTool}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-foreground/60">Mode:</span>
          <span className={annotationMode === 'bbox' ? 'text-primary font-medium' : 'font-medium'}>
            {annotationMode === 'bbox' ? 'BBox' : 'Mask'}
          </span>
        </div>

        {/* Cursor position */}
        {cursorPosition && (
          <div className="flex items-center gap-1.5">
            <span className="text-foreground/60">X:</span>
            <span className="font-mono">{Math.round(cursorPosition.x)}</span>
            <span className="text-foreground/60">Y:</span>
            <span className="font-mono">{Math.round(cursorPosition.y)}</span>
          </div>
        )}
      </div>

      {/* Center section */}
      <div className="flex items-center gap-4">
        {/* Zoom */}
        <div className="flex items-center gap-1.5">
          <ZoomIn className="w-3 h-3" />
          <span className="font-mono">{Math.round(zoom * 100)}%</span>
        </div>

        {/* Image dimensions */}
        {imageWidth > 0 && imageHeight > 0 && (
          <div className="flex items-center gap-1.5">
            <Image className="w-3 h-3" />
            <span className="font-mono">{imageWidth}×{imageHeight}</span>
          </div>
        )}

        {/* Image index */}
        <div className="flex items-center gap-1.5">
          <Layers className="w-3 h-3" />
          <span>{currentImageIndex + 1}/{totalImages}</span>
        </div>
      </div>

      {/* Right section */}
      <div className="flex items-center gap-4">
        {/* Annotation count */}
        <div className="flex items-center gap-1.5">
          <span>{annotationCount} annotation{annotationCount !== 1 ? 's' : ''}</span>
        </div>

        {/* Save status */}
        <div className="flex items-center gap-1.5">
          {isAutoSaving ? (
            <>
              <Save className="w-3 h-3 animate-pulse text-primary" />
              <span className="text-primary">Saving...</span>
            </>
          ) : hasUnsavedChanges ? (
            <>
              <AlertCircle className="w-3 h-3 text-yellow-500" />
              <span className="text-yellow-500">Unsaved</span>
            </>
          ) : (
            <>
              <Save className="w-3 h-3 text-green-500" />
              <span className="text-green-500">Saved</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
