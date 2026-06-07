
import React from 'react';
import { Button } from '@/components/ui/button';
import { ZoomIn, ZoomOut, RotateCcw } from 'lucide-react';

interface ImageZoomControlsProps {
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetZoom: () => void;
}

export const ImageZoomControls = ({ 
  zoom, 
  onZoomIn, 
  onZoomOut, 
  onResetZoom 
}: ImageZoomControlsProps) => {
  return (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={onZoomOut}
        disabled={zoom <= 0.1}
        className="border-gray-600 hover:bg-gray-800"
      >
        <ZoomOut className="h-4 w-4" />
      </Button>
      <span className="text-sm text-gray-400 min-w-[4rem] text-center">
        {Math.round(zoom * 100)}%
      </span>
      <Button
        variant="outline"
        size="sm"
        onClick={onZoomIn}
        disabled={zoom >= 5}
        className="border-gray-600 hover:bg-gray-800"
      >
        <ZoomIn className="h-4 w-4" />
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={onResetZoom}
        className="border-gray-600 hover:bg-gray-800"
      >
        <RotateCcw className="h-4 w-4" />
      </Button>
    </div>
  );
};
