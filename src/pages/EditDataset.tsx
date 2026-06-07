import { useState, useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { Navbar } from "@/components/Navbar";
import { Dataset, Image as ImageType } from "@/types";
import { useToast } from "@/hooks/use-toast";
import { useApi } from "@/hooks/use-api";
import { buildApiUrl } from "@/config/api";
import { UploadCard } from "@/components/UploadCard";
import { processCOCOAnnotations, AnnotationSample, detectAnnotationDisplayType } from "@/utils/annotations";
import { ClassStatistics } from "@/components/ClassStatistics";
import { ClassStatisticsWithManagement } from "@/components/ClassStatisticsWithManagement";
import { AnnotationVisualizer } from "@/components/AnnotationVisualizer";
import { AnnotationImagesDialog } from "@/components/AnnotationImagesDialog";
import { AnnotationsUploadDialog } from "@/components/AnnotationsUploadDialog";
import { ImageUploadDialog } from "@/components/ImageUploadDialog";
import { ChunkedImageUploadDialog } from "@/components/ChunkedImageUploadDialog";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { 
  ArrowLeft, 
  FileImage, 
  FileJson, 
  Loader2, 
  Trash2, 
  Save,
  X,
  Pencil,
  Tag,
  Upload,
  ChevronLeft,
  ChevronRight,
  Brush,
  Copy
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogHeader,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import {
  Badge,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getMockDataset } from "@/utils/mockData";

interface AnnotationFile {
  id: number | string; // Allow both number and string IDs
  fileName: string;
  fileSize: number;
  uploadedAt: string;
  type: string;
  classStats: Array<{
    className: string;
    count: number;
    color: string;
  }>;
  samples: Array<{
    id: string;
    imageUrl: string;
    thumbnailUrl: string;
    className?: string;
    segmentation?: number[][];
    bbox?: [number, number, number, number];
    imageId?: string;
  }>;
  tags: string[];
  annotation_count: number;
  processing_status?: string;
}

interface EditDatasetProps {
  projectMode?: boolean;
}

const EditDataset = ({ projectMode = false }: EditDatasetProps) => {
  const { id, projectId } = useParams<{ id: string; projectId?: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { api } = useApi(); // Add the useApi hook here

  const detectAnnotationType = (file: AnnotationFile) =>
    detectAnnotationDisplayType({
      id: String(file.id),
      name: file.fileName,
      date: file.uploadedAt,
      format: 'COCO',
      type: file.type as any,
      classCount: file.classStats?.length || 0,
      imageCount: 0,
      matchedImageCount: 0,
      datasetId: id || '',
      samples: file.samples as any,
    });

  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState("images");
  
  const [images, setImages] = useState<ImageType[]>([]);
  const [annotations, setAnnotations] = useState<AnnotationFile[]>([]);
  
  const [selectedImage, setSelectedImage] = useState<ImageType | null>(null);
  const [selectedAnnotation, setSelectedAnnotation] = useState<AnnotationFile | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const [newFilename, setNewFilename] = useState("");
  const [showAnnotationsOnImage, setShowAnnotationsOnImage] = useState<AnnotationSample[]>([]);
  const [showFullSizeImage, setShowFullSizeImage] = useState(false);
  
  const [showAnnotationsDialog, setShowAnnotationsDialog] = useState(false);
  const [annotationsToShow, setAnnotationsToShow] = useState<AnnotationSample[]>([]);
  const [annotationFileNameToShow, setAnnotationFileNameToShow] = useState("");
  const [showUploadDialog, setShowUploadDialog] = useState(false);
  const [showImageUploadDialog, setShowImageUploadDialog] = useState(false);
  const [showChunkedUploadDialog, setShowChunkedUploadDialog] = useState(false);

  const [imageDimensions, setImageDimensions] = useState({ width: 800, height: 600 });

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [augmentedDatasets, setAugmentedDatasets] = useState<{ id: number; name: string }[]>([]);
  const [deleteAugmented, setDeleteAugmented] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const imagesPerPage = 20;

  const normalizeAnnotationId = (value: unknown) => String(value ?? "");

  const transformAnnotationFiles = (apiAnnotations: any[]): AnnotationFile[] =>
    apiAnnotations.map((apiAnnotation: any) => {
      return {
        id: apiAnnotation.id,
        fileName: apiAnnotation.name || apiAnnotation.fileName,
        fileSize: apiAnnotation.size || apiAnnotation.fileSize || 0,
        uploadedAt: apiAnnotation.created_at || apiAnnotation.uploadedAt || new Date().toISOString(),
        type: apiAnnotation.type,
        classStats: [],
        samples: [],
        tags: apiAnnotation.tags || [],
        annotation_count: apiAnnotation.annotation_count || 0,
        processing_status: apiAnnotation.processing_status,
      };
    });

  // Polling function to check for processing completion
  const pollForProcessingCompletion = async (annotationIds: Array<number | string>) => {
    let attempts = 0;
    const maxAttempts = 30; // Poll for up to 5 minutes (30 * 10 seconds)
    
    const poll = async () => {
      if (attempts >= maxAttempts) {
        toast({
          title: "Processing taking longer than expected",
          description: "Please refresh the page manually to see updated counts.",
          variant: "default",
        });
        return;
      }
      
      try {
        if (!api) {
          console.warn('API not available for polling');
          return;
        }
        
        const annotationsRes = await api.getAnnotations(id);
        if (annotationsRes?.success && annotationsRes.data) {
          const currentAnnotations = transformAnnotationFiles(annotationsRes.data);
          const targetIds = new Set(annotationIds.map(normalizeAnnotationId));
          
          // Check if the target annotations are still processing
          const stillProcessing = currentAnnotations.filter(
            ann => targetIds.has(normalizeAnnotationId(ann.id)) &&
                   (ann.processing_status === 'pending' || ann.processing_status === 'processing')
          );
          
          // Update the state with latest data
          setAnnotations(currentAnnotations);
          
          if (stillProcessing.length === 0) {
            // All target annotations are done processing
            toast({
              title: "Processing complete",
              description: "Annotation counts have been updated.",
            });
            return;
          } else {
            // Still processing, continue polling
            attempts++;
            setTimeout(poll, 10000); // Poll every 10 seconds
          }
        }
      } catch (error) {
        console.warn('Error during polling:', error);
        attempts++;
        setTimeout(poll, 10000);
      }
    };
    
    // Start polling
    setTimeout(poll, 5000); // Wait 5 seconds before first poll
  };
  
  // Calculate pagination
  const totalPages = Math.ceil((images?.length || 0) / imagesPerPage);
  const paginatedImages = images.slice(
    (currentPage - 1) * imagesPerPage,
    currentPage * imagesPerPage
  );

  useEffect(() => {
    const fetchData = async () => {
      if (!id) {
        setLoading(false);
        return;
      }

      try {
        if (api) {
          console.log('🌐 API client available, making requests...');
          // Load real dataset data
          const [datasetRes, imagesRes, annotationsRes] = await Promise.all([
            api.getDataset(id),
            api.getImages(id),
            api.getAnnotations(id)
          ]);
          
          console.log('🌐 API responses received:', { datasetRes: !!datasetRes, imagesRes: !!imagesRes, annotationsRes: !!annotationsRes });
          
          if (datasetRes?.success && datasetRes.data) {
            const data = datasetRes.data;
            if (!projectId && data.project_id != null) {
              navigate(`/projects/${data.project_id}/datasets/${id}/edit`, { replace: true });
              return;
            }
            setDataset(data);
          } else {
            // Fallback to mock data if API fails
            setDataset(getMockDataset(id));
          }
          
          if (imagesRes?.success && imagesRes.data) {
            setImages(imagesRes.data);
          }
          
          if (annotationsRes?.success && annotationsRes.data) {
            console.log('🔍 Raw annotations API response:', annotationsRes.data);
            console.log('🔍 Response type:', typeof annotationsRes.data);
            console.log('🔍 Is array:', Array.isArray(annotationsRes.data));
            console.log('🔍 First item keys:', annotationsRes.data[0] ? Object.keys(annotationsRes.data[0]) : 'No items');
            
            // Transform API response to match our AnnotationFile type
            const annotationsWithCoverage = transformAnnotationFiles(annotationsRes.data).map((transformed, index) => {
              const apiAnnotation = annotationsRes.data[index];
              console.log(`🔍 Processing annotation ${index}:`, apiAnnotation);
              console.log(`🔍 annotation_count field:`, apiAnnotation.annotation_count);
              console.log(`🔍 annotation_count type:`, typeof apiAnnotation.annotation_count);
              console.log(`🔍 All fields:`, Object.keys(apiAnnotation));
              console.log('🔍 Transformed annotation:', transformed);
              console.log('🔍 Final annotation_count in transformed:', transformed.annotation_count);
              return transformed;
            });
            
            setAnnotations(annotationsWithCoverage);
          }
        } else {
          // Fallback to mock data if no API
          setDataset(getMockDataset(id));
        }
      } catch (error) {
        console.error('Error loading dataset data:', error);
        // Fallback to mock data on error
        setDataset(getMockDataset(id));
        toast({
          variant: "destructive",
          title: "Loading error",
          description: "Failed to load dataset data, using offline mode.",
        });
      }
      
      setLoading(false);
    };
    
    fetchData();
    // projectId must be included: short URL /datasets/:id/edit redirects to /projects/:pid/datasets/:id/edit
    // and returns before loading annotations; without projectId in deps the effect never re-runs after redirect.
  }, [id, projectId, toast, navigate, api]);

  // Load class statistics from same API as Dataset Annotations view so numbers match
  const selectedAnnotationId = selectedAnnotation?.id;
  useEffect(() => {
    if (!selectedAnnotationId || !api || !id) return;
    if (selectedAnnotation?.classStats && selectedAnnotation.classStats.length > 0) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.getAnnotationClasses(id, String(selectedAnnotationId));
        if (cancelled || !res?.success || !res.data?.classes) return;
        const classStats = res.data.classes.map((c: { className: string; count: number; color?: string; opacity?: number }) => ({
          className: c.className,
          count: c.count ?? 0,
          color: c.color ?? "#ea384c",
          opacity: c.opacity ?? 0.25,
        }));
        setSelectedAnnotation(prev => prev && prev.id === selectedAnnotationId ? { ...prev, classStats } : null);
        setAnnotations(prev =>
          prev.map(anno => anno.id === selectedAnnotationId ? { ...anno, classStats } : anno)
        );
      } catch (e) {
        if (!cancelled) console.warn("Failed to load annotation classes:", e);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedAnnotationId, selectedAnnotation?.classStats?.length, api, id]);

  const handleChunkedImageUpload = async (files: File[]) => {
    if (!api || !id) return;

    const formData = new FormData();
    files.forEach(file => {
      formData.append('files', file);
    });

    try {
      const result = await api.uploadImages(id, formData);
      if (result.success) {
        // Refresh images list
        // Refresh by fetching dataset again which includes images
        if (api) {
          const result = await api.getDataset(id);
          if (result.success && result.data) {
            // Dataset API doesn't return images, so this would need a separate API call
          }
        }
      }
    } catch (error) {
      console.error('Failed to upload chunk:', error);
      throw error;
    }
  };

  const handleImageUpload = (files: File[]) => {
    const newImages: ImageType[] = [];

    const tifToPng = async (file: File): Promise<string | null> => {
      // try dynamic import of utif; fallback to null if not available
      try {
  // Use global UTIF loaded from CDN (index.html). If it's missing, skip conversion.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const globalAny: any = window as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const UTIF = globalAny.UTIF as any;
  if (!UTIF) return null;
        const arrayBuffer = await file.arrayBuffer();
        const ifds = UTIF.decode(arrayBuffer);
        if (!ifds || ifds.length === 0) return null;
        UTIF.decodeImage(arrayBuffer, ifds[0]);
        const rgba = UTIF.toRGBA8(ifds[0]);
        const width = ifds[0].width;
        const height = ifds[0].height;

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        const imageData = new ImageData(new Uint8ClampedArray(rgba), width, height);
        ctx.putImageData(imageData, 0, 0);
        return canvas.toDataURL('image/png');
      } catch (e) {
        // utif not available or decode failed
        console.warn('TIFF conversion failed or utif not installed:', e);
        return null;
      }
    };

    const buildImageObject = async (file: File) => {
      let imageUrl = URL.createObjectURL(file);
      const lower = file.name.toLowerCase();
      if (file.type === 'image/tiff' || lower.endsWith('.tif') || lower.endsWith('.tiff')) {
        const converted = await tifToPng(file);
        if (converted) imageUrl = converted;
      }

      return {
        id: Math.random().toString(36).substring(2, 11),
        datasetId: id || "",
        fileName: file.name,
        fileSize: file.size,
        width: 1920,
        height: 1080,
        url: imageUrl,
        thumbnailUrl: imageUrl,
        uploadedAt: new Date().toISOString(),
        annotationsCount: 0,
      } as ImageType;
    };

    // build images in sequence to avoid blocking too many conversions in parallel
    (async () => {
      for (const file of files) {
        const imgObj = await buildImageObject(file);
        newImages.push(imgObj);
        setImages(prev => [...prev, imgObj]);
      }
    })();
    
  // images are appended asynchronously above; no-op here
    
    if (dataset) {
      setDataset({
        ...dataset,
        image_count: (dataset.image_count || 0) + files.length,
      });
    }
    
    toast({
      title: "Images added",
      description: `${files.length} images added successfully.`,
    });
  };

  const handleAnnotationUpload = async (files: File[]) => {
    if (!id) return;

    toast({
      title: "Importing annotations",
      description: "Processing COCO annotation files...",
    });
    
    try {
      if (!api) {
        throw new Error('API client not available');
      }

      for (const file of files) {
        console.log(`Importing annotation file: ${file.name}`);
        const result = await api.importAnnotations(id, file);
        
        if (result.success && result.data) {
          const { imported, skipped, message, file_id } = result.data;
          
          // Update the annotations count in the dataset  
          if (dataset) {
            setDataset({
              ...dataset,
              annotation_count: (dataset.annotation_count || 0) + imported,
            });
          }
          
          toast({
            title: "Annotations imported",
            description: message || `Imported ${imported} annotations, skipped ${skipped}`,
          });
        } else {
          throw new Error(result.error || 'Failed to import annotations');
        }
      }
      
      // Refresh the annotations list after all imports are complete
      // Wait for processing to complete before showing final results
      try {
        const refreshedAnnotationsRes = await api.getAnnotations(id);
        if (refreshedAnnotationsRes?.success && refreshedAnnotationsRes.data) {
          console.log('Refreshed annotations API response:', refreshedAnnotationsRes.data);
          // Transform API response to match our AnnotationFile type
          const refreshedAnnotations = transformAnnotationFiles(refreshedAnnotationsRes.data);
          setAnnotations(refreshedAnnotations);
          
          // Check if any annotations are still processing
          const processingAnnotations = refreshedAnnotations.filter(
            ann => ann.processing_status === 'pending' || ann.processing_status === 'processing'
          );
          
          if (processingAnnotations.length > 0) {
            toast({
              title: "Processing annotations",
              description: `${processingAnnotations.length} annotation file(s) are still being processed. Counts will update automatically.`,
            });
            
            // Poll for processing completion
            pollForProcessingCompletion(processingAnnotations.map(a => a.id));
          }
        }
      } catch (refreshError) {
        console.warn('Failed to refresh annotations list:', refreshError);
      }
    } catch (error) {
      console.error("Error importing annotations:", error);
      toast({
        variant: "destructive",
        title: "Import failed",
        description: error instanceof Error ? error.message : "There was an error importing the annotation files.",
      });
    }
  };

  const handleDeleteImage = (image: ImageType) => {
    setImages(prevImages => prevImages.filter(img => img.id !== image.id));
    
    if (dataset) {
      setDataset({
        ...dataset,
        image_count: Math.max(0, (dataset.image_count || 0) - 1),
      });
    }
    
    if (selectedImage && selectedImage.id === image.id) {
      setSelectedImage(null);
    }
    
    toast({
      title: "Image deleted",
      description: `${image.fileName} has been removed.`,
    });
  };

  const handleDeleteAnnotation = (annotation: AnnotationFile) => {
    // Use the annotation_count from database instead of calculating from classStats
    const annotationCount = annotation.annotation_count || annotation.classStats?.reduce((acc, stat) => acc + stat.count, 0) || 0;
    
    setAnnotations(prevAnnotations => 
      prevAnnotations.filter(anno => anno.id !== annotation.id)
    );
    
    if (dataset) {
      setDataset({
        ...dataset,
        annotation_count: Math.max(0, (dataset.annotation_count || 0) - annotationCount),
      });
    }
    
    if (selectedAnnotation && selectedAnnotation.id === annotation.id) {
      setSelectedAnnotation(null);
    }
    
    if (annotation.samples && annotation.samples.length > 0 && 
        showAnnotationsOnImage.some(showAnno => 
          annotation.samples?.some(sample => sample.id === showAnno.id)
        )) {
      setShowAnnotationsOnImage([]);
    }
    
    toast({
      title: "Annotation deleted",
      description: `${annotation.fileName} has been removed.`,
    });
  };

  const handleDuplicateAnnotation = async (annotation: AnnotationFile) => {
    if (!id || !api) {
      toast({
        title: "Error",
        description: "Cannot duplicate annotation: API not available",
        variant: "destructive",
      });
      return;
    }

    try {
      // Generate new name for the copy
      const baseName = annotation.fileName.replace(/\.[^/.]+$/, ""); // Remove extension
      const extension = annotation.fileName.includes('.') ? annotation.fileName.substring(annotation.fileName.lastIndexOf('.')) : '.json';
      let copyIndex = 2;
      let newName = `${baseName}_copy${extension}`;
      
      // Ensure unique name
      while (annotations.some(a => a.fileName === newName)) {
        newName = `${baseName}_copy${copyIndex}${extension}`;
        copyIndex++;
      }

      toast({
        title: "Duplicating annotation...",
        description: `Creating copy: ${newName}`,
      });

      // Get the annotation content from backend
      const contentResponse = await api.getAnnotationContent(id, String(annotation.id));
      
      if (!contentResponse.success || !contentResponse.data) {
        throw new Error("Failed to load annotation content");
      }
      const cd = contentResponse.data;
      if (cd.is_processing || cd.is_large) {
        throw new Error(cd.message || "Annotation file is not available as a full download yet.");
      }
      const rawC = cd.content;
      const contentJson =
        typeof rawC === "string" ? rawC : rawC != null ? JSON.stringify(rawC) : null;
      if (!contentJson) {
        throw new Error("Failed to load annotation content");
      }

      // Parse and re-upload as new file
      const cocoData = JSON.parse(contentJson);
      const jsonContent = JSON.stringify(cocoData, null, 2);
      const file = new File([jsonContent], newName, { type: 'application/json' });
      
      const uploadResponse = await api.importAnnotations(id, file);
      
      if (!uploadResponse.success) {
        throw new Error(uploadResponse.error || "Failed to upload duplicated annotation");
      }

      // Refresh annotations list
      const annotationsResponse = await api.getAnnotations(id);
      if (annotationsResponse.success && annotationsResponse.data) {
        setAnnotations(annotationsResponse.data);
        
        // Update dataset annotation count
        if (dataset && annotation.annotation_count) {
          setDataset({
            ...dataset,
            annotation_count: (dataset.annotation_count || 0) + annotation.annotation_count,
          });
        }
      }

      toast({
        title: "Annotation duplicated",
        description: `Created copy: ${newName}`,
      });
    } catch (error) {
      console.error("Error duplicating annotation:", error);
      toast({
        title: "Duplication failed",
        description: error instanceof Error ? error.message : "Failed to duplicate annotation file",
        variant: "destructive",
      });
    }
  };

  const handleRenameAnnotation = async () => {
    if (!selectedAnnotation || !newFilename.trim()) return;
    
    try {
      if (!api) {
        throw new Error('API client not available');
      }

      // Call the backend API to rename the annotation file
      const result = await api.renameAnnotation(id, String(selectedAnnotation.id), newFilename.trim());
      
      if (result.success) {
        // Update local state only after successful backend update
        setAnnotations(prevAnnotations => 
          prevAnnotations.map(anno => 
            anno.id === selectedAnnotation.id 
              ? { ...anno, fileName: newFilename.trim() } 
              : anno
          )
        );
        
        setSelectedAnnotation(prev => prev ? { ...prev, fileName: newFilename.trim() } : null);
        setIsRenaming(false);
        setNewFilename("");
        
        toast({
          title: "Annotation renamed",
          description: result.data?.message || "Filename has been updated successfully.",
        });
      } else {
        throw new Error(result.error || 'Failed to rename annotation file');
      }
    } catch (error) {
      console.error("Error renaming annotation:", error);
      toast({
        variant: "destructive",
        title: "Rename failed",
        description: error instanceof Error ? error.message : "There was an error renaming the annotation file.",
      });
    }
  };

  const handleSave = async () => {
    setSaving(true);
    
    try {
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      toast({
        title: "Dataset saved",
        description: "All changes have been saved successfully.",
      });
      
      // Refresh the page by navigating to the same URL
      window.location.reload();
    } catch (error) {
      console.error("Error saving dataset:", error);
      toast({
        variant: "destructive",
        title: "Save failed",
        description: "There was an error saving your changes. Please try again.",
      });
    } finally {
      setSaving(false);
    }
  };

  const openDeleteConfirm = async () => {
    if (!dataset) return;
    
    // Check for augmented datasets
    try {
      const response = await fetch(buildApiUrl(`/datasets/${dataset.id}/augmented-datasets`));
      if (response.ok) {
        const result = await response.json();
        setAugmentedDatasets(result.augmented_datasets || []);
      } else {
        setAugmentedDatasets([]);
      }
    } catch (error) {
      setAugmentedDatasets([]);
    }
    
    setDeleteAugmented(false);
    setShowDeleteConfirm(true);
  };

  const handleDeleteDataset = async () => {
    if (!dataset) return;
    
    setIsDeleting(true);
    try {
      const response = await fetch(
        buildApiUrl(`/datasets/${dataset.id}`, deleteAugmented ? { delete_augmented: "true" } : undefined),
        { method: "DELETE" },
      );
      
      if (response.ok) {
        const result = await response.json();
        toast({
          title: 'Dataset Deleted',
          description: result.deleted_count > 1 
            ? `Successfully deleted ${result.deleted_count} datasets.`
            : 'Dataset and all associated data have been removed.',
        });

        // Navigate back to the appropriate page
        if (projectId) {
          navigate(`/projects/${projectId}/datasets`);
        } else {
          navigate('/');
        }
      } else {
        const error = await response.json();
        throw new Error(error.detail || 'Failed to delete dataset');
      }
    } catch (error) {
      console.error('Error deleting dataset:', error);
      toast({
        variant: 'destructive',
        title: 'Delete failed',
        description: error instanceof Error ? error.message : 'There was an error deleting the dataset.',
      });
    } finally {
      setIsDeleting(false);
      setShowDeleteConfirm(false);
      setAugmentedDatasets([]);
    }
  };

  const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    setImageDimensions({
      width: img.naturalWidth,
      height: img.naturalHeight
    });
  };

  const handleAnnotate = () => {
    if (!id) return;
    window.open(`/datasets/${id}/annotate`, '_blank');
  };

  const handleEditSegmentationAnnotation = (annotation: AnnotationFile, e: React.MouseEvent) => {
    e.stopPropagation();
    
    console.log('Edit segmentation clicked for annotation:', annotation);
    const annotationType = detectAnnotationType(annotation);
    console.log('Detected annotation type:', annotationType);
    
    if (annotationType.startsWith('Segmentation')) {
      // Clear annotation cache before editing
      const clearAnnotationCache = (annotationType: 'classification' | 'segmentation') => {
        console.log(`Clearing ${annotationType} annotation cache before editing...`);
        
        const keysToRemove: string[] = [];
        const prefixes = annotationType === 'classification' 
          ? [`classifications_${id}_`, `classColors_${id}`, `annotation_settings_${id}`]
          : [`annotations_${id}_`, `classes_${id}`, `annotation_settings_${id}`];
        
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && prefixes.some(prefix => key.startsWith(prefix))) {
            keysToRemove.push(key);
          }
        }
        
        // Remove all identified keys
        keysToRemove.forEach(key => {
          localStorage.removeItem(key);
          console.log(`Cleared cache key: ${key}`);
        });
        
        if (keysToRemove.length > 0) {
          toast({
            title: "Cache cleared",
            description: `Cleared ${keysToRemove.length} cached ${annotationType} entries for fresh editing.`,
          });
        }
        
        return keysToRemove.length;
      };
      
      // Clear all existing annotation cache to start fresh
      clearAnnotationCache('segmentation');
      
      // Navigate to segmentation page with the dataset ID and annotation file ID
      const url = `/datasets/${id}/annotate/segmentation?annotationId=${annotation.id}`;
      console.log('Navigating to:', url);
      
      toast({
        title: "Opening Segmentation Editor",
        description: `Opening annotation "${annotation.fileName}" in segmentation editor.`,
      });
      
      // Try both window.open and navigation
      const newTab = window.open(url, '_blank');
      if (!newTab) {
        // If popup was blocked, try direct navigation
        console.log('Popup blocked, trying direct navigation');
        window.location.href = url;
      }
    } else {
      console.log('Not a segmentation file, type:', annotationType);
      toast({
        title: "Not a segmentation file",
        description: "This annotation file is not a segmentation type and cannot be edited in the segmentation editor.",
        variant: "destructive",
      });
    }
  };

  // Class management handlers
  const handleRenameClass = async (oldClassName: string, newClassName: string) => {
    if (!selectedAnnotation || !id) return;
    try {
      let serverClasses: Array<{ className: string; count: number; color: string; opacity?: number }> | undefined;
      if (api) {
        const response = await api.renameAnnotationClass(
          id,
          String(selectedAnnotation.id),
          oldClassName,
          newClassName
        );
        if (!response.success) throw new Error(response.error || "Failed to rename class on server");
        serverClasses = response.data?.classes;
      }
      const updatedClassStats = serverClasses?.length
        ? serverClasses.map(c => ({
            className: c.className,
            count: c.count ?? 0,
            color: c.color ?? "#ea384c",
            opacity: c.opacity ?? 0.25,
          }))
        : selectedAnnotation.classStats?.map(stat =>
            stat.className === oldClassName
              ? { ...stat, className: newClassName, count: stat.count ?? 0 }
              : { ...stat, count: stat.count ?? 0 }
          );
      const updatedAnnotation = {
        ...selectedAnnotation,
        classStats: updatedClassStats,
        samples: selectedAnnotation.samples?.map(sample =>
          sample.className === oldClassName ? { ...sample, className: newClassName } : sample
        ),
      };
      setSelectedAnnotation(updatedAnnotation);
      setAnnotations(prev =>
        prev.map(anno => anno.id === selectedAnnotation.id ? updatedAnnotation : anno)
      );
      toast({ title: "Class renamed", description: `"${oldClassName}" renamed to "${newClassName}".` });
    } catch (error) {
      console.error("Error renaming class:", error);
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to rename class",
        variant: "destructive",
      });
    }
  };

  const handleDeleteClass = async (className: string) => {
    if (!selectedAnnotation || !id) return;
    
    try {
      if (api) {
        const response = await api.deleteClassAnnotations(
          id,
          String(selectedAnnotation.id),
          className
        );
        
        if (!response.success) {
          throw new Error(response.error || "Failed to delete class");
        }
        
        // Update local state with the server response
        const updatedAnnotation = {
          ...selectedAnnotation,
          classStats: selectedAnnotation.classStats?.filter(stat => stat.className !== className),
          samples: selectedAnnotation.samples?.filter(sample => sample.className !== className),
          annotation_count: response.data?.remaining_annotations || 0,
          category_count: response.data?.remaining_classes || 0
        };
        
        setSelectedAnnotation(updatedAnnotation);
        setAnnotations(prev => 
          prev.map(anno => anno.id === selectedAnnotation.id ? updatedAnnotation : anno)
        );
        
        toast({
          title: "Class deleted",
          description: `Deleted ${response.data?.deleted_count || 0} annotations for "${className}"`
        });
      } else {
        // Fallback to local state only if no API
        const updatedAnnotation = {
          ...selectedAnnotation,
          classStats: selectedAnnotation.classStats?.filter(stat => stat.className !== className),
          samples: selectedAnnotation.samples?.filter(sample => sample.className !== className)
        };
        
        setSelectedAnnotation(updatedAnnotation);
        setAnnotations(prev => 
          prev.map(anno => anno.id === selectedAnnotation.id ? updatedAnnotation : anno)
        );
        
        toast({
          title: "Class deleted",
          description: `All annotations for "${className}" have been removed`
        });
      }
    } catch (error) {
      console.error("Error deleting class:", error);
      toast({
        variant: "destructive",
        title: "Delete failed",
        description: error instanceof Error ? error.message : "Failed to delete class"
      });
    }
  };

  const handleMergeClasses = (sourceClassName: string, targetClassName: string) => {
    if (!selectedAnnotation) return;
    
    const updatedAnnotation = {
      ...selectedAnnotation,
      classStats: selectedAnnotation.classStats?.map(stat => {
        if (stat.className === targetClassName) {
          const sourceCount = selectedAnnotation.classStats?.find(s => s.className === sourceClassName)?.count || 0;
          return { ...stat, count: stat.count + sourceCount };
        }
        return stat;
      }).filter(stat => stat.className !== sourceClassName),
      samples: selectedAnnotation.samples?.map(sample =>
        sample.className === sourceClassName
          ? { ...sample, className: targetClassName }
          : sample
      )
    };
    
    setSelectedAnnotation(updatedAnnotation);
    setAnnotations(prev => 
      prev.map(anno => anno.id === selectedAnnotation.id ? updatedAnnotation : anno)
    );
    
    toast({
      title: "Classes merged",
      description: `"${sourceClassName}" has been merged into "${targetClassName}"`
    });
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-black text-white">
        <Navbar />
        <div className="container max-w-7xl pt-32 flex justify-center items-center">
          <div className="flex flex-col items-center">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="mt-4 text-muted-foreground">Loading dataset...</p>
          </div>
        </div>
      </div>
    );
  }

  if (!dataset) {
    return (
      <div className="min-h-screen bg-black text-white">
        <Navbar />
        <div className="container max-w-7xl pt-32 text-center">
          <h1 className="text-2xl font-bold mb-4">Dataset not found</h1>
          <p className="text-muted-foreground mb-6">
            The dataset you're looking for doesn't exist or has been deleted.
          </p>
          <Button asChild>
            <Link to="/datasets">Return to datasets</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen pb-20 bg-black text-white">
      <Navbar />
      
      <div className="bg-gray-900 py-4 border-b border-gray-800 mt-16">
        <div className="container max-w-7xl">
          <div className="flex items-center">
            <Button 
              variant="ghost" 
              asChild 
              className="mr-2 text-gray-300 hover:text-white hover:bg-gray-800"
            >
              <Link to={projectId ? `/projects/${projectId}/datasets/${id}` : `/datasets/${id}`}>
                <ArrowLeft className="mr-1 h-4 w-4" /> Back
              </Link>
            </Button>
            <h1 className="text-xl font-semibold flex-1 text-white">
              Edit: {dataset?.name}
            </h1>
            <div className="flex items-center gap-2">
              <Button
                variant="destructive"
                onClick={openDeleteConfirm}
                disabled={saving}
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Delete Dataset
              </Button>
              <Button 
                onClick={handleSave} 
                disabled={saving}
                className="bg-blue-600 hover:bg-blue-700"
              >
                {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                Save Changes
              </Button>
            </div>
          </div>
        </div>
      </div>
      
      <main className="container max-w-7xl py-8">
        <div className="flex flex-col gap-6">
          <Card className="bg-gray-900 border-gray-800">
            <CardContent className="p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-semibold text-white">Dataset Content</h2>
                <div className="text-sm text-gray-400">
                  {images.length} images • {dataset?.annotation_count} annotations
                </div>
              </div>
              
              <Tabs 
                value={activeTab} 
                onValueChange={setActiveTab}
                className="text-white"
              >
                <TabsList className="w-full justify-start gap-1 bg-gray-800/50 p-2 border-b border-gray-700">
                  <TabsTrigger 
                    value="images"
                    className="data-[state=active]:bg-blue-600 data-[state=active]:text-white px-6 py-2.5 text-base"
                  >
                    <FileImage className="h-4 w-4 mr-2" />
                    Images
                  </TabsTrigger>
                  <TabsTrigger 
                    value="annotations"
                    className="data-[state=active]:bg-blue-600 data-[state=active]:text-white px-6 py-2.5 text-base"
                  >
                    <FileJson className="h-4 w-4 mr-2" />
                    Annotations
                  </TabsTrigger>
                </TabsList>
                
                <TabsContent value="images" className="space-y-4">
                  <div className="flex justify-between items-center mb-6">
                    <h3 className="text-lg font-medium text-white">
                      Image Gallery
                      <span className="ml-2 text-sm font-normal text-gray-400">
                        {images.length} images
                      </span>
                    </h3>
                    <div className="flex gap-2">
                      <Button 
                        onClick={() => setShowImageUploadDialog(true)}
                        size="sm"
                        variant="outline"
                      >
                        <Upload className="h-4 w-4 mr-2" /> Add Images
                      </Button>
                      <Button 
                        onClick={() => setShowChunkedUploadDialog(true)}
                        size="sm"
                        className="bg-blue-600 hover:bg-blue-700"
                      >
                        <Upload className="h-4 w-4 mr-2" /> Bulk Upload
                      </Button>
                    </div>
                  </div>
                  
                  {images.length > 0 ? (
                    <div className="space-y-4">
                      <div className="h-[65vh] overflow-y-auto rounded-lg border border-gray-700 bg-gray-800/50">
                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 lg:grid-cols-6 gap-3 p-3">
                          {paginatedImages.map((image) => (
                            <div 
                              key={image.id}
                              onClick={() => {
                                setSelectedImage(image);
                                setShowFullSizeImage(false); // Reset to thumbnail when opening dialog
                              }}
                              className="cursor-pointer relative group rounded-md overflow-hidden border border-gray-700 bg-gray-800 hover:border-blue-500/50 transition-colors"
                            >
                              <div className="aspect-square relative">
                                <img 
                                  src={image.thumbnailUrl} 
                                  alt={image.fileName} 
                                  className="w-full h-full object-cover"
                                  loading="lazy"
                                />
                                {showAnnotationsOnImage.length > 0 && 
                                 showAnnotationsOnImage.some(anno => anno.imageId === image.id) && (
                                  <div className="absolute top-2 right-2">
                                    <Badge variant="secondary" className="bg-blue-600/70 backdrop-blur-sm">
                                      <Tag className="h-3 w-3 mr-1" />
                                      {showAnnotationsOnImage.filter(anno => anno.imageId === image.id).length}
                                    </Badge>
                                  </div>
                                )}
                              </div>
                              <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
                                <Button 
                                  variant="destructive" 
                                  size="icon" 
                                  className="h-8 w-8"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleDeleteImage(image);
                                  }}
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                      
                      <div className="flex justify-between items-center mt-4">
                        <Button 
                          variant="ghost" 
                          size="icon"
                          className="text-white hover:text-white hover:bg-gray-800"
                          disabled={currentPage === 1}
                          onClick={() => setCurrentPage(currentPage - 1)}
                        >
                          <ChevronLeft className="h-5 w-5" />
                        </Button>
                        <span className="text-sm text-gray-400">
                          Page {currentPage} of {totalPages}
                        </span>
                        <Button 
                          variant="ghost" 
                          size="icon"
                          className="text-white hover:text-white hover:bg-gray-800"
                          disabled={currentPage === totalPages}
                          onClick={() => setCurrentPage(currentPage + 1)}
                        >
                          <ChevronRight className="h-5 w-5" />
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center bg-gray-800 rounded-lg p-12 text-center">
                      <FileImage className="h-12 w-12 text-gray-400 mb-4" />
                      <h4 className="text-lg font-medium text-white">No images yet</h4>
                      <p className="text-gray-400 mt-1 mb-4">
                        Click the "Add Images" button to get started
                      </p>
                      <div className="flex gap-2">
                        <Button 
                          onClick={() => setShowImageUploadDialog(true)}
                          variant="outline"
                        >
                          <Upload className="h-4 w-4 mr-2" /> Add Images
                        </Button>
                        <Button 
                          onClick={() => setShowChunkedUploadDialog(true)}
                          className="bg-blue-600 hover:bg-blue-700"
                        >
                          <Upload className="h-4 w-4 mr-2" /> Bulk Upload
                        </Button>
                      </div>
                    </div>
                  )}
                  
                </TabsContent>
                
                <TabsContent value="annotations" className="space-y-4">
                  <div className="flex justify-between items-center">
                    <h2 className="text-xl font-semibold">Annotations</h2>
                    <div className="flex gap-2">
                      <Button 
                        onClick={handleAnnotate}
                        size="sm"
                        className="bg-blue-600 hover:bg-blue-700"
                      >
                        <Pencil className="h-4 w-4 mr-1" />
                        Annotate Images
                      </Button>
                      <Button 
                        onClick={() => setShowUploadDialog(true)}
                        size="sm"
                        className="bg-blue-600 hover:bg-blue-700"
                      >
                        <Upload className="h-4 w-4 mr-1" /> Add Annotations
                      </Button>
                    </div>
                  </div>
                  
                  {annotations.length > 0 ? (
                    <div className="border border-gray-700 rounded-md max-h-[500px] overflow-y-auto mb-6">
                      <Table>
            <TableHeader className="bg-gray-800">
                          <TableRow className="border-b-gray-700">
                            <TableHead className="text-gray-300">Filename</TableHead>
              <TableHead className="text-gray-300">Type</TableHead>
                            <TableHead className="text-gray-300">Size</TableHead>
                            <TableHead className="text-gray-300">Date</TableHead>
                            <TableHead className="text-gray-300">Tags</TableHead>
                            <TableHead className="text-gray-300">Classes</TableHead>
                            <TableHead className="text-gray-300">Annotations</TableHead>
                            <TableHead className="text-gray-300">Images</TableHead>
                            <TableHead className="w-[130px] text-gray-300">Actions</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {annotations.map((annotation) => (
                            <TableRow 
                              key={annotation.id}
                              className="cursor-pointer border-b-gray-700 hover:bg-gray-800"
                              onClick={() => setSelectedAnnotation(annotation)}
                            >
                              <TableCell className="font-medium text-white">
                                {annotation.fileName}
                              </TableCell>
                              <TableCell className="text-gray-300">
                                {annotation.type ? (
                                  <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-gray-700 text-gray-200 capitalize">
                                    {annotation.type}
                                  </span>
                                ) : (
                                  <span className="text-xs text-gray-500">unknown</span>
                                )}
                              </TableCell>
                              <TableCell className="text-gray-300">
                                {(annotation.fileSize / 1024).toFixed(1)} KB
                              </TableCell>
                              <TableCell className="text-gray-300">
                                {new Date(annotation.uploadedAt).toLocaleDateString()}
                              </TableCell>
                              <TableCell className="text-gray-300">
                                <div className="flex flex-wrap gap-1">
                                  {annotation.tags && annotation.tags.length > 0 ? (
                                    <>
                                      {annotation.tags.slice(0, 2).map((tag) => (
                                        <Badge
                                          key={tag}
                                          variant="secondary"
                                          className="text-xs bg-blue-600/20 text-blue-300 border-blue-600/30"
                                        >
                                          <Tag className="h-3 w-3 mr-1" />
                                          {tag}
                                        </Badge>
                                      ))}
                                      {annotation.tags.length > 2 && (
                                        <Badge
                                          variant="secondary"
                                          className="text-xs bg-gray-600/20 text-gray-400 border-gray-600/30"
                                        >
                                          +{annotation.tags.length - 2}
                                        </Badge>
                                      )}
                                    </>
                                  ) : (
                                    <span className="text-gray-500 text-xs">No tags</span>
                                  )}
                                </div>
                              </TableCell>
                              <TableCell className="text-gray-300">
                                {annotation.classStats ? (
                                  <Badge className="bg-green-600/50">
                                    {annotation.classStats.length} classes
                                  </Badge>
                                ) : "0 classes"}
                              </TableCell>
                              <TableCell className="text-gray-300">
                                {annotation.processing_status === 'pending' || annotation.processing_status === 'processing' ? (
                                  <Badge className="bg-yellow-600/50">
                                    Processing...
                                  </Badge>
                                ) : annotation.annotation_count ? (
                                  <Badge className="bg-purple-600/50">
                                    {annotation.annotation_count} annotations
                                  </Badge>
                                ) : (
                                  <Badge className="bg-gray-600/50">
                                    0 annotations
                                  </Badge>
                                )}
                              </TableCell>
                              <TableCell className="text-gray-300">
                                {annotation.annotation_count > 0 ? "Used by annotations" : "—"}
                              </TableCell>
                              <TableCell>
                                <div className="flex items-center gap-1">
                                  {(() => {
                                    const annotationType = detectAnnotationType(annotation);
                                    console.log(`Annotation ${annotation.fileName} type:`, annotationType);
                                    const isSegmentation = annotationType.startsWith('Segmentation');
                                    console.log(`Is segmentation:`, isSegmentation);
                                    return isSegmentation;
                                  })() && (
                                    <Button 
                                      variant="ghost" 
                                      size="icon" 
                                      className="h-8 w-8 text-green-400 hover:bg-gray-700"
                                      onClick={(e) => handleEditSegmentationAnnotation(annotation, e)}
                                      title="Edit segmentation annotations"
                                    >
                                      <Brush className="h-4 w-4" />
                                    </Button>
                                  )}
                                  <Button 
                                    variant="ghost" 
                                    size="icon" 
                                    className="h-8 w-8 hover:bg-gray-700"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setSelectedAnnotation(annotation);
                                      setNewFilename(annotation.fileName);
                                      setIsRenaming(true);
                                    }}
                                    title="Rename annotation file"
                                  >
                                    <Pencil className="h-4 w-4 text-gray-400" />
                                  </Button>
                                  <Button 
                                    variant="ghost" 
                                    size="icon" 
                                    className="h-8 w-8 text-blue-500 hover:bg-blue-900/20 hover:text-blue-300"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleDuplicateAnnotation(annotation);
                                    }}
                                    title="Duplicate annotation file"
                                  >
                                    <Copy className="h-5 w-5" />
                                  </Button>
                                  <Button 
                                    variant="ghost" 
                                    size="icon" 
                                    className="h-8 w-8 text-red-500 hover:bg-gray-700"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleDeleteAnnotation(annotation);
                                    }}
                                    title="Delete annotation file"
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </Button>
                                </div>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center bg-gray-800 rounded-lg p-12 text-center mb-6">
                      <FileJson className="h-12 w-12 text-gray-400 mb-4" />
                      <h4 className="text-lg font-medium text-white">No annotations yet</h4>
                      <p className="text-gray-400 mt-1 mb-4">
                        Upload COCO format annotation files
                      </p>
                      <Button 
                        onClick={() => setShowUploadDialog(true)}
                        className="bg-blue-600 hover:bg-blue-700"
                      >
                        <Upload className="h-4 w-4 mr-2" /> Add Annotations
                      </Button>
                    </div>
                  )}
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        </div>
      </main>
      
      <Dialog 
        open={!!selectedImage} 
        onOpenChange={(open) => !open && setSelectedImage(null)}
      >
        <DialogContent className="max-w-3xl bg-gray-900 text-white border-gray-700">
          <DialogHeader>
            <DialogTitle>{selectedImage?.fileName}</DialogTitle>
            <DialogDescription className="text-gray-400">
              {selectedImage?.width}x{selectedImage?.height} • {(selectedImage?.fileSize ? (selectedImage.fileSize / 1024 / 1024).toFixed(2) : 0)} MB
            </DialogDescription>
          </DialogHeader>
          
          <div className="relative aspect-video bg-gray-950 rounded-md overflow-hidden flex items-center justify-center">
            {selectedImage && (
              <>
                <img 
                  src={showFullSizeImage ? selectedImage.url : selectedImage.thumbnailUrl} 
                  alt={selectedImage.fileName} 
                  className="max-w-full max-h-full object-contain cursor-pointer"
                  loading="lazy"
                  onLoad={handleImageLoad}
                  onClick={() => setShowFullSizeImage(!showFullSizeImage)}
                  title={showFullSizeImage ? "Click to view thumbnail" : "Click to view full size"}
                />
                
                {selectedImage && showAnnotationsOnImage.filter(anno => anno.imageId === selectedImage.id).length > 0 && (
                  <AnnotationVisualizer 
                    annotations={showAnnotationsOnImage.filter(anno => anno.imageId === selectedImage.id)}
                    imageWidth={imageDimensions.width}
                    imageHeight={imageDimensions.height}
                    className="absolute inset-0"
                  />
                )}
              </>
            )}
          </div>
          
          <DialogFooter className="flex flex-col sm:flex-row justify-between gap-2">
            <div className="flex items-center gap-4 text-sm text-gray-400">
              <span>
                {selectedImage && showAnnotationsOnImage.filter(anno => anno.imageId === selectedImage.id).length > 0 
                  ? `Showing ${showAnnotationsOnImage.filter(anno => anno.imageId === selectedImage.id).length} annotations` 
                  : "No annotations shown"
                }
              </span>
              <Badge variant={showFullSizeImage ? "default" : "secondary"} className="text-xs">
                {showFullSizeImage ? "Full Size" : "Thumbnail"}
              </Badge>
            </div>
            <Button
              variant="destructive"
              onClick={() => {
                if (selectedImage) {
                  handleDeleteImage(selectedImage);
                }
              }}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Delete Image
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      
      <Dialog 
        open={!!selectedAnnotation && !isRenaming} 
        onOpenChange={(open) => !open && setSelectedAnnotation(null)}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{selectedAnnotation?.fileName}</DialogTitle>
            <DialogDescription>
              {(selectedAnnotation?.fileSize ? (selectedAnnotation.fileSize / 1024).toFixed(1) : 0)} KB • Uploaded {selectedAnnotation?.uploadedAt && new Date(selectedAnnotation.uploadedAt).toLocaleDateString()}
            </DialogDescription>
          </DialogHeader>
          
          {selectedAnnotation?.classStats && selectedAnnotation.classStats.length > 0 ? (
            <div className="max-h-[60vh] overflow-y-auto">
              <ClassStatisticsWithManagement 
                statistics={selectedAnnotation.classStats}
                annotations={(selectedAnnotation.samples || []).map(s => ({
                  ...s,
                  imageId: s.imageId || '',
                  className: s.className || '',
                  bbox: s.bbox || [0, 0, 0, 0] as [number, number, number, number]
                }))}
                onRenameClass={handleRenameClass}
                onDeleteClass={handleDeleteClass}
                onMergeClasses={handleMergeClasses}
              />
              
              {selectedAnnotation.samples && selectedAnnotation.samples.length > 0 && (
                <div className="mt-6">
                  <h3 className="text-lg font-medium mb-2 text-white">Sample Annotations</h3>
                  <p className="text-sm text-gray-400 mb-4">
                    Showing {Math.min(5, selectedAnnotation.samples.length)} of {selectedAnnotation.samples.length} annotations
                  </p>
                  
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {selectedAnnotation.samples.slice(0, 5).map((sample, idx) => (
                      <div key={idx} className="rounded-md border border-gray-700 p-2 bg-gray-800">
                        <div className="font-medium text-white">{sample.className}</div>
                        <div className="text-xs text-gray-400">
                          Image ID: {(sample.imageId || '').substring(0, 6)}...
                        </div>
                        {(sample as any).confidence && (
                          <div className="text-xs text-gray-400">
                            Confidence: {Math.round((sample as any).confidence * 100)}%
                          </div>
                        )}
                        {sample.segmentation && (
                          <div className="text-xs text-green-400">
                            Has segmentation mask
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="py-8 text-center">
              <p className="text-gray-400">No class statistics available</p>
            </div>
          )}
          
          <DialogFooter className="flex justify-between sm:justify-between">
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="border-gray-700 bg-gray-800 hover:bg-gray-700 text-white"
                onClick={() => {
                  if (selectedAnnotation) {
                    setNewFilename(selectedAnnotation.fileName);
                    setIsRenaming(true);
                  }
                }}
              >
                <Pencil className="mr-2 h-4 w-4" />
                Rename
              </Button>
              <Button
                variant="outline"
                className="border-gray-700 bg-gray-800 hover:bg-gray-700 text-white"
                onClick={() => {
                  if (selectedAnnotation) {
                    handleDuplicateAnnotation(selectedAnnotation);
                    setSelectedAnnotation(null);
                  }
                }}
              >
                <Copy className="mr-2 h-4 w-4" />
                Duplicate
              </Button>
              <Button
                variant="outline"
                className="border-gray-700 bg-gray-800 hover:bg-gray-700 text-white"
                onClick={() => setSelectedAnnotation(null)}
              >
                Close
              </Button>
            </div>
            <Button
              variant="destructive"
              onClick={() => {
                if (selectedAnnotation) {
                  handleDeleteAnnotation(selectedAnnotation);
                }
              }}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      
      <Dialog open={isRenaming} onOpenChange={(open) => !open && setIsRenaming(false)}>
        <DialogContent className="sm:max-w-md bg-gray-900 text-white border-gray-700">
          <DialogHeader>
            <DialogTitle>Rename File</DialogTitle>
            <DialogDescription className="text-gray-400">
              Enter a new name for this annotation file
            </DialogDescription>
          </DialogHeader>
          
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="filename" className="text-right text-gray-300">
                Filename
              </Label>
              <Input
                id="filename"
                value={newFilename}
                onChange={(e) => setNewFilename(e.target.value)}
                className="col-span-3 bg-gray-800 border-gray-700 text-white"
                autoFocus
              />
            </div>
          </div>
          
          <DialogFooter>
            <DialogClose asChild>
              <Button
                variant="secondary"
                onClick={() => setIsRenaming(false)}
              >
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant="default"
              onClick={handleRenameAnnotation}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      
      <AnnotationsUploadDialog 
        open={showUploadDialog}
        onOpenChange={setShowUploadDialog}
        onFilesSelected={handleAnnotationUpload}
      />
      
      <ImageUploadDialog
        open={showImageUploadDialog}
        onOpenChange={setShowImageUploadDialog}
        onFilesSelected={handleImageUpload}
      />
      
      <ChunkedImageUploadDialog
        open={showChunkedUploadDialog}
        onOpenChange={setShowChunkedUploadDialog}
        onFilesUploaded={(count) => {
          toast({
            title: "Bulk upload complete",
            description: `Successfully uploaded ${count} images`,
          });
        }}
        onUploadChunk={handleChunkedImageUpload}
        chunkSize={1000}
      />
      
      <AnnotationImagesDialog
        open={showAnnotationsDialog}
        onOpenChange={setShowAnnotationsDialog}
        annotations={annotationsToShow}
        annotationFileName={annotationFileNameToShow}
        images={images}
        onShowOnImage={(annotations) => {
          setShowAnnotationsOnImage(annotations);
          setShowAnnotationsDialog(false);
        }}
      />

      <ConfirmDeleteDialog
        open={showDeleteConfirm}
        onOpenChange={setShowDeleteConfirm}
        entity="dataset"
        itemName={dataset?.name ?? null}
        consequences={["All images and annotations in this dataset will be permanently removed."]}
        confirmLabel={isDeleting ? 'Deleting...' : 'Delete dataset'}
        isLoading={isDeleting}
        onConfirm={handleDeleteDataset}
        extraContent={
          augmentedDatasets.length > 0 ? (
            <div className="my-2 p-4 bg-muted rounded-lg">
              <p className="text-sm font-medium mb-2">
                This dataset has {augmentedDatasets.length} augmented dataset{augmentedDatasets.length > 1 ? 's' : ''}:
              </p>
              <ul className="text-sm text-muted-foreground mb-3 list-disc list-inside">
                {augmentedDatasets.slice(0, 5).map(ds => (
                  <li key={ds.id}>{ds.name}</li>
                ))}
                {augmentedDatasets.length > 5 && (
                  <li>...and {augmentedDatasets.length - 5} more</li>
                )}
              </ul>
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="deleteAugmentedEdit"
                  checked={deleteAugmented}
                  onCheckedChange={(checked) => setDeleteAugmented(checked === true)}
                />
                <label
                  htmlFor="deleteAugmentedEdit"
                  className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                >
                  Also delete augmented datasets
                </label>
              </div>
            </div>
          ) : null
        }
      />
    </div>
  );
};

export default EditDataset;
