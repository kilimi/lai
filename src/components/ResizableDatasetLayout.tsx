
import React, { useMemo, useState, useEffect, useRef } from 'react';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable';
import { ImagesTabContent } from '@/components/ImagesTabContent';
import { TabbedImagesContent } from '@/components/TabbedImagesContent';
import { AnnotationsContent } from '@/components/AnnotationsContent';
import { Image, ImageCollection } from '@/types';
import { AnnotationSample } from '@/utils/annotations';
import { LayoutType } from './LayoutControls';
import type { DatasetUiMode } from '@/hooks/useDatasetSettings';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Layers } from 'lucide-react';

interface ResizableDatasetLayoutProps {
  layout: LayoutType;
  id: string;
  projectId?: string;
  images: Image[];
  imageCollections?: ImageCollection[]; // NEW: for tabbed image system
  useTabbedImages?: boolean; // NEW: flag to enable tabbed images
  currentPage: number;
  imagesPerPage: number;
  imageSize: number;
  sliderPosition: number;
  onImagesPerPageChange: (value: number) => void;
  onImageSizeChange: (value: number[]) => void;
  onSliderPositionChange: (value: number) => void;
  onPageChange: (page: number) => void;
  onTabPageChange?: (tabId: string, page: number) => void; // NEW: for tabbed pagination
  onOpenUploadDialog: () => void;
  /** When tabbed mode has zero collections, opens the “create layer” flow */
  onCreateImageCollection?: () => void;
  onOpenVideoUploadDialog?: (collectionId?: string | number) => void;
  onDeleteImage: (imageId: string) => Promise<void>;
  onTabDeleteImage?: (tabId: string, imageId: string) => Promise<void>; // NEW: for tabbed image deletion
  onTabUploadImages?: (tabId: string, files: File[]) => Promise<void>; // NEW: for tabbed image upload
  onAddImageTab?: (tabName: string) => void; // NEW: for adding new tabs
  onRemoveImageTab?: (tabId: string) => void; // NEW: for removing tabs
  onReorderImageTabs?: (orderedTabIds: string[]) => Promise<void>; // NEW: for drag-and-drop tab ordering
  datasetUiMode?: DatasetUiMode;
  paginatedImages: Image[];
  totalPages: number;
  annotations?: AnnotationSample[];
  onImportAnnotations?: (files: File[]) => void;
  onShowAnnotationsChange?: (show: boolean, annotations: AnnotationSample[], annotationFiles?: any[]) => void;
  selectedImageIndex: number | null;
  setSelectedImageIndex: (idx: number | null) => void;
}

