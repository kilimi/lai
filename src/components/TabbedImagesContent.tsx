import { useNavigate } from "react-router-dom";
import { Pencil, Upload, Video, Plus, X, FolderOpen, Search, ChevronDown, ImageIcon, GripVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Image, ImageCollection } from "@/types";
import { ImageDisplayControls } from "@/components/ImageDisplayControls";
import { ImagesGrid } from "@/components/ImagesGrid";
import { PaginationControls } from "@/components/PaginationControls";
import { AnnotationSample } from "@/utils/annotations";
import { ImageDetailModal } from "@/components/ImageDetailModal";
import { AnnotationChoiceModal } from "@/components/AnnotationChoiceModal";
import { AddImageTabDialog } from "@/components/AddImageTabDialog";
import { ChunkedImageCollectionUploadDialog } from "@/components/ChunkedImageCollectionUploadDialog";
import { useState, useEffect, useRef } from "react";
import type { DatasetUiMode } from "@/hooks/useDatasetSettings";

interface TabbedImagesContentProps {
  id: string;
  projectId?: string;
  imageCollections: ImageCollection[];
  imagesPerPage: number;
  imageSize: number;
  onImagesPerPageChange: (value: number) => void;
  onImageSizeChange: (value: number[]) => void;
  onPageChange: (tabId: string, page: number) => void;
  onDeleteImage: (tabId: string, imageId: string) => Promise<void>;
  onUploadImages: (tabId: string, files: File[]) => Promise<void>;
  onAddTab: (tabName: string) => void;
  onRemoveTab: (tabId: string) => void;
  onReorderTabs: (orderedTabIds: string[]) => Promise<void>;
  onOpenVideoUploadDialog?: (collectionId?: string | number) => void;
  datasetUiMode?: DatasetUiMode;
  annotations?: AnnotationSample[];
  annotationFiles?: any[];
  selectedImageIndex: number | null;
  setSelectedImageIndex: (idx: number | null) => void;
}

function getAnnotationFileName(annotation: any, annotationFiles: any[]): string {
  if (!annotationFiles) return "?";
  const found = annotationFiles.find((f) =>
    Array.isArray(f.samples) ? f.samples.some((s) => s.id === annotation.id) : false
  );
  return found ? found.name : "?";
}

