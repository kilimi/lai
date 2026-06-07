
import React from 'react';
import { Button } from '@/components/ui/button';
import { ChevronLeft, ChevronRight } from 'lucide-react';

interface ImageNavigationProps {
  hasPrev: boolean;
  hasNext: boolean;
  onPrev?: () => void;
  onNext?: () => void;
}

export const ImageNavigation = ({ 
  hasPrev, 
  hasNext, 
  onPrev, 
  onNext 
}: ImageNavigationProps) => {
  return (
    <>
      {/* Left arrow */}
      {hasPrev && (
        <Button
          variant="ghost"
          size="icon"
          className="absolute left-2 top-1/2 -translate-y-1/2 z-20 bg-gray-800/70 hover:bg-gray-700"
          onClick={onPrev}
          aria-label="Previous image"
        >
          <ChevronLeft className="h-6 w-6" />
        </Button>
      )}
      
      {/* Right arrow */}
      {hasNext && (
        <Button
          variant="ghost"
          size="icon"
          className="absolute right-2 top-1/2 -translate-y-1/2 z-20 bg-gray-800/70 hover:bg-gray-700"
          onClick={onNext}
          aria-label="Next image"
        >
          <ChevronRight className="h-6 w-6" />
        </Button>
      )}
    </>
  );
};
