import { Link } from "react-router-dom";
import { Pencil, Upload, Video, ChevronDown, ImageIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Image } from "@/types";
import { ImageDisplayControls } from "@/components/ImageDisplayControls";
import { ImagesGrid } from "@/components/ImagesGrid";
import { PaginationControls } from "@/components/PaginationControls";
import { AnnotationSample } from "@/utils/annotations";
import { ImageDetailModal } from "@/components/ImageDetailModal";
import { AnnotationChoiceModal } from "@/components/AnnotationChoiceModal";
import { useState } from "react";

interface ImagesTabContentProps {
  id: string;
  images: Image[];
  currentPage: number;
  imagesPerPage: number;
  imageSize: number;
  onImagesPerPageChange: (value: number) => void;
  onImageSizeChange: (value: number[]) => void;
  onPageChange: (page: number) => void;
  onOpenUploadDialog: () => void;
  onOpenVideoUploadDialog?: (collectionId?: string | number) => void;
  onDeleteImage: (imageId: string) => Promise<void>;
  onImageClick?: (image: Image) => void;
  paginatedImages: Image[];
  totalPages: number;
  annotations?: AnnotationSample[];
  onImportAnnotations?: (files: File[]) => void;
  selectedImageIndex: number | null;
  setSelectedImageIndex: (idx: number | null) => void;
  
}

function getAnnotationFileName(annotation, annotationFiles) {
  if (!annotationFiles) return "?";
  const found = annotationFiles.find((f) =>
    Array.isArray(f.samples) ? f.samples.some((s) => s.id === annotation.id) : false
  );
  return found ? found.name : "?";
}