export function TabbedImagesContent({
  id,
  projectId,
  imageCollections,
  imagesPerPage,
  imageSize,
  onImagesPerPageChange,
  onImageSizeChange,
  onPageChange,
  onDeleteImage,
  onUploadImages,
  onAddTab,
  onRemoveTab,
  onReorderTabs,
  onOpenVideoUploadDialog,
  datasetUiMode = 'default',
  annotations = [],
  annotationFiles = [],
  selectedImageIndex,
  setSelectedImageIndex,
}: TabbedImagesContentProps) {
  const [activeTab, setActiveTab] = useState(imageCollections.length > 0 ? String(imageCollections[0].id) : "");
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedClickedImage, setSelectedClickedImage] = useState<Image | null>(null);
  const [isAnnotationChoiceModalOpen, setIsAnnotationChoiceModalOpen] = useState(false);
  const [isAddTabDialogOpen, setIsAddTabDialogOpen] = useState(false);
  const [isUploadDialogOpen, setIsUploadDialogOpen] = useState(false);
  const gridScrollRef = useRef<HTMLDivElement>(null);
  const [uploadingTabId, setUploadingTabId] = useState<string>("");
  const [uploadingTabName, setUploadingTabName] = useState<string>("");
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [currentChunk, setCurrentChunk] = useState(0);
  const [totalChunks, setTotalChunks] = useState(0);
  const [uploadedCount, setUploadedCount] = useState(0);
  const [imageSearchQuery, setImageSearchQuery] = useState("");
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const navigate = useNavigate();

  // Update active tab if collections change
  useEffect(() => {
    if (imageCollections.length > 0 && !imageCollections.find(c => String(c.id) === String(activeTab))) {
      setActiveTab(String(imageCollections[0].id));
    }
  }, [imageCollections, activeTab]);

  const activeCollection = imageCollections.find(c => String(c.id) === String(activeTab));
  const allImages = imageCollections.flatMap(c => c.images);
  // Images used for modal navigation: only images in the active collection
  const activeCollectionImages = activeCollection ? activeCollection.images : allImages;

  // Filter paginated images by search query
  const getFilteredPaginatedImages = (collection: ImageCollection) => {
    if (!imageSearchQuery.trim()) return collection.paginatedImages;
    const q = imageSearchQuery.toLowerCase();
    return collection.paginatedImages.filter(img => img.fileName?.toLowerCase().includes(q));
  };

  // Open modal at clicked image index (restricted to active collection)
  const handleImageClick = (image: Image) => {
    const idx = activeCollectionImages.findIndex((img) => img.id === image.id);
    if (idx !== -1) {
      setSelectedImageIndex(idx);
      setSelectedClickedImage(image);
      setIsModalOpen(true);
    }
  };

  const handleCloseModal = () => {
    setIsModalOpen(false);
    setSelectedImageIndex(null);
    setSelectedClickedImage(null);
  };

  const handleDeleteFromModal = async (imageId: string) => {
    if (activeCollection) {
      await onDeleteImage(activeCollection.id, imageId);
      handleCloseModal();
    }
  };

  const handleAddTab = (tabName: string) => onAddTab(tabName);

  const handleRemoveTab = (tabId: string) => {
    if (imageCollections.length <= 1) return;
    onRemoveTab(tabId);
  };

  const handleTabDrop = async (targetTabId: string) => {
    if (!draggingTabId || draggingTabId === targetTabId) return;
    const orderedIds = imageCollections.map(c => String(c.id));
    const from = orderedIds.indexOf(draggingTabId);
    const to = orderedIds.indexOf(String(targetTabId));
    if (from === -1 || to === -1) return;
    const next = [...orderedIds];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setDraggingTabId(null);
    await onReorderTabs(next);
  };

  const handleUploadClick = (tabId: string) => {
    const collection = imageCollections.find(c => String(c.id) === String(tabId));
    setUploadingTabId(tabId);
    setUploadingTabName(collection?.name || "Collection");
    setIsUploadDialogOpen(true);
  };

  const handleFilesSelected = async (files: File[]) => {
    if (uploadingTabId) await onUploadImages(uploadingTabId, files);
    setIsUploadDialogOpen(false);
    setUploadingTabId("");
    setUploadingTabName("");
  };

  const handleChunkedUpload = async (files: File[]) => {
    if (!uploadingTabId) return;
    setIsUploading(true);
    setUploadProgress(0);
    setCurrentChunk(0);
    setUploadedCount(0);
    const CHUNK_SIZE = 1000;
    const totalFiles = files.length;
    const chunks = Math.ceil(totalFiles / CHUNK_SIZE);
    setTotalChunks(chunks);
    try {
      let totalUploaded = 0;
      for (let i = 0; i < chunks; i++) {
        const chunk = files.slice(i * CHUNK_SIZE, Math.min((i + 1) * CHUNK_SIZE, totalFiles));
        setCurrentChunk(i + 1);
        await onUploadImages(uploadingTabId, chunk);
        totalUploaded += chunk.length;
        setUploadedCount(totalUploaded);
        setUploadProgress(Math.round(((i + 1) / chunks) * 100));
        if (i < chunks - 1) await new Promise(r => setTimeout(r, 1000));
      }
    } finally {
      setIsUploading(false);
      setUploadProgress(0);
      setCurrentChunk(0);
      setTotalChunks(0);
      setUploadedCount(0);
    }
  };

  // Navigation handlers (restricted to active collection)
  const hasPrev = selectedImageIndex !== null && selectedImageIndex > 0;
  const hasNext = selectedImageIndex !== null && selectedImageIndex < activeCollectionImages.length - 1;
  const handlePrev = () => {
    if (hasPrev && selectedImageIndex !== null) {
      const n = selectedImageIndex - 1;
      setSelectedImageIndex(n);
      setSelectedClickedImage(activeCollectionImages[n]);
    }
  };
  const handleNext = () => {
    if (hasNext && selectedImageIndex !== null) {
      const n = selectedImageIndex + 1;
      setSelectedImageIndex(n);
      setSelectedClickedImage(activeCollectionImages[n]);
    }
  };

  const selectedImage = selectedClickedImage || (selectedImageIndex !== null ? activeCollectionImages[selectedImageIndex] : null);
  // Annotations are collection-specific; do not mirror from peer layers (RGB/depth).
  const selectedImageAnnotations = selectedImage
    ? annotations.filter((anno) => String(anno.imageId) === String(selectedImage.id))
    : [];

  const annotationsWithFileName = annotations.map((ann) => ({
    ...ann,
    annotationFileName: getAnnotationFileName(ann, annotationFiles),
  }));
  const selectedImageAnnotationsWithFile = selectedImageAnnotations.map((ann) => ({
    ...ann,
    annotationFileName: getAnnotationFileName(ann, annotationFiles),
  }));

  const existingTabNames = imageCollections.map(c => c.name);

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* Header */}
      <div className="flex-shrink-0 mb-4">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold">Image Collections</h2>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex-shrink-0 mb-4">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <div className="flex items-center gap-3 mb-4">
            <TabsList className="bg-muted/50 rounded-lg p-1 border border-border/50 h-auto">
              {imageCollections.map((collection) => (
                <div
                  key={collection.id}
                  className={`relative group ${
                    draggingTabId && draggingTabId !== String(collection.id)
                      ? 'outline-dashed outline-1 outline-primary/40 rounded-md'
                      : ''
                  } ${draggingTabId === String(collection.id) ? 'opacity-60' : ''}`}
                  onDragOver={(e) => {
                    if (draggingTabId && draggingTabId !== String(collection.id)) {
                      e.preventDefault();
                      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
                    }
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    void handleTabDrop(String(collection.id));
                  }}
                >
                  <div
                    draggable
                    onDragStart={(e) => {
                      setDraggingTabId(String(collection.id));
                      // Firefox requires dataTransfer.setData for the drag to be recognised
                      if (e.dataTransfer) {
                        e.dataTransfer.effectAllowed = 'move';
                        e.dataTransfer.setData('text/plain', String(collection.id));
                      }
                    }}
                    onDragEnd={() => setDraggingTabId(null)}
                    className="absolute left-1 top-1/2 -translate-y-1/2 z-10 cursor-grab active:cursor-grabbing text-muted-foreground/70 hover:text-foreground"
                    title="Drag to reorder layer"
                  >
                    <GripVertical className="w-3.5 h-3.5" />
                  </div>
                  <TabsTrigger 
                    value={String(collection.id)}
                    className="
                      relative pl-6 pr-5 py-2.5 rounded-md text-sm font-medium transition-all duration-200
                      data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-lg
                      data-[state=inactive]:text-muted-foreground data-[state=inactive]:hover:text-foreground
                      data-[state=inactive]:hover:bg-accent/50
                      flex items-center gap-2 min-w-0
                    "
                  >
                    <FolderOpen className="w-4 h-4 flex-shrink-0" />
                    <span className="truncate">{collection.name}</span>
                    <span className="text-xs px-1.5 py-0.5 rounded-full bg-background/20">
                      {collection.images.length}
                    </span>
                  </TabsTrigger>
                  {imageCollections.length > 1 && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-destructive/80 hover:bg-destructive text-destructive-foreground opacity-0 group-hover:opacity-100 transition-opacity duration-200"
                      onClick={(e) => { e.stopPropagation(); handleRemoveTab(collection.id); }}
                      title={`Remove ${collection.name} collection`}
                    >
                      <X className="w-3 h-3" />
                    </Button>
                  )}
                </div>
              ))}
            </TabsList>
            <Button
              variant="outline"
              onClick={() => setIsAddTabDialogOpen(true)}
              className="px-4 py-2.5 rounded-lg border-dashed border-2 border-muted-foreground/30 hover:border-primary hover:bg-primary/10 hover:text-primary text-muted-foreground transition-all duration-200 flex items-center gap-2"
              title="Add new image collection"
            >
              <Plus className="w-4 h-4" />
              <span className="text-sm font-medium">Add Collection</span>
            </Button>
          </div>

          {imageCollections.map((collection) => {
            const filteredImages = getFilteredPaginatedImages(collection);
            const totalFiltered = imageSearchQuery.trim()
              ? collection.images.filter(img => img.fileName?.toLowerCase().includes(imageSearchQuery.toLowerCase())).length
              : collection.images.length;

            return (
              <TabsContent key={collection.id} value={String(collection.id)} className="mt-0 space-y-4">
                {/* Collection Header */}
                <div className="bg-card/60 rounded-xl p-4 border border-border/40">
                  <div className="flex justify-between items-center">
                    <div className="flex items-center gap-4">
                      <div className="flex items-center gap-2">
                        <div className="w-2.5 h-2.5 bg-primary rounded-full"></div>
                        <h3 className="text-lg font-bold">{collection.name}</h3>
                      </div>
                      <span className="text-sm text-muted-foreground px-2.5 py-1 bg-muted/50 rounded-full border border-border/40">
                        {collection.images.length} {collection.images.length === 1 ? 'image' : 'images'}
                      </span>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button className="gap-2">
                          <Upload className="w-4 h-4" />
                          Upload
                          <ChevronDown className="w-4 h-4 opacity-70" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => handleUploadClick(collection.id)} className="gap-2">
                          <ImageIcon className="w-4 h-4" />
                          Upload Images
                        </DropdownMenuItem>
                        {onOpenVideoUploadDialog && (
                          <DropdownMenuItem
                            onClick={() => onOpenVideoUploadDialog(collection.id)}
                            className="gap-2"
                          >
                            <Video className="w-4 h-4" />
                            Upload Video
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>

                {/* Search + Controls */}
                <div className="flex items-center gap-4 flex-wrap">
                  <div className="relative flex-1 min-w-[200px] max-w-sm">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      placeholder="Search images by name..."
                      value={imageSearchQuery}
                      onChange={(e) => setImageSearchQuery(e.target.value)}
                      className="pl-9 h-8 text-sm"
                    />
                    {imageSearchQuery && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="absolute right-1 top-1/2 -translate-y-1/2 h-6 w-6 p-0"
                        onClick={() => setImageSearchQuery("")}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                  <ImageDisplayControls
                    imagesPerPage={imagesPerPage}
                    onImagesPerPageChange={onImagesPerPageChange}
                    imageSize={imageSize}
                    onImageSizeChange={onImageSizeChange}
                  />
                </div>

                {/* Sticky stats mini-bar */}
                <div className="sticky top-0 z-10 bg-background/90 backdrop-blur-sm border-b border-border/40 py-1.5 px-3 rounded-md text-xs text-muted-foreground flex items-center gap-3">
                  <span>
                    Showing {filteredImages.length} of {totalFiltered} images
                    {imageSearchQuery.trim() && ` matching "${imageSearchQuery}"`}
                  </span>
                  <span>•</span>
                  <span>Page {collection.currentPage} of {collection.totalPages}</span>
                </div>

                {/* Images Grid */}
                <div className="flex-1 min-h-0">
                  <div className="bg-card/20 rounded-lg border border-border/30 min-h-[400px]">
                    <ScrollArea className="h-[calc(100vh-400px)]" viewportRef={gridScrollRef}>
                      <div className="p-4">
                        <ImagesGrid
                          images={filteredImages}
                          imageSize={imageSize}
                          scrollElementRef={gridScrollRef}
                          onOpenUploadDialog={() => handleUploadClick(collection.id)}
                          onOpenVideoUploadDialog={
                            onOpenVideoUploadDialog
                              ? () => onOpenVideoUploadDialog(collection.id)
                              : undefined
                          }
                          onDeleteImage={(imageId) => onDeleteImage(collection.id, imageId)}
                          onImageClick={handleImageClick}
                          annotations={annotationsWithFileName}
                          annotationFiles={annotationFiles}
                        />
                      </div>
                    </ScrollArea>
                  </div>
                </div>

                {/* Pagination */}
                <div className="flex-shrink-0">
                  <PaginationControls
                    currentPage={collection.currentPage}
                    totalPages={collection.totalPages}
                    onPageChange={(page) => onPageChange(collection.id, page)}
                  />
                </div>
              </TabsContent>
            );
          })}
        </Tabs>
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
        imageCount={activeCollectionImages.length}
      />

      <AnnotationChoiceModal
        isOpen={isAnnotationChoiceModalOpen}
        onOpenChange={setIsAnnotationChoiceModalOpen}
        datasetId={id}
        projectId={projectId}
        collectionId={activeTab}
      />

      <AddImageTabDialog
        open={isAddTabDialogOpen}
        onOpenChange={setIsAddTabDialogOpen}
        onTabAdded={handleAddTab}
        existingTabNames={existingTabNames}
      />

      <ChunkedImageCollectionUploadDialog
        open={isUploadDialogOpen}
        onOpenChange={setIsUploadDialogOpen}
        onFilesUploaded={() => {}}
        onUploadChunk={handleChunkedUpload}
        chunkSize={1000}
        collectionName={uploadingTabName}
      />
      
      {/* Upload Progress Overlay */}
      {isUploading && (
        <div className="fixed inset-0 bg-background/50 flex items-center justify-center z-50 backdrop-blur-sm">
          <div className="bg-card p-6 rounded-lg shadow-lg max-w-md w-full mx-4 border border-border">
            <div className="text-center space-y-4">
              <div className="text-lg font-semibold">Uploading Images to {uploadingTabName}</div>
              {totalChunks > 1 && (
                <div className="text-sm text-muted-foreground">
                  Processing chunk {currentChunk} of {totalChunks}
                </div>
              )}
              <div className="space-y-2">
                <div className="w-full bg-secondary rounded-full h-2.5">
                  <div 
                    className="bg-primary h-2.5 rounded-full transition-all duration-300 ease-out" 
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>
                <div className="text-sm text-muted-foreground">
                  {uploadProgress}% complete
                  {uploadedCount > 0 && <span className="ml-2">({uploadedCount} files)</span>}
                </div>
              </div>
              <div className="text-xs text-muted-foreground">
                {totalChunks > 1 
                  ? `Uploading in ${totalChunks} chunks of 1000 files each...` 
                  : "Please wait while your images are being uploaded..."
                }
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