export function ResizableDatasetLayout({
  layout,
  id,
  projectId,
  images,
  imageCollections,
  useTabbedImages = false,
  currentPage,
  imagesPerPage,
  imageSize,
  sliderPosition,
  onImagesPerPageChange,
  onImageSizeChange,
  onSliderPositionChange,
  onPageChange,
  onTabPageChange,
  onOpenUploadDialog,
  onCreateImageCollection,
  onOpenVideoUploadDialog,
  onDeleteImage,
  onTabDeleteImage,
  onTabUploadImages,
  onAddImageTab,
  onRemoveImageTab,
  onReorderImageTabs,
  datasetUiMode = 'default',
  paginatedImages,
  totalPages,
  annotations = [],
  onImportAnnotations,
  onShowAnnotationsChange,
  selectedImageIndex,
  setSelectedImageIndex,
}: ResizableDatasetLayoutProps) {
  // Memoize images to prevent new array reference on every render
  const imagesMemo = useMemo(() => images, [JSON.stringify(images)]);
  const [annotationFiles, setAnnotationFiles] = useState<any[]>([]);
  // Counter to force re-mount of vertical ResizablePanelGroup when switching layouts
  const verticalMountKey = useRef(0);
  const prevLayout = useRef(layout);
  if (layout === 'vertical' && prevLayout.current !== 'vertical') {
    verticalMountKey.current += 1;
  }
  prevLayout.current = layout;


  // Handle annotation changes and store annotation files
  const handleShowAnnotationsChange = (show: boolean, annots: AnnotationSample[], files?: any[]) => {
    if (files) {
      setAnnotationFiles(files);
    }
    onShowAnnotationsChange?.(show, annots, files);
  };
  
  const renderImagesSection = () => (
    <ScrollArea className="h-full w-full">
      <div className="p-6">
        {useTabbedImages && imageCollections && imageCollections.length === 0 ? (
          <div className="flex min-h-[280px] flex-col items-center justify-center gap-4 px-4 text-center">
            <Layers className="h-12 w-12 text-muted-foreground" aria-hidden />
            <div>
              <h3 className="text-lg font-semibold text-foreground">No image layers yet</h3>
              <p className="mt-1 max-w-md text-sm text-muted-foreground">
                Create an image collection before you can upload images or extract frames from video.
              </p>
            </div>
            {onCreateImageCollection ? (
              <Button type="button" onClick={onCreateImageCollection}>
                Create image layer
              </Button>
            ) : null}
          </div>
        ) : useTabbedImages && imageCollections && imageCollections.length > 0 ? (
          <TabbedImagesContent
            id={id}
            projectId={projectId}
            imageCollections={imageCollections}
            imagesPerPage={imagesPerPage}
            imageSize={imageSize}
            onImagesPerPageChange={onImagesPerPageChange}
            onImageSizeChange={onImageSizeChange}
            onPageChange={onTabPageChange || (() => {})}
            onDeleteImage={onTabDeleteImage || (() => Promise.resolve())}
            onUploadImages={onTabUploadImages || (() => Promise.resolve())}
            onAddTab={onAddImageTab || (() => {})}
            onRemoveTab={onRemoveImageTab || (() => {})}
            onReorderTabs={onReorderImageTabs || (async () => {})}
            onOpenVideoUploadDialog={onOpenVideoUploadDialog}
            datasetUiMode={datasetUiMode}
            annotations={annotations}
            annotationFiles={annotationFiles}
            selectedImageIndex={selectedImageIndex}
            setSelectedImageIndex={setSelectedImageIndex}
          />
        ) : (
          <ImagesTabContent
            id={id}
            images={imagesMemo}
            currentPage={currentPage}
            imagesPerPage={imagesPerPage}
            imageSize={imageSize}
            onImagesPerPageChange={onImagesPerPageChange}
            onImageSizeChange={onImageSizeChange}
            onPageChange={onPageChange}
            onOpenUploadDialog={onOpenUploadDialog}
            onOpenVideoUploadDialog={onOpenVideoUploadDialog}
            onDeleteImage={onDeleteImage}
            paginatedImages={paginatedImages}
            totalPages={totalPages}
            annotations={annotations}
            annotationFiles={annotationFiles}
            onImportAnnotations={onImportAnnotations}
            selectedImageIndex={selectedImageIndex}
            setSelectedImageIndex={setSelectedImageIndex}
          />
        )}
      </div>
    </ScrollArea>
  );

  /**
   * Annotation panel needs the image ids that are currently "in view" so it can
   * lazy-load per-page annotations. In tabbed mode pagination lives per
   * collection (inside `imageCollections[*].paginatedImages`), so using only the
   * legacy `paginatedImages` prop keeps it stuck on page 1 ids.
   * 
   * IMPORTANT: When the modal is open (selectedImageIndex !== null), we pass ALL
   * image IDs instead of just the current page. This prevents annotations from
   * disappearing when navigating between pages in the modal via Next/Prev.
   */
  const currentPageImageIdsForAnnotations = useMemo(() => {
    // When modal is open, load all annotations to allow smooth navigation
    const isModalOpen = selectedImageIndex !== null;
    
    if (useTabbedImages && imageCollections && imageCollections.length > 0) {
      const ids = new Set<string>();
      for (const collection of imageCollections) {
        // If modal is open, use all images; otherwise just current page
        const imagesToUse = isModalOpen ? collection.images : collection.paginatedImages || [];
        for (const img of imagesToUse) {
          ids.add(String(img.id));
        }
      }
      return Array.from(ids);
    }
    if (useTabbedImages && (!imageCollections || imageCollections.length === 0)) {
      return [];
    }
    // If modal is open, return all image IDs; otherwise just current page
    if (isModalOpen) {
      return images.map((img) => String(img.id));
    }
    return paginatedImages.map((img) => String(img.id));
  }, [useTabbedImages, imageCollections, paginatedImages, selectedImageIndex, images]);
  
  const renderAnnotationsSection = () => (
    <ScrollArea className="h-full w-full">
      <div className="p-6">
        <AnnotationsContent
          id={id}
          projectId={projectId}
          onShowAnnotationsChange={handleShowAnnotationsChange}
          onImportAnnotations={onImportAnnotations}
          className="h-full"
          // Add this prop to always show all annotations on the grid
          showAllAnnotationsOnGrid
          // Pass the dataset images
          images={imagesMemo}
          imageCollections={imageCollections}
          // Pass current page image IDs for smart annotation loading
          currentPageImageIds={currentPageImageIdsForAnnotations}
        />
      </div>
    </ScrollArea>
  );

  if (layout === 'images-only') {
    return (
      <div className="w-full h-full">
        {renderImagesSection()}
      </div>
    );
  }

  if (layout === 'annotations-only') {
    return (
      <div className="w-full h-full">
        {renderAnnotationsSection()}
      </div>
    );
  }

  if (layout === 'vertical') {
    return (
      <div className="w-full h-full">
        <ResizablePanelGroup 
          key={`vertical-layout-${verticalMountKey.current}`}
          direction="vertical" 
          className="w-full h-full"
        >
          <ResizablePanel defaultSize={50} minSize={15} maxSize={85}>
            <div className="bg-card h-full w-full">
              {renderImagesSection()}
            </div>
          </ResizablePanel>
          
          <ResizableHandle withHandle />
          
          <ResizablePanel defaultSize={50} minSize={15} maxSize={85}>
            <div className="bg-card h-full w-full">
              {renderAnnotationsSection()}
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    );
  }

  // Default horizontal layout
  return (
    <ResizablePanelGroup 
      direction="horizontal" 
      className="w-full h-full"
      onLayout={(sizes) => {
        if (sizes[0] !== undefined) {
          onSliderPositionChange(sizes[0]);
        }
      }}
    >
      <ResizablePanel defaultSize={sliderPosition} minSize={20}>
        <div className="bg-card h-full overflow-hidden">
          {renderImagesSection()}
        </div>
      </ResizablePanel>
      
      <ResizableHandle withHandle />
      
      <ResizablePanel defaultSize={100 - sliderPosition} minSize={20}>
        <div className="bg-card h-full overflow-hidden">
          {renderAnnotationsSection()}
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
