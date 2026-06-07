
import React, { useState } from "react";
import { AnnotationSample } from "@/utils/annotations";
import { Image as ImageType } from "@/types";
import { AnnotationVisualizer } from "@/components/AnnotationVisualizer";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { X } from "lucide-react";

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

interface AnnotationImagesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  annotations: AnnotationSample[];
  images: ImageType[];
  annotationFileName: string;
  fileName?: string;
  onApply?: (annotationsToApply: AnnotationSample[]) => void;
  onShowOnImage?: (annotations: AnnotationSample[]) => void;
}

export const AnnotationImagesDialog = ({
  open,
  onOpenChange,
  annotations,
  images,
  annotationFileName,
  onApply,
  onShowOnImage,
}: AnnotationImagesDialogProps) => {
  const [imageDimensions, setImageDimensions] = useState<{ [key: string]: { width: number; height: number } }>({});
  const [loadedImages, setLoadedImages] = useState<Set<string>>(new Set());
  
  // Get unique image IDs from annotations (maximum 5)
  const uniqueImageIds = Array.from(
    new Set(annotations.map((anno) => anno.imageId))
  ).slice(0, 5);
  
  // Get images that have annotations
  const imagesWithAnnotations = images.filter((img) =>
    uniqueImageIds.includes(img.id)
  );
  
  // Handle image load to get dimensions
  const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>, imageId: string) => {
    const img = e.currentTarget;
    setImageDimensions(prev => ({
      ...prev,
      [imageId]: {
        width: img.naturalWidth,
        height: img.naturalHeight
      }
    }));
    setLoadedImages(prev => new Set(prev).add(imageId));
  };
  
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl bg-gray-900 text-white border-gray-700">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between">
            <span>Annotations from {annotationFileName}</span>
            <Badge variant="outline" className="ml-2 bg-blue-900/30">
              {annotations.length} annotations on {uniqueImageIds.length} images
            </Badge>
          </DialogTitle>
          <DialogDescription className="text-gray-400">
            Showing up to 5 images with their annotations
          </DialogDescription>
        </DialogHeader>
        
        <div className="space-y-6 max-h-[70vh] overflow-y-auto p-1">
          {imagesWithAnnotations.length > 0 ? (
            imagesWithAnnotations.map((image) => {
              const imageAnnotations = annotations.filter(
                (anno) => anno.imageId === image.id
              );
              
              return (
                <div key={image.id} className="border border-gray-800 rounded-lg p-4 bg-gray-800/50">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-lg font-medium text-white">{image.fileName}</h3>
                    <Badge className="bg-blue-600/70">
                      {imageAnnotations.length} annotations
                    </Badge>
                  </div>
                  
                  <div className="relative aspect-video bg-gray-950 rounded-md overflow-hidden flex items-center justify-center">
                    <img
                      src={image.thumbnailUrl || image.url}
                      alt={image.fileName}
                      className="max-w-full max-h-full object-contain"
                      loading="lazy"
                      onLoad={(e) => handleImageLoad(e, image.id)}
                    />
                    
                    {/* Only render annotations after image is loaded */}
                    {loadedImages.has(image.id) && imageDimensions[image.id] && (
                      <AnnotationVisualizer
                        annotations={imageAnnotations}
                        imageWidth={imageDimensions[image.id].width}
                        imageHeight={imageDimensions[image.id].height}
                        className="absolute inset-0"
                      />
                    )}
                  </div>
                  
                  {/* Classes in this image - grouped by class and annotation file */}
                  <div className="flex flex-wrap gap-2 mt-3">
                    {groupAnnotationsByClassAndFile(imageAnnotations).map((group, index) => (
                      <Badge key={`${group.className}-${group.annotationFileName}-${index}`} variant="outline" className="bg-gray-800 border-gray-700">
                        <span
                          style={{
                            display: 'inline-block',
                            width: 8,
                            height: 8,
                            backgroundColor: group.color,
                            borderRadius: '50%',
                            marginRight: '6px',
                          }}
                        />
                        {group.className} ({group.annotationFileName}) ({group.count})
                      </Badge>
                    ))}
                  </div>
                </div>
              );
            })
          ) : (
            <div className="py-10 text-center">
              <p className="text-gray-400">No matching images found for these annotations.</p>
            </div>
          )}
        </div>
        
        <DialogFooter>
          {onShowOnImage && (
            <Button
              onClick={() => {
                onShowOnImage(annotations);
                onOpenChange(false);
              }}
              className="bg-blue-600 hover:bg-blue-700 text-white mr-2"
            >
              Show on Images
            </Button>
          )}
          <Button 
            onClick={() => onOpenChange(false)}
            className="bg-gray-800 hover:bg-gray-700 text-white"
          >
            <X className="mr-2 h-4 w-4" />
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