export function ImagesTabContent({
  id,
  images,
  currentPage,
  imagesPerPage,
  imageSize,
  onImagesPerPageChange,
  onImageSizeChange,
  onPageChange,
  onOpenUploadDialog,
  onOpenVideoUploadDialog,
  onDeleteImage,
  paginatedImages,
  totalPages,
  annotations = [],
  annotationFiles = [], // <-- add this prop for file name lookup
  selectedImageIndex,
  setSelectedImageIndex,
  
}: ImagesTabContentProps & { annotationFiles?: any[] }) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isAnnotationChoiceModalOpen, setIsAnnotationChoiceModalOpen] = useState(false);

  // Open modal at clicked image index (based on full images array)
  const handleImageClick = (image: Image) => {
    const idx = images.findIndex((img) => img.id === image.id);
    if (idx !== -1) {
      setSelectedImageIndex(idx);
      setIsModalOpen(true);
    }
  };

  const handleCloseModal = () => {
    setIsModalOpen(false);
    setSelectedImageIndex(null);
  };

  const handleDeleteFromModal = async (imageId: string) => {
    await onDeleteImage(imageId);
    handleCloseModal();
  };

  // Navigation handlers (work across all images, not just current page)
  const hasPrev = selectedImageIndex !== null && selectedImageIndex > 0;
  const hasNext = selectedImageIndex !== null && selectedImageIndex < images.length - 1;
  
  const handlePrev = () => {
    if (hasPrev && selectedImageIndex !== null) {
      const newIndex = selectedImageIndex - 1;
      setSelectedImageIndex(newIndex);
      
      // Update page if the new image is on a different page
      const newPage = Math.floor(newIndex / imagesPerPage) + 1;
      if (newPage !== currentPage) {
        onPageChange(newPage);
      }
    }
  };
  
  const handleNext = () => {
    if (hasNext && selectedImageIndex !== null) {
      const newIndex = selectedImageIndex + 1;
      setSelectedImageIndex(newIndex);
      
      // Update page if the new image is on a different page
      const newPage = Math.floor(newIndex / imagesPerPage) + 1;
      if (newPage !== currentPage) {
        onPageChange(newPage);
      }
    }
  };

  // Get current image and annotations (based on full images array)
  const selectedImage = selectedImageIndex !== null ? images[selectedImageIndex] : null;
  const selectedImageAnnotations = selectedImage
    ? annotations.filter((anno) => {
        // Convert both to strings for comparison to handle type mismatches
        const matches = String(anno.imageId) === String(selectedImage.id);
        if (selectedImage) {
          console.log(`ImagesTabContent: Checking annotation ${anno.id} with imageId ${anno.imageId} (type: ${typeof anno.imageId}) against selected image ${selectedImage.id} (type: ${typeof selectedImage.id}) - matches: ${matches}`);
        }
        return matches;
      })
    : [];
  
  console.log(`ImagesTabContent: Selected image:`, selectedImage);
  console.log(`ImagesTabContent: Total annotations available:`, annotations.length);
  console.log(`ImagesTabContent: Filtered annotations for selected image:`, selectedImageAnnotations.length);
  if (annotations.length > 0) {
    console.log(`ImagesTabContent: Sample annotation imageIds:`, annotations.slice(0, 5).map(a => `${a.imageId} (${typeof a.imageId})`));
  }

  // Attach annotationFileName to each annotation for grid and popup
  const annotationsWithFileName = annotations.map((ann) => ({
    ...ann,
    annotationFileName: getAnnotationFileName(ann, annotationFiles),
  }));
  const selectedImageAnnotationsWithFile = selectedImageAnnotations.map((ann) => ({
    ...ann,
    annotationFileName: getAnnotationFileName(ann, annotationFiles),
  }));

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* Header */}
      <div className="flex-shrink-0 flex justify-between items-center mb-4">
        <div>
          <h2 className="text-xl font-semibold">Images</h2>
          <p className="text-sm text-muted-foreground">
            {images.length} total images
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => setIsAnnotationChoiceModalOpen(true)}>
            <Pencil className="w-4 h-4 mr-2" />
            Annotate
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button className="bg-blue-600 hover:bg-blue-700 gap-2">
                <Upload className="w-4 h-4" />
                Upload
                <ChevronDown className="w-4 h-4 opacity-70" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onOpenUploadDialog} className="gap-2">
                <ImageIcon className="w-4 h-4" />
                Upload Images
              </DropdownMenuItem>
              {onOpenVideoUploadDialog && (
                <DropdownMenuItem onClick={() => onOpenVideoUploadDialog()} className="gap-2">
                  <Video className="w-4 h-4" />
                  Upload Video
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Controls */}
      <div className="flex-shrink-0 mb-4">
        <ImageDisplayControls
          imagesPerPage={imagesPerPage}
          onImagesPerPageChange={onImagesPerPageChange}
          imageSize={imageSize}
          onImageSizeChange={onImageSizeChange}
        />
      </div>

      {/* Images Grid - scrollable content */}
      <div className="flex-1 min-h-0 mb-4">
        <ScrollArea className="h-full">
          <ImagesGrid
            images={paginatedImages}
            imageSize={imageSize}
            onOpenUploadDialog={onOpenUploadDialog}
            onOpenVideoUploadDialog={onOpenVideoUploadDialog}
            onDeleteImage={onDeleteImage}
            onImageClick={handleImageClick}
            annotations={annotationsWithFileName}
            annotationFiles={annotationFiles}
          />
        </ScrollArea>
      </div>

      {/* Pagination - fixed at bottom */}
      <div className="flex-shrink-0">
        <PaginationControls
          currentPage={currentPage}
          totalPages={totalPages}
          onPageChange={onPageChange}
        />
      </div>

      {/* Image Detail Modal */}
      <ImageDetailModal
        image={selectedImage}
        isOpen={isModalOpen}
        onClose={handleCloseModal}
        onDelete={handleDeleteFromModal}
        annotations={selectedImageAnnotationsWithFile}
        annotationFiles={annotationFiles}
        onPrev={handlePrev}
        onNext={handleNext}
        hasPrev={hasPrev}
        hasNext={hasNext}
        imageIndex={selectedImageIndex !== null ? selectedImageIndex + 1 : null}
        imageCount={images.length}
      />

      {/* Annotation Choice Modal */}
      <AnnotationChoiceModal
        isOpen={isAnnotationChoiceModalOpen}
        onOpenChange={setIsAnnotationChoiceModalOpen}
        datasetId={id}
      />
    </div>
  );
}
