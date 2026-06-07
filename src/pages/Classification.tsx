import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useParams, Link, useSearchParams, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Navbar } from "@/components/Navbar";
import { useToast } from "@/hooks/use-toast";
import { useApi } from "@/hooks/use-api";
import { Image, ImageCollection } from "@/types";
import { ArrowLeft, Plus, X, Check, ChevronLeft, ChevronRight, Settings2, Save, Upload, Download, Settings, BarChart3, Database } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ImageDisplayControls } from "@/components/ImageDisplayControls";
import { PaginationControls } from "@/components/PaginationControls";
import { useDatasetSettings } from "@/hooks/useDatasetSettings";
import { OptimizedClassificationStorage, LocalStorageCleanup } from "@/utils/optimizedStorage";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";

interface ClassificationData {
  [imageId: string]: string[];
}

export default function Classification() {
  const { id, projectId } = useParams<{ id: string; projectId?: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { api, isConfigured } = useApi();

  // Redirect legacy /datasets/:id/annotate/classification to project-scoped URL
  useEffect(() => {
    if (!id || projectId || !api) return;
    let cancelled = false;
    api.getDataset(id).then((res) => {
      if (cancelled || !res.success || !res.data?.project_id) return;
      const annot = searchParams.get('annotationId');
      const q = annot ? `?annotationId=${annot}` : '';
      navigate(`/projects/${res.data.project_id}/datasets/${id}/annotate/classification${q}`, { replace: true });
    });
    return () => { cancelled = true; };
  }, [id, projectId, api, navigate]);

  // Get annotation ID from URL params if editing existing annotation
  const annotationId = searchParams.get('annotationId');

  // Dataset settings
  const datasetId = id || '';
  const { settings, updateImagesPerPage, updateImageSize, updateLayout } = useDatasetSettings(datasetId, { imageSize: 320 });
  
  // Optimized storage instance
  const storage = useMemo(() => {
    return datasetId ? new OptimizedClassificationStorage(datasetId) : null;
  }, [datasetId]);
  
  // Data states
  const [images, setImages] = useState<Image[]>([]);
  const [imageCollections, setImageCollections] = useState<ImageCollection[]>([]);
  const [selectedCollectionId, setSelectedCollectionId] = useState<string>("all");
  const [classes, setClasses] = useState<string[]>([]);
  const [classifications, setClassifications] = useState<ClassificationData>({});
  const [classColors, setClassColors] = useState<{ [className: string]: string }>({});
  const [loading, setLoading] = useState(true);
  
  // UI states
  const [newClass, setNewClass] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedClass, setSelectedClass] = useState<string | null>(null);
  const [hasShownQuotaWarning, setHasShownQuotaWarning] = useState(false);
  const [sessionOnly, setSessionOnly] = useState(false); // Whether to store data temporarily
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [uploadFileName, setUploadFileName] = useState("");
  const [showNavigationTip, setShowNavigationTip] = useState(false);
  const [annotationName, setAnnotationName] = useState<string>("");
  const [deleteConfirmDialog, setDeleteConfirmDialog] = useState<{
    isOpen: boolean;
    className: string;
    annotationCount: number;
  }>({ isOpen: false, className: '', annotationCount: 0 });
  const [activeTab, setActiveTab] = useState("class-management");
  
  // Color utility functions
  const generateRandomColor = () => {
    const colors = [
      '#ea384c', '#F97316', '#1EAEDB', '#8B5CF6', '#2ecc71', 
      '#f39c12', '#9b59b6', '#e74c3c', '#3498db', '#e67e22',
      '#95a5a6', '#34495e', '#1abc9c', '#16a085', '#27ae60',
      '#ff6b6b', '#4ecdc4', '#45b7d1', '#96ceb4', '#ffeaa7',
      '#dda0dd', '#98d8c8', '#f7dc6f', '#bb8fce', '#85c1e9'
    ];
    return colors[Math.floor(Math.random() * colors.length)];
  };

  const getClassColor = (className: string): string => {
    if (classColors[className]) {
      return classColors[className];
    }
    // Generate new color for this class
    const newColor = generateRandomColor();
    setClassColors(prev => ({ ...prev, [className]: newColor }));
    return newColor;
  };

  const handleClassColorChange = (className: string, newColor: string) => {
    setClassColors(prev => ({ ...prev, [className]: newColor }));
    // Save to localStorage
    if (id) {
      localStorage.setItem(`class_colors_${id}`, JSON.stringify({ ...classColors, [className]: newColor }));
    }
  };
  
  const collectionIdFromUrl = searchParams.get("collectionId");

  const collectionImages = useMemo(() => {
    if (selectedCollectionId === "all") return images;
    const selected = imageCollections.find(c => String(c.id) === String(selectedCollectionId));
    return selected?.images ?? [];
  }, [images, imageCollections, selectedCollectionId]);

  const allKnownImages = useMemo(() => {
    const byId = new Map<string, Image>();
    images.forEach(img => byId.set(String(img.id), img));
    imageCollections.forEach(c => (c.images ?? []).forEach(img => byId.set(String(img.id), img)));
    return Array.from(byId.values());
  }, [images, imageCollections]);

  const getPeerImageIds = useCallback((imageId: string): string[] => {
    const baseName = (n?: string) => {
      const v = n ?? "";
      return v.includes(".") ? v.slice(0, v.lastIndexOf(".")).toLowerCase() : v.toLowerCase();
    };
    const current = allKnownImages.find(i => String(i.id) === String(imageId));
    if (!current) return [imageId];
    const peers = allKnownImages.filter((img) => {
      if (String(img.id) === String(current.id)) return true;
      const byGroup = current.groupId && img.groupId && String(current.groupId) === String(img.groupId);
      const byName = !byGroup && baseName(current.fileName) === baseName(img.fileName);
      return !!(byGroup || byName);
    });
    return peers.map(p => String(p.id));
  }, [allKnownImages]);

  // Calculate pagination
  const totalPages = Math.max(1, Math.ceil(collectionImages.length / settings.imagesPerPage));
  const paginatedImages = collectionImages.slice(
    (currentPage - 1) * settings.imagesPerPage,
    currentPage * settings.imagesPerPage
  );

  // Function to load classification data from an existing annotation file
  const loadFromAnnotationFile = useCallback(async (annotationFileId: string) => {
    try {
      console.log('Loading classification data from annotation file:', annotationFileId);
      console.log('Current images array length:', images.length);
      
      // First try to load from saved_annotations localStorage
      const savedAnnotations = localStorage.getItem(`saved_annotations_${id}`);
      if (savedAnnotations) {
        const annotationsList = JSON.parse(savedAnnotations);
        const targetAnnotation = annotationsList.find((ann: any) => ann.id === annotationFileId);
        
        if (targetAnnotation && targetAnnotation.content) {
          console.log('Found annotation file in localStorage:', targetAnnotation.name);
          setAnnotationName(targetAnnotation.name);
          
          const cocoData = targetAnnotation.content;
          const newClassifications: ClassificationData = {};
          const classSet = new Set<string>();
          
          // Extract classes from categories
          if (cocoData.categories) {
            cocoData.categories.forEach((category: any) => {
              classSet.add(category.name);
            });
          }
          
          // Create filename to image ID mapping
          const filenameToImageId: { [filename: string]: string } = {};
          allKnownImages.forEach(img => {
            filenameToImageId[img.fileName] = img.id;
          });
          
          console.log('[localStorage] Created filename mapping with', Object.keys(filenameToImageId).length, 'entries');
            console.log('[localStorage] Sample filenames from images:', allKnownImages.slice(0, 3).map(img => img.fileName));
          
          // Map annotations to classifications
          if (cocoData.annotations && cocoData.images) {
            // Create image ID to filename mapping from COCO data
            const cocoImageIdToFilename: { [id: string]: string } = {};
            cocoData.images.forEach((img: any) => {
              cocoImageIdToFilename[img.id.toString()] = img.file_name;
            });
            
            // Create category ID to name mapping
            const categoryIdToName: { [id: string]: string } = {};
            cocoData.categories.forEach((cat: any) => {
              categoryIdToName[cat.id.toString()] = cat.name;
            });
            
            console.log('[localStorage] Processing annotations:', cocoData.annotations.length);
            console.log('[localStorage] COCO images count:', cocoData.images.length, 'Loaded images count:', allKnownImages.length);
            console.log('[localStorage] Category mapping:', categoryIdToName);
            console.log('[localStorage] Sample COCO filenames:', cocoData.images.slice(0, 3).map((img: any) => img.file_name));
            
            // Process annotations
            let matchedCount = 0;
            let unmatchedCount = 0;
            cocoData.annotations.forEach((annotation: any) => {
              const cocoImageId = annotation.image_id.toString();
              const filename = cocoImageIdToFilename[cocoImageId];
              const actualImageId = filenameToImageId[filename];
              const className = categoryIdToName[annotation.category_id.toString()];
              
              if (actualImageId && className) {
                matchedCount++;
                if (!newClassifications[actualImageId]) {
                  newClassifications[actualImageId] = [];
                }
                if (!newClassifications[actualImageId].includes(className)) {
                  newClassifications[actualImageId].push(className);
                }
              } else {
                unmatchedCount++;
                if (unmatchedCount <= 5) {
                  console.log('[localStorage] Unmatched annotation:', {
                    cocoImageId,
                    filename,
                    actualImageId,
                    className,
                    category_id: annotation.category_id
                  });
                }
              }
            });
            
            console.log('[localStorage] Matched:', matchedCount, 'Unmatched:', unmatchedCount);
            console.log('[localStorage] After processing, classifications count:', Object.keys(newClassifications).length);
          }
          
          // Update state
          const loadedClasses = Array.from(classSet);
          setClasses(loadedClasses);
          setClassifications(newClassifications);
          
          // Assign colors to any new classes that don't have them
          const newColors = { ...classColors };
          loadedClasses.forEach(className => {
            if (!newColors[className]) {
              newColors[className] = generateRandomColor();
            }
          });
          setClassColors(newColors);
          
          console.log('Loaded', Object.keys(newClassifications).length, 'classifications from annotation file');
          toast({
            title: "Annotation loaded",
            description: `Loaded classification data from "${targetAnnotation.name}"`,
          });
          
          return true;
        }
      }
      
      // If not found in localStorage, try loading from backend
      if (api) {
        try {
          // First get annotation metadata to get the name
          const annotationResponse = await api.getAnnotation(id!, annotationFileId);
          const response = await api.getAnnotationContent(id!, annotationFileId);
          if (!response.success || !response.data) {
            throw new Error('No content in response');
          }
          const payload = response.data;
          if (payload.is_processing) {
            throw new Error(payload.message || 'Annotation import is still processing. Try again shortly.');
          }
          if (payload.is_large) {
            throw new Error(
              payload.message ||
                'This annotation file is too large to open as a single download.',
            );
          }
          const rawContent = payload.content;
          const contentStr =
            typeof rawContent === 'string'
              ? rawContent
              : rawContent != null
                ? JSON.stringify(rawContent)
                : null;
          if (!contentStr) {
            throw new Error('No content in response');
          }
          console.log('Loading annotation from backend');
            console.log('Content length:', contentStr.length, 'bytes');
            
            // Set annotation name if available
            if (annotationResponse.success && annotationResponse.data?.file_name) {
              setAnnotationName(annotationResponse.data.file_name);
            }
            
            let cocoData;
            try {
              cocoData = JSON.parse(contentStr);
              console.log('Parsed COCO data successfully');
              console.log('Has images:', !!cocoData.images, 'count:', cocoData.images?.length);
              console.log('Has annotations:', !!cocoData.annotations, 'count:', cocoData.annotations?.length);
              console.log('Has categories:', !!cocoData.categories, 'count:', cocoData.categories?.length);
            } catch (parseError) {
              console.error('Failed to parse annotation content:', parseError);
              console.log('Content preview (first 500 chars):', contentStr.substring(0, 500));
              toast({
                title: "Error",
                description: "Failed to parse annotation file",
                variant: "destructive",
              });
              return false;
            }
            const newClassifications: ClassificationData = {};
            const classSet = new Set<string>();
            
            // Extract classes from categories
            if (cocoData.categories) {
              cocoData.categories.forEach((category: any) => {
                classSet.add(category.name);
              });
            }
            
            // Create filename to image ID mapping
            const filenameToImageId: { [filename: string]: string } = {};
            allKnownImages.forEach(img => {
              filenameToImageId[img.fileName] = img.id;
            });
            
            console.log('[backend] Created filename mapping with', Object.keys(filenameToImageId).length, 'entries');
            console.log('[backend] Sample filenames from images:', allKnownImages.slice(0, 3).map(img => img.fileName));
            
            // Map annotations to classifications (similar logic as above)
            if (cocoData.annotations && cocoData.images) {
              const cocoImageIdToFilename: { [id: string]: string } = {};
              cocoData.images.forEach((img: any) => {
                cocoImageIdToFilename[img.id.toString()] = img.file_name;
              });
              
              const categoryIdToName: { [id: string]: string } = {};
              cocoData.categories.forEach((cat: any) => {
                categoryIdToName[cat.id.toString()] = cat.name;
              });
              
              console.log('[backend] Processing annotations:', cocoData.annotations.length);
              console.log('[backend] COCO images count:', cocoData.images.length, 'Loaded images count:', allKnownImages.length);
              console.log('[backend] Category mapping:', categoryIdToName);
              console.log('[backend] Sample COCO filenames:', cocoData.images.slice(0, 3).map((img: any) => img.file_name));
              
              let matchedCount = 0;
              let unmatchedCount = 0;
              cocoData.annotations.forEach((annotation: any) => {
                const cocoImageId = annotation.image_id.toString();
                const filename = cocoImageIdToFilename[cocoImageId];
                const actualImageId = filenameToImageId[filename];
                const className = categoryIdToName[annotation.category_id.toString()];
                
                if (actualImageId && className) {
                  matchedCount++;
                  if (!newClassifications[actualImageId]) {
                    newClassifications[actualImageId] = [];
                  }
                  if (!newClassifications[actualImageId].includes(className)) {
                    newClassifications[actualImageId].push(className);
                  }
                } else {
                  unmatchedCount++;
                  if (unmatchedCount <= 5) {
                    console.log('[backend] Unmatched annotation:', {
                      cocoImageId,
                      filename,
                      actualImageId,
                      className,
                      category_id: annotation.category_id
                    });
                  }
                }
              });
              
              console.log('[backend] Matched:', matchedCount, 'Unmatched:', unmatchedCount);
              console.log('[backend] After processing, classifications count:', Object.keys(newClassifications).length);
            }
            
            const loadedClasses = Array.from(classSet);
            setClasses(loadedClasses);
            setClassifications(newClassifications);
            
            // Assign colors to any new classes that don't have them
            const newColors = { ...classColors };
            loadedClasses.forEach(className => {
              if (!newColors[className]) {
                newColors[className] = generateRandomColor();
              }
            });
            setClassColors(newColors);
            
            console.log('Loaded', Object.keys(newClassifications).length, 'classifications from backend');
            toast({
              title: "Annotation loaded",
              description: `Loaded classification data from annotation file`,
            });
            
            return true;
        } catch (error) {
          console.error('Error loading annotation from backend:', error);
        }
      }
      
      console.warn('Could not find annotation file:', annotationFileId);
      toast({
        title: "Annotation not found",
        description: "Could not load the specified annotation file",
        variant: "destructive",
      });
      
      return false;
    } catch (error) {
      console.error('Error loading annotation file:', error);
      toast({
        title: "Error loading annotation",
        description: "Failed to load classification data from annotation file",
        variant: "destructive",
      });
      return false;
    }
  }, [id, api, allKnownImages, toast]);

  // Load images and existing classifications
  useEffect(() => {
    const loadData = async () => {
      if (!id) {
        console.error('No dataset ID provided');
        setLoading(false);
        return;
      }
      
      // Wait for API to be configured
      if (!isConfigured) {
        console.log('API not configured yet, waiting...');
        return;
      }
      
      try {
        setLoading(true);
        
        // Load images and collections if API is available
        if (api) {
          console.log('Loading images for dataset:', id);
          const [imagesRes, collectionsRes] = await Promise.all([
            api.getImages(id),
            api.getImageCollections(id),
          ]);
          const mergedImagesById = new Map<string, Image>();
          if (imagesRes.success && imagesRes.data) {
            imagesRes.data.forEach(img => mergedImagesById.set(String(img.id), img));
          }
          if (collectionsRes.success && collectionsRes.data) {
            setImageCollections(collectionsRes.data);
            collectionsRes.data.forEach(c => (c.images ?? []).forEach(img => mergedImagesById.set(String(img.id), img)));
          } else {
            setImageCollections([]);
          }
          const mergedImages = Array.from(mergedImagesById.values());
          setImages(mergedImages);
          console.log('Loaded', mergedImages.length, 'images across collections');
        } else {
          console.warn('API client not available');
        }
        
        // Load existing classifications from optimized storage or annotation file
        if (annotationId) {
          // If we have an annotation ID, it will be loaded in a separate useEffect that waits for images
          console.log('Annotation ID detected:', annotationId, '- will load after images are ready');
        } else if (storage) {
        // Otherwise load from storage as usual
        console.log('Loading classifications from storage');
        const { classifications: loadedClassifications, classes: loadedClasses } = storage.loadClassifications();
        setClassifications(loadedClassifications);
        setClasses(loadedClasses);
        // Clear annotation name since we're not editing an existing annotation
        setAnnotationName("");
          console.log('Loaded', Object.keys(loadedClassifications).length, 'classifications and', loadedClasses.length, 'classes');
          
          // Assign colors to any loaded classes that don't have them
          const savedColors = localStorage.getItem(`class_colors_${id}`);
          let currentColors = {};
          if (savedColors) {
            try {
              currentColors = JSON.parse(savedColors);
            } catch (error) {
              console.warn('Error loading class colors:', error);
            }
          }
          
          const newColors = { ...currentColors };
          loadedClasses.forEach(className => {
            if (!newColors[className]) {
              newColors[className] = generateRandomColor();
            }
          });
          setClassColors(newColors);
          
          // Try to migrate legacy data if optimized data is empty but legacy exists
          if (Object.keys(loadedClassifications).length === 0) {
            console.log('Attempting legacy data migration');
            const migrated = storage.migrateLegacyData();
            if (migrated) {
              const { classifications: migratedClassifications, classes: migratedClasses } = storage.loadClassifications();
              setClassifications(migratedClassifications);
              setClasses(migratedClasses);
              
              // Assign colors to migrated classes too
              const migratedColors = { ...newColors };
              migratedClasses.forEach(className => {
                if (!migratedColors[className]) {
                  migratedColors[className] = generateRandomColor();
                }
              });
              setClassColors(migratedColors);
              
              console.log('Migrated', Object.keys(migratedClassifications).length, 'classifications');
            }
          }
        }
        
        // Clean up old classification data to free space (keep only 3 most recent datasets)
        const cleanedCount = LocalStorageCleanup.cleanupClassificationData(3);
        if (cleanedCount > 0) {
          console.log(`Cleaned up ${cleanedCount} old classification datasets to free space`);
        }
        
      } catch (error) {
        console.error('Error loading data:', error);
        toast({
          variant: "destructive",
          title: "Error",
          description: "Failed to load dataset images",
        });
      } finally {
        setLoading(false);
        console.log('Classification component loading completed');
      }
    };
    
    loadData();
  }, [id, api, isConfigured, toast, annotationId]);

  useEffect(() => {
    if (imageCollections.length === 0) {
      setSelectedCollectionId("all");
      return;
    }
    const validIds = new Set(imageCollections.map(c => String(c.id)));
    if (collectionIdFromUrl && validIds.has(String(collectionIdFromUrl))) {
      setSelectedCollectionId(String(collectionIdFromUrl));
      return;
    }
    if (selectedCollectionId !== "all" && validIds.has(String(selectedCollectionId))) {
      return;
    }
    const preferred = imageCollections.find(c => c.is_default) ?? imageCollections[0];
    setSelectedCollectionId(String(preferred.id));
  }, [imageCollections, collectionIdFromUrl, selectedCollectionId]);

  // Load annotation data when images are loaded and we have an annotationId
  // Use ref to track if we've already loaded to prevent infinite loops
  const annotationLoadedRef = useRef(false);
  
  useEffect(() => {
    if (annotationId && images.length > 0 && !annotationLoadedRef.current) {
      console.log('Loading annotation data after images loaded, images count:', images.length);
      annotationLoadedRef.current = true;
      loadFromAnnotationFile(annotationId);
    }
  }, [annotationId, images, loadFromAnnotationFile]);
  
  // Reset the ref when annotationId changes
  useEffect(() => {
    annotationLoadedRef.current = false;
  }, [annotationId]);

  // Load class colors from localStorage
  useEffect(() => {
    if (id) {
      const savedColors = localStorage.getItem(`class_colors_${id}`);
      if (savedColors) {
        try {
          setClassColors(JSON.parse(savedColors));
        } catch (error) {
          console.warn('Error loading class colors:', error);
        }
      }
    }
  }, [id]);

  // Save class colors to localStorage when they change
  useEffect(() => {
    if (id && Object.keys(classColors).length > 0) {
      localStorage.setItem(`class_colors_${id}`, JSON.stringify(classColors));
    }
  }, [classColors, id]);

  // Save classifications to optimized localStorage (with session-only option)
  const saveClassifications = useCallback((newClassifications: ClassificationData) => {
    if (id && storage && !sessionOnly) {
      try {
        const success = storage.saveClassifications(newClassifications, classes);
        if (success) {
          setClassifications(newClassifications);
        } else {
          throw new Error('Failed to save to optimized storage');
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'QuotaExceededError') {
          console.warn('localStorage quota exceeded, switching to session-only mode');
          
          // Show warning and switch to session-only mode
          if (!hasShownQuotaWarning) {
            setHasShownQuotaWarning(true);
            setSessionOnly(true);
            toast({
              title: "Storage full - Session mode",
              description: "Classifications will work but won't persist after page reload. Save your work before leaving!",
              variant: "destructive",
            });
          }
          
          // Just update state without localStorage
          setClassifications(newClassifications);
          
        } else {
          console.error('Error saving classifications:', error);
          // Fallback to legacy storage
          try {
            localStorage.setItem(`classifications_${id}`, JSON.stringify(newClassifications));
            setClassifications(newClassifications);
          } catch (fallbackError) {
            // If even legacy fails, go session-only
            setSessionOnly(true);
            setClassifications(newClassifications);
          }
        }
      }
    } else {
      // Session-only mode or no storage
      setClassifications(newClassifications);
    }
  }, [id, storage, classes, sessionOnly, hasShownQuotaWarning, toast]);

  // Save classes to optimized localStorage (with session-only option)
  const saveClasses = useCallback((newClasses: string[]) => {
    if (id && storage && !sessionOnly) {
      try {
        // Save current classifications with new classes
        storage.saveClassifications(classifications, newClasses);
        setClasses(newClasses);
      } catch (error) {
        if (error instanceof Error && error.name === 'QuotaExceededError') {
          console.warn('localStorage quota exceeded, switching to session-only mode');
          setSessionOnly(true);
          toast({
            title: "Storage full - Session mode", 
            description: "Classes will work but won't persist after reload. Save before leaving!",
            variant: "destructive",
          });
          // Still update the state even if localStorage fails
          setClasses(newClasses);
        } else {
          console.error('Error saving classes:', error);
          // Fallback to legacy storage
          try {
            localStorage.setItem(`classification_classes_${id}`, JSON.stringify(newClasses));
            setClasses(newClasses);
          } catch (fallbackError) {
            setSessionOnly(true);
            setClasses(newClasses);
          }
        }
      }
    } else {
      // Session-only mode
      setClasses(newClasses);
    }
  }, [id, storage, classifications, sessionOnly, toast]);

  // Add new class
  const handleAddClass = () => {
    if (newClass.trim() && !classes.includes(newClass.trim())) {
      const className = newClass.trim();
      const updatedClasses = [...classes, className];
      saveClasses(updatedClasses);
      
      // Assign a color to the new class
      if (!classColors[className]) {
        const newColor = generateRandomColor();
        setClassColors(prev => ({ ...prev, [className]: newColor }));
      }
      
      setNewClass("");
      toast({
        title: "Class added",
        description: `Added new class: ${className}`,
      });
    }
  };

  // Remove class (with confirmation)
  const handleRemoveClass = (classToRemove: string) => {
    // Count how many images have this class assigned
    const annotationCount = Object.values(classifications).filter(
      imageClasses => imageClasses.includes(classToRemove)
    ).length;
    
    // Show confirmation dialog
    setDeleteConfirmDialog({
      isOpen: true,
      className: classToRemove,
      annotationCount: annotationCount
    });
  };

  // Confirm class deletion
  const handleConfirmDeleteClass = () => {
    const classToRemove = deleteConfirmDialog.className;
    const updatedClasses = classes.filter(c => c !== classToRemove);
    saveClasses(updatedClasses);
    
    // Remove class from all image classifications
    const updatedClassifications = { ...classifications };
    Object.keys(updatedClassifications).forEach(imageId => {
      updatedClassifications[imageId] = updatedClassifications[imageId].filter(c => c !== classToRemove);
    });
    saveClassifications(updatedClassifications);
    
    // Remove class color
    setClassColors(prev => {
      const newColors = { ...prev };
      delete newColors[classToRemove];
      return newColors;
    });
    
    // Clear selected class if it was the deleted one
    if (selectedClass === classToRemove) {
      setSelectedClass(null);
    }
    
    toast({
      title: "Class removed",
      description: `Removed class "${classToRemove}" and ${deleteConfirmDialog.annotationCount} annotations`,
    });
    
    // Close dialog
    setDeleteConfirmDialog({ isOpen: false, className: '', annotationCount: 0 });
  };

  // Toggle class for specific image
  const handleImageClassToggle = (imageId: string, className: string) => {
    const peerIds = getPeerImageIds(imageId);
    const currentImageClasses = classifications[imageId] || [];
    const shouldRemove = currentImageClasses.includes(className);
    const updatedClassifications = {
      ...classifications,
    };
    peerIds.forEach((pid) => {
      const currentClasses = updatedClassifications[pid] || [];
      updatedClassifications[pid] = shouldRemove
        ? currentClasses.filter(c => c !== className)
        : Array.from(new Set([...currentClasses, className]));
    });
    saveClassifications(updatedClassifications);
  };

  const withPeersOnPage = (pageImages: Image[]) => {
    const ids = new Set<string>();
    pageImages.forEach((img) => getPeerImageIds(img.id).forEach((pid) => ids.add(String(pid))));
    return Array.from(ids);
  };

  // Assign/Remove class to/from all images on current page (toggle behavior)
  const handleAssignToAllOnPage = (className: string) => {
    const updatedClassifications = { ...classifications };
    const targetImageIds = withPeersOnPage(paginatedImages);
    
    // Check if all images in selection already have this class
    const allImagesHaveClass = targetImageIds.every(imageId => {
      const currentClasses = updatedClassifications[imageId] || [];
      return currentClasses.includes(className);
    });
    
    let processedCount = 0;
    
    if (allImagesHaveClass) {
      // Remove class from all selected images (including peer collections)
      targetImageIds.forEach((imageId) => {
        const currentClasses = updatedClassifications[imageId] || [];
        if (currentClasses.includes(className)) {
          updatedClassifications[imageId] = currentClasses.filter(c => c !== className);
          processedCount++;
        }
      });
      
      saveClassifications(updatedClassifications);
      
      toast({
        title: "Class removed",
        description: `Removed "${className}" from ${processedCount} linked images`,
      });
    } else {
      // Add class to all selected images (including peer collections)
      targetImageIds.forEach((imageId) => {
        const currentClasses = updatedClassifications[imageId] || [];
        if (!currentClasses.includes(className)) {
          updatedClassifications[imageId] = [...currentClasses, className];
          processedCount++;
        }
      });
      
      saveClassifications(updatedClassifications);
      
      toast({
        title: "Class assigned",
        description: `Assigned "${className}" to ${processedCount} linked images`,
      });
    }
  };

  // Assign/Remove class to/from unclassified images on current page (toggle behavior)
  const handleAssignWithoutClasses = (className: string) => {
    const updatedClassifications = { ...classifications };
    
    // Get all unclassified images on the page
    const targetImageIds = withPeersOnPage(paginatedImages);
    const unclassifiedImageIds = targetImageIds.filter((imageId) => {
      const currentClasses = updatedClassifications[imageId] || [];
      return currentClasses.length === 0;
    });
    
    // Get images that only have this specific class (were previously assigned via AU)
    const imagesWithOnlyThisClass = targetImageIds.filter((imageId) => {
      const currentClasses = updatedClassifications[imageId] || [];
      return currentClasses.length === 1 && currentClasses[0] === className;
    });
    
    let processedCount = 0;
    
    if (imagesWithOnlyThisClass.length > 0 && unclassifiedImageIds.length === 0) {
      // If there are images with only this class and no unclassified images, remove the class
      imagesWithOnlyThisClass.forEach((imageId) => {
        updatedClassifications[imageId] = [];
        processedCount++;
      });
      
      saveClassifications(updatedClassifications);
      
      toast({
        title: "Class removed from previously assigned",
        description: `Removed "${className}" from ${processedCount} images, making them unclassified`,
      });
    } else {
      // Assign class to unclassified images
      unclassifiedImageIds.forEach((imageId) => {
        updatedClassifications[imageId] = [className];
        processedCount++;
      });
      
      saveClassifications(updatedClassifications);
      
      toast({
        title: "Class assigned to unclassified",
        description: `Assigned "${className}" to ${processedCount} unclassified images on this page`,
      });
    }
  };

  // Handle pagination
  const handlePageChange = (page: number) => {
    setCurrentPage(page);
  };

  const handlePrevPage = () => {
    if (currentPage > 1) {
      setCurrentPage(currentPage - 1);
    }
  };

  const handleNextPage = () => {
    if (currentPage < totalPages) {
      setCurrentPage(currentPage + 1);
    }
  };

  // Handle image size change
  const handleImageSizeChange = (value: number[]) => {
    updateImageSize(value[0]);
  };

  // Go to next page with unlabeled images
  const handleGoToUnlabelled = () => {
    const imagesPerPage = settings.imagesPerPage;
    
    for (let page = 1; page <= totalPages; page++) {
      const startIndex = (page - 1) * imagesPerPage;
      const endIndex = Math.min(startIndex + imagesPerPage, images.length);
      const pageImages = images.slice(startIndex, endIndex);
      
      // Check if this page has any unlabeled images
      const hasUnlabeled = pageImages.some(image => {
        const imageClasses = classifications[image.id] || [];
        return imageClasses.length === 0;
      });
      
      if (hasUnlabeled) {
        setCurrentPage(page);
        toast({
          title: "Navigated to unlabeled images",
          description: `Moved to page ${page} which contains unlabeled images`,
        });
        return;
      }
    }
    
    toast({
      title: "No unlabeled images found",
      description: "All images have been classified",
    });
  };

  // Handle back to dataset navigation
  const handleBackToDataset = () => {
    // Ensure the dataset view shows both Images and Annotations
    // If current layout is 'images-only' or 'annotations-only', change to horizontal
    if (settings.layout === 'images-only' || settings.layout === 'annotations-only') {
      updateLayout('horizontal');
    }
    // Navigate to dataset page (project-scoped URL when available so images load correctly)
    if (projectId && id) {
      navigate(`/projects/${projectId}/datasets/${id}`);
    } else if (id) {
      navigate(`/datasets/${id}`);
    }
  };

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle shortcuts when no input is focused
      if (e.target instanceof HTMLInputElement) return;
      
      // Handle arrow keys for page navigation
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (currentPage > 1) {
          setCurrentPage(currentPage - 1);
          toast({
            title: "Previous page",
            description: `Moved to page ${currentPage - 1}`,
          });
        }
        return;
      }
      
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (currentPage < totalPages) {
          setCurrentPage(currentPage + 1);
          toast({
            title: "Next page",
            description: `Moved to page ${currentPage + 1}`,
          });
        }
        return;
      }
      
      // Handle number keys 1-9 to select classes
      if (e.key >= '1' && e.key <= '9') {
        const classIndex = parseInt(e.key) - 1;
        if (classIndex < classes.length) {
          e.preventDefault();
          const selectedClassName = classes[classIndex];
          setSelectedClass(selectedClassName);
          toast({
            title: "Class selected",
            description: `Selected "${selectedClassName}" (shortcut ${e.key})`,
          });
        }
        return;
      }
      
      if (selectedClass && e.ctrlKey) {
        if (e.key === 'a') {
          e.preventDefault();
          handleAssignToAllOnPage(selectedClass);
        } else if (e.key === 'u') {
          e.preventDefault();
          handleAssignWithoutClasses(selectedClass);
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [selectedClass, classes, currentPage, totalPages, toast, handleAssignToAllOnPage, handleAssignWithoutClasses]);

  // Cleanup effect: Clear classification data when leaving the page
  // Since classifications are uploaded to annotations, we don't need to persist them
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      // Warn user if they have unsaved work and haven't saved to annotations
      if (Object.keys(classifications).length > 0) {
        e.preventDefault();
        e.returnValue = 'You have unsaved classifications. Make sure to save before leaving!';
        return 'You have unsaved classifications. Make sure to save before leaving!';
      }
    };

    const handleVisibilityChange = () => {
      // Clear data when page becomes hidden (user switched tabs/minimized)
      if (document.hidden && storage && id) {
        storage.clearData();
        console.log('Classification data cleared - page hidden');
      }
    };

    // Clear data when component unmounts (user navigates away)
    const cleanup = () => {
      if (storage && id) {
        storage.clearData();
        console.log('Classification data cleared - component unmounted');
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      cleanup();
    };
  }, [classifications, storage, id]);

  // Convert classification data to COCO format
  const convertToCOCOFormat = () => {
    // Get unique classes and create categories
    const allClasses = [...new Set(Object.values(classifications).flat())];
    const categories = allClasses.map((className, index) => ({
      id: index + 1,
      name: className
    }));

    // Create category name to ID mapping
    const categoryMap: { [name: string]: number } = {};
    categories.forEach(cat => {
      categoryMap[cat.name] = cat.id;
    });

    // Create images array
    const cocoImages = allKnownImages.map((image, index) => ({
      id: index + 1,
      file_name: image.fileName,
      width: image.width || 640,
      height: image.height || 480
    }));

    // Create image filename to ID mapping
    const imageMap: { [fileName: string]: number } = {};
    cocoImages.forEach(img => {
      imageMap[img.file_name] = img.id;
    });

    // Create annotations array
    const cocoAnnotations: any[] = [];
    let annotationId = 1;

    allKnownImages.forEach(image => {
      const imageClasses = classifications[image.id] || [];
      const imageId = imageMap[image.fileName];
      
      imageClasses.forEach(className => {
        const categoryId = categoryMap[className];
        if (categoryId) {
          cocoAnnotations.push({
            id: annotationId++,
            image_id: imageId,
            category_id: categoryId
          });
        }
      });
    });

    return {
      images: cocoImages,
      annotations: cocoAnnotations,
      categories: categories
    };
  };

  // Download annotations as JSON file
  const handleDownload = async () => {
    try {
      // Convert to COCO format
      const cocoData = convertToCOCOFormat();

      // Create filename with the requested format: project_id_dataset_id_page_number_images_per_page.json
      const fileName = `project_${id}_dataset_${id}_page_${currentPage}_images_${settings.imagesPerPage}.json`;

      // Create JSON file and download
      const jsonContent = JSON.stringify(cocoData, null, 2);
      const blob = new Blob([jsonContent], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      toast({
        title: "File downloaded",
        description: `Classification data downloaded as ${fileName}`,
      });

    } catch (error) {
      console.error('Error downloading file:', error);
      toast({
        title: "Download failed",
        description: error instanceof Error ? error.message : "Failed to download file",
        variant: "destructive",
      });
    }
  };

  // Save annotations (either update existing or create new with dialog)
  const handleSave = async () => {
    if (annotationId) {
      // If editing existing annotation file, directly update it
      await handleSaveExistingAnnotation();
    } else {
      // If creating new annotations, ask for filename and then save
      const defaultName = `classification_dataset_${id}_${new Date().toISOString().split('T')[0]}`;
      setUploadFileName(defaultName);
      setUploadDialogOpen(true);
    }
  };

  // Save existing annotation file (direct update)
  const handleSaveExistingAnnotation = async () => {
    if (!annotationId) return;

    try {
      // Convert to COCO format
      const cocoData = convertToCOCOFormat();
      const fileName = uploadFileName.trim() || `classification_updated_${new Date().toISOString().split('T')[0]}.json`;
      const fullFileName = fileName.endsWith('.json') ? fileName : `${fileName}.json`;

      // Create JSON file
      const jsonContent = JSON.stringify(cocoData, null, 2);

      // Update via backend if API is available
      if (api) {
        try {
          const file = new File([jsonContent], fullFileName, { type: 'application/json' });
          const result = await api.updateAnnotationContent(id!, annotationId, file);
          
          if (result.success) {
            // Also update localStorage for annotations display
            try {
              const savedAnnotations = localStorage.getItem(`saved_annotations_${id}`);
              if (savedAnnotations) {
                let annotationsList: any[] = JSON.parse(savedAnnotations);
                const existingIndex = annotationsList.findIndex((ann: any) => ann.id === annotationId);
                if (existingIndex >= 0) {
                  annotationsList[existingIndex] = {
                    ...annotationsList[existingIndex],
                    content: cocoData,
                    name: fullFileName,
                    date: new Date().toISOString().split('T')[0],
                    classCount: cocoData.categories?.length || 0,
                    imageCount: cocoData.images?.length || 0,
                  };
                  localStorage.setItem(`saved_annotations_${id}`, JSON.stringify(annotationsList));
                }
              }
            } catch (storageError) {
              console.error('Failed to update localStorage:', storageError);
            }
            
            toast({
              title: "Annotation updated",
              description: `Classification annotations have been updated successfully`,
            });
            
          } else {
            throw new Error(result.error || 'Failed to update annotation');
          }
        } catch (updateError) {
          console.error('Failed to update annotation:', updateError);
          toast({
            title: "Update failed",
            description: updateError instanceof Error ? updateError.message : 'Unknown error occurred',
            variant: "destructive",
          });
        }
      } else {
        // When no API is available, update localStorage
        try {
          const savedAnnotations = localStorage.getItem(`saved_annotations_${id}`);
          if (savedAnnotations) {
            let annotationsList: any[] = JSON.parse(savedAnnotations);
            const existingIndex = annotationsList.findIndex((ann: any) => ann.id === annotationId);
            if (existingIndex >= 0) {
              annotationsList[existingIndex] = {
                ...annotationsList[existingIndex],
                content: cocoData,
                name: fullFileName,
                date: new Date().toISOString().split('T')[0],
                classCount: cocoData.categories?.length || 0,
                imageCount: cocoData.images?.length || 0,
              };
              localStorage.setItem(`saved_annotations_${id}`, JSON.stringify(annotationsList));
              
              toast({
                title: "Annotation updated",
                description: `Classification annotations updated locally`,
              });
            }
          }
        } catch (storageError) {
          console.error('Failed to save to localStorage:', storageError);
          toast({
            title: "Update failed", 
            description: "Failed to update annotations locally",
            variant: "destructive",
          });
        }
      }

    } catch (error) {
      console.error('Error updating annotations:', error);
      toast({
        title: "Update failed",
        description: error instanceof Error ? error.message : "Failed to update annotations",
        variant: "destructive",
      });
    }
  };

  // Upload new annotation file to dataset (from dialog)
  const handleUpload = async () => {
    if (!uploadFileName.trim()) {
      toast({
        title: "Name required",
        description: "Please enter a name for the annotation file",
        variant: "destructive",
      });
      return;
    }

    try {
      // Convert to COCO format
      const cocoData = convertToCOCOFormat();
      const fileName = uploadFileName.trim().endsWith('.json') ? uploadFileName.trim() : `${uploadFileName.trim()}.json`;

      // Create JSON file
      const jsonContent = JSON.stringify(cocoData, null, 2);

      // Upload to backend if API is available
      if (api) {
        try {
          const file = new File([jsonContent], fileName, { type: 'application/json' });
          
          let result;
          if (annotationId) {
            // Update existing annotation
            result = await api.updateAnnotationContent(id!, annotationId, file);
          } else {
            // Create new annotation
            result = await api.importAnnotations(id!, file, 'classification');
          }
          
          if (result.success) {
            // Also save to localStorage for annotations display
            try {
              const savedAnnotations = localStorage.getItem(`saved_annotations_${id}`);
              let annotationsList: any[] = savedAnnotations ? JSON.parse(savedAnnotations) : [];
              
              if (annotationId) {
                // Update existing annotation in localStorage
                const existingIndex = annotationsList.findIndex((ann: any) => ann.id === annotationId);
                if (existingIndex >= 0) {
                  annotationsList[existingIndex] = {
                    ...annotationsList[existingIndex],
                    content: cocoData,
                    name: fileName,
                    date: new Date().toISOString().split('T')[0],
                    classCount: cocoData.categories?.length || 0,
                    imageCount: cocoData.images?.length || 0,
                  };
                }
              } else {
                // Add new classification annotation
                const newAnnotationId = result.data?.file_id || `classification_${Date.now()}`;
                const annotationFile = {
                  id: newAnnotationId,
                  name: fileName,
                  date: new Date().toISOString().split('T')[0],
                  format: 'COCO',
                  type: 'classification',
                  classCount: cocoData.categories?.length || 0,
                  imageCount: cocoData.images?.length || 0,
                  matchedImageCount: 0,
                  datasetId: id!,
                  classStats: [],
                  samples: [],
                  isVisible: true,
                  classColors: classColors,
                  imageMapping: {},
                  content: cocoData
                };
                
                annotationsList.unshift(annotationFile);
              }
              
              localStorage.setItem(`saved_annotations_${id}`, JSON.stringify(annotationsList));
            } catch (storageError) {
              console.error('Failed to save to localStorage:', storageError);
            }
            
            toast({
              title: "Annotation saved", 
              description: annotationId 
                ? `Classification annotations updated in dataset`
                : `Classification annotations saved as "${fileName}" and uploaded to dataset`,
            });
            
            // Clear classification data after successful upload since it's now stored as annotations
            if (storage && !annotationId) {
              storage.clearData();
              console.log('Classification data cleared after successful upload');
            }

            // Close dialog and reset filename
            setUploadDialogOpen(false);
            setUploadFileName("");
            
            // If creating new annotation, navigate to edit mode
            if (!annotationId) {
              const newAnnotationId = result.data?.file_id || `classification_${Date.now()}`;
              const collectionQ =
                selectedCollectionId !== "all" ? `&collectionId=${selectedCollectionId}` : "";
              if (projectId && id) {
                navigate(`/projects/${projectId}/datasets/${id}/annotate/classification?annotationId=${newAnnotationId}${collectionQ}`);
              } else {
                navigate(`/datasets/${id}/annotate/classification?annotationId=${newAnnotationId}${collectionQ}`);
              }
            }
            
          } else {
            throw new Error(result.error || 'Failed to save to dataset');
          }
        } catch (uploadError) {
          console.error('Failed to save to dataset:', uploadError);
          toast({
            title: "Save failed",
            description: uploadError instanceof Error ? uploadError.message : 'Unknown error occurred',
            variant: "destructive",
          });
        }
      } else {
        // When no API is available, save to localStorage for annotations display
        try {
          const savedAnnotations = localStorage.getItem(`saved_annotations_${id}`);
          let annotationsList: any[] = savedAnnotations ? JSON.parse(savedAnnotations) : [];
          
          if (annotationId) {
            // Update existing annotation in localStorage
            const existingIndex = annotationsList.findIndex((ann: any) => ann.id === annotationId);
            if (existingIndex >= 0) {
              annotationsList[existingIndex] = {
                ...annotationsList[existingIndex],
                content: cocoData,
                name: fileName,
                date: new Date().toISOString().split('T')[0],
                classCount: cocoData.categories?.length || 0,
                imageCount: cocoData.images?.length || 0,
              };
            }
          } else {
            // Add new classification annotation
            const newAnnotationId = `classification_${Date.now()}`;
            const annotationFile = {
              id: newAnnotationId,
              name: fileName,
              date: new Date().toISOString().split('T')[0],
              format: 'COCO',
              type: 'classification',
              classCount: cocoData.categories?.length || 0,
              imageCount: cocoData.images?.length || 0,
              matchedImageCount: 0,
              datasetId: id!,
              classStats: [],
              samples: [],
              isVisible: true,
              classColors: classColors,
              imageMapping: {},
              content: cocoData
            };
            
            annotationsList.unshift(annotationFile);
          }
          
          localStorage.setItem(`saved_annotations_${id}`, JSON.stringify(annotationsList));
          
          toast({
            title: "Annotation saved",
            description: annotationId 
              ? `Classification annotations updated locally`
              : `Classification annotations saved locally as "${fileName}"`,
          });

          // Close dialog and reset filename
          setUploadDialogOpen(false);
          setUploadFileName("");
          
          // If creating new annotation, navigate to edit mode
          if (!annotationId) {
            const newAnnotationId = `classification_${Date.now()}`;
            const collectionQ =
              selectedCollectionId !== "all" ? `&collectionId=${selectedCollectionId}` : "";
            if (projectId && id) {
              navigate(`/projects/${projectId}/datasets/${id}/annotate/classification?annotationId=${newAnnotationId}${collectionQ}`);
            } else {
              navigate(`/datasets/${id}/annotate/classification?annotationId=${newAnnotationId}${collectionQ}`);
            }
          }
          
        } catch (storageError) {
          console.error('Failed to save to localStorage:', storageError);
          toast({
            title: "Save failed", 
            description: "Failed to save annotations locally",
            variant: "destructive",
          });
        }
      }

    } catch (error) {
      console.error('Error saving annotations:', error);
      toast({
        title: "Save failed",
        description: error instanceof Error ? error.message : "Failed to save annotations",
        variant: "destructive",
      });
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col">
        <Navbar />
        <main className="flex-1 flex items-center justify-center pt-16">
          <div className="text-center">
            <div className="text-lg mb-2">Loading...</div>
            {!isConfigured && <div className="text-sm text-muted-foreground">Configuring API connection...</div>}
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />
      <main className="flex-1 flex flex-col pt-16">
        {/* Header */}
        <div className="px-6 py-4 border-b bg-background">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Button variant="ghost" onClick={handleBackToDataset}>
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back to Dataset
              </Button>
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="text-2xl font-semibold">Classification</h1>
                  {imageCollections.length > 1 && (
                    <Badge variant="secondary" className="text-[11px] py-0.5 px-2">
                      {selectedCollectionId === "all"
                        ? "All collections"
                        : imageCollections.find(c => String(c.id) === String(selectedCollectionId))?.name ||
                          "Collection"}
                    </Badge>
                  )}
                  {annotationId && annotationName && (
                    <Badge className="bg-yellow-500/20 text-yellow-300 border-yellow-500/40 text-xs">
                      Editing {annotationName}
                    </Badge>
                  )}
                </div>
                <p className="text-muted-foreground">
                  Assign class labels to images ({collectionImages.length} visible / {allKnownImages.length} total)
                </p>
                {showNavigationTip && (
                  <div className="text-xs text-blue-400 mt-1">
                    Use ← → to navigate page
                  </div>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button onClick={handleSave} variant="outline">
                <Save className="h-4 w-4 mr-2" />
                Save
              </Button>
              <Button onClick={handleDownload}>
                <Download className="h-4 w-4 mr-2" />
                Download
              </Button>
              {sessionOnly && (
                <Badge variant="destructive" className="ml-2">
                  Session Only
                </Badge>
              )}
              <Button 
                variant="outline" 
                onClick={handleGoToUnlabelled}
                className="mr-4"
              >
                Go to Unlabelled
              </Button>
              <Button
                variant="outline"
                size="icon"
                onClick={handlePrevPage}
                disabled={currentPage === 1}
                onMouseEnter={() => setShowNavigationTip(true)}
                onMouseLeave={() => setShowNavigationTip(false)}
                onFocus={() => setShowNavigationTip(true)}
                onBlur={() => setShowNavigationTip(false)}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="text-sm text-muted-foreground px-3">
                Page {currentPage} of {totalPages}
              </span>
              <Button
                variant="outline"
                size="icon"
                onClick={handleNextPage}
                disabled={currentPage === totalPages}
                onMouseEnter={() => setShowNavigationTip(true)}
                onMouseLeave={() => setShowNavigationTip(false)}
                onFocus={() => setShowNavigationTip(true)}
                onBlur={() => setShowNavigationTip(false)}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>

        <div className="flex-1 flex">
          {/* Main Content */}
          <div className="flex-1 p-6">
            {/* Controls */}
            <div className="mb-6">
              <ImageDisplayControls
                imagesPerPage={settings.imagesPerPage}
                onImagesPerPageChange={updateImagesPerPage}
                imageSize={settings.imageSize}
                onImageSizeChange={handleImageSizeChange}
              />
              {imageCollections.length > 0 && (
                <div className="mt-3 max-w-sm">
                  <Select value={selectedCollectionId} onValueChange={setSelectedCollectionId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select image collection" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All collections</SelectItem>
                      {imageCollections.map((collection) => (
                        <SelectItem key={String(collection.id)} value={String(collection.id)}>
                          {collection.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            {/* Images Grid */}
            <div className="mb-6">
              <div 
                className="grid gap-4"
                style={{
                  gridTemplateColumns: `repeat(auto-fill, minmax(${settings.imageSize}px, 1fr))`
                }}
              >
                {paginatedImages.map((image) => {
                  const imageClasses = classifications[image.id] || [];
                  return (
                    <Card key={image.id} className="overflow-hidden">
                      <div className="relative">
                        <img
                          src={image.url}
                          alt={image.fileName}
                          className="w-full aspect-square object-cover"
                          loading="lazy"
                          style={{ height: `${settings.imageSize}px` }}
                        />
                        {imageClasses.length > 0 && (
                          <div className="absolute top-2 left-2">
                            <Badge variant="secondary" className="text-xs">
                              {imageClasses.length} class{imageClasses.length !== 1 ? 'es' : ''}
                            </Badge>
                          </div>
                        )}
                      </div>
                      <CardContent className="p-3">
                        <p className="text-xs text-muted-foreground truncate mb-2">
                          {image.fileName}
                        </p>
                        <div className="space-y-1">
                          {classes.map((className) => {
                            const isAssigned = imageClasses.includes(className);
                            const classColor = getClassColor(className);
                            return (
                              <Button
                                key={className}
                                variant={isAssigned ? "default" : "outline"}
                                size="sm"
                                className="w-full h-7 text-xs flex items-center justify-start gap-2"
                                onClick={() => handleImageClassToggle(image.id, className)}
                                style={isAssigned ? { backgroundColor: classColor, borderColor: classColor } : { borderColor: classColor }}
                              >
                                <div 
                                  className="w-2 h-2 rounded-full flex-shrink-0" 
                                  style={{ backgroundColor: classColor }}
                                />
                                {isAssigned && <Check className="h-3 w-3 flex-shrink-0" />}
                                <span className="truncate">{className}</span>
                              </Button>
                            );
                          })}
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </div>

            {/* Pagination */}
            <PaginationControls
              currentPage={currentPage}
              totalPages={totalPages}
              onPageChange={handlePageChange}
            />
          </div>

          {/* Class Management Panel */}
          <div className="w-80 border-l bg-background p-6">
            <ScrollArea className="h-full">
              <div className="space-y-6">
                <div>
                  <h3 className="text-lg font-semibold mb-2">Annotation Tools</h3>
                  <p className="text-xs text-muted-foreground mb-4">
                    Manage classes, view statistics, and configure storage
                  </p>
                  
                  <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
                    <TabsList className="grid w-full grid-cols-3 bg-gray-800/50 border border-gray-700">
                      <TabsTrigger 
                        value="class-management"
                        className="data-[state=active]:bg-blue-600 data-[state=active]:text-white text-sm"
                      >
                        <Settings className="h-4 w-4 mr-2" />
                        Classes
                      </TabsTrigger>
                      <TabsTrigger 
                        value="statistics"
                        className="data-[state=active]:bg-blue-600 data-[state=active]:text-white text-sm"
                      >
                        <BarChart3 className="h-4 w-4 mr-2" />
                        Stats
                      </TabsTrigger>
                      <TabsTrigger 
                        value="storage"
                        className="data-[state=active]:bg-blue-600 data-[state=active]:text-white text-sm"
                      >
                        <Database className="h-4 w-4 mr-2" />
                        Storage
                      </TabsTrigger>
                    </TabsList>

                    <TabsContent value="class-management" className="mt-4 space-y-4">
                  {/* Add new class */}
                  <div className="flex gap-2 mb-4">
                    <Input
                      value={newClass}
                      onChange={(e) => setNewClass(e.target.value)}
                      placeholder="Add new class"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          handleAddClass();
                        }
                      }}
                    />
                    <Button onClick={handleAddClass} size="icon">
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>

                  {/* Available classes */}
                  <div className="space-y-2">
                    <h4 className="text-sm font-medium text-muted-foreground">
                      Available Classes ({classes.length})
                      <span className="text-xs ml-2 opacity-60">Click to select • Keys 1-9 for shortcuts</span>
                    </h4>
                    {classes.map((className, index) => {
                      const totalAssigned = Object.values(classifications).filter(
                        imageClasses => imageClasses.includes(className)
                      ).length;
                      const shortcutKey = index < 9 ? (index + 1).toString() : null;
                      
                      return (
                        <Card 
                          key={className} 
                          className={`p-3 cursor-pointer transition-colors ${
                            selectedClass === className ? 'ring-2 ring-primary bg-primary/5' : ''
                          }`}
                          onClick={() => setSelectedClass(selectedClass === className ? null : className)}
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex-1">
                              <div className="flex items-center gap-2">
                                {/* Color indicator */}
                                <div className="relative">
                                  <button
                                    className="w-5 h-5 rounded-full border-2 border-gray-500 hover:border-gray-300 transition-colors"
                                    style={{ backgroundColor: getClassColor(className) }}
                                    onClick={(e) => e.stopPropagation()}
                                    title="Click to change color"
                                  >
                                    <input
                                      type="color"
                                      value={getClassColor(className)}
                                      onChange={(e) => handleClassColorChange(className, e.target.value)}
                                      className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                                      onClick={(e) => e.stopPropagation()}
                                    />
                                  </button>
                                </div>
                                <p className="font-medium">{className}</p>
                                {shortcutKey && (
                                  <Badge 
                                    variant={selectedClass === className ? "default" : "outline"} 
                                    className={`text-xs px-1.5 py-0.5 h-5 ${
                                      selectedClass === className ? 'bg-primary text-primary-foreground' : ''
                                    }`}
                                  >
                                    {shortcutKey}
                                  </Badge>
                                )}
                              </div>
                              <p className="text-xs text-muted-foreground">
                                {totalAssigned} image{totalAssigned !== 1 ? 's' : ''} assigned
                              </p>
                            </div>
                            <div className="flex items-center gap-1">
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleRemoveClass(className);
                                }}
                              >
                                <X className="h-4 w-4" />
                              </Button>
                            </div>
                          </div>
                        </Card>
                      );
                    })}
                  </div>

                  {/* Bulk operations */}
                  {selectedClass && (
                    <div className="mt-4">
                      <h4 className="text-sm font-medium text-muted-foreground mb-3">
                        Bulk Operations
                      </h4>
                      <Card className="p-3">
                        <p className="text-sm mb-3">Selected: {selectedClass}</p>
                        <div className="space-y-2">
                          {(() => {
                            // Check if all images on page have the selected class
                            const allImagesHaveClass = paginatedImages.every(image => {
                              const imageClasses = classifications[image.id] || [];
                              return imageClasses.includes(selectedClass);
                            });
                            
                            return (
                              <Button
                                variant="outline"
                                size="sm"
                                className="w-full"
                                onClick={() => handleAssignToAllOnPage(selectedClass)}
                                title={allImagesHaveClass 
                                  ? "Remove from all images on page (Ctrl+A)" 
                                  : "Assign to all images on page (Ctrl+A)"
                                }
                              >
                                {allImagesHaveClass ? "AP - Remove from All" : "AP - Assign to All"}
                                <span className="ml-2 text-xs opacity-60">Ctrl+A</span>
                              </Button>
                            );
                          })()}
                          {(() => {
                            // Check for unclassified images and images with only this class
                            const unclassifiedImages = paginatedImages.filter(image => {
                              const imageClasses = classifications[image.id] || [];
                              return imageClasses.length === 0;
                            });
                            
                            const imagesWithOnlyThisClass = paginatedImages.filter(image => {
                              const imageClasses = classifications[image.id] || [];
                              return imageClasses.length === 1 && imageClasses[0] === selectedClass;
                            });
                            
                            const shouldShowRemove = imagesWithOnlyThisClass.length > 0 && unclassifiedImages.length === 0;
                            
                            return (
                              <Button
                                variant="outline"
                                size="sm"
                                className="w-full"
                                onClick={() => handleAssignWithoutClasses(selectedClass)}
                                title={shouldShowRemove
                                  ? "Remove from previously assigned, making them unclassified (Ctrl+U)"
                                  : "Assign to unclassified images on page (Ctrl+U)"
                                }
                              >
                                {shouldShowRemove ? "AU - Remove & Unclassify" : "AU - Assign Unclassified"}
                                <span className="ml-2 text-xs opacity-60">Ctrl+U</span>
                              </Button>
                            );
                          })()}
                        </div>
                      </Card>
                    </div>
                  )}
                    </TabsContent>

                    <TabsContent value="statistics" className="mt-4">
                      <div>
                        <h4 className="text-sm font-medium text-muted-foreground mb-3">
                          Statistics
                        </h4>
                        <Card className="p-3">
                          <div className="space-y-2 text-sm">
                            <div className="flex justify-between">
                              <span>Total Images:</span>
                              <span>{images.length}</span>
                            </div>
                            <div className="flex justify-between">
                              <span>Total Classes:</span>
                              <span>{classes.length}</span>
                            </div>
                            <div className="flex justify-between">
                              <span>Classified Images:</span>
                              <span>
                                {Object.keys(classifications).filter(
                                  imageId => classifications[imageId].length > 0
                                ).length}
                              </span>
                            </div>
                            <div className="flex justify-between">
                              <span>Unclassified Images:</span>
                              <span>
                                {images.length - Object.keys(classifications).filter(
                                  imageId => classifications[imageId].length > 0
                                ).length}
                              </span>
                            </div>
                            <hr className="my-2" />
                            <div className="flex justify-between text-xs">
                              <span>Storage Mode:</span>
                              <span className={sessionOnly ? 'text-orange-600' : 'text-green-600'}>
                                {sessionOnly ? 'Session Only' : 'Persistent'}
                              </span>
                            </div>
                            {storage && (() => {
                              const stats = storage.getStorageStats();
                              return (
                                <>
                                  <div className="flex justify-between text-xs">
                                    <span>Storage Used:</span>
                                    <span>{(stats.totalSize / 1024).toFixed(1)} KB</span>
                                  </div>
                                  {stats.savings > 0 && (
                                    <div className="flex justify-between text-xs text-green-600">
                                      <span>Space Saved:</span>
                                      <span>{stats.savings.toFixed(1)}%</span>
                                    </div>
                                  )}
                                </>
                              );
                            })()}
                            {sessionOnly && (
                              <div className="mt-2 p-2 bg-orange-50 border border-orange-200 rounded text-xs text-orange-800">
                                ⚠️ Session mode: Data won't persist after reload. Save before leaving!
                              </div>
                            )}
                          </div>
                        </Card>
                      </div>
                    </TabsContent>

                    <TabsContent value="storage" className="mt-4">
                      <div>
                        <h4 className="text-sm font-medium text-muted-foreground mb-3">
                          Storage Management
                        </h4>
                        <Card className="p-3">
                          <div className="space-y-2">
                            <Button
                              variant="outline"
                              size="sm"
                              className="w-full"
                              onClick={() => {
                                const cleanedCount = LocalStorageCleanup.cleanupClassificationData(2);
                                toast({
                                  title: "Storage cleaned",
                                  description: `Removed ${cleanedCount} old classification datasets`,
                                });
                              }}
                            >
                              Clean Old Data
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              className="w-full"
                              onClick={() => {
                                const analysis = LocalStorageCleanup.analyzeUsage();
                                const totalMB = (analysis.totalSize / (1024 * 1024)).toFixed(2);
                                toast({
                                  title: "Storage Analysis",
                                  description: `Total usage: ${totalMB} MB. Check console for details.`,
                                });
                                console.log('Storage Analysis:', analysis);
                              }}
                            >
                              Analyze Storage
                            </Button>
                            {storage && (
                              <Button
                                variant="outline"
                                size="sm"
                                className="w-full"
                                onClick={() => {
                                  storage.clearData();
                                  setClassifications({});
                                  setClasses([]);
                                  toast({
                                    title: "Data cleared",
                                    description: "All classification data has been cleared",
                                  });
                                }}
                              >
                                Clear Current Data
                              </Button>
                            )}
                          </div>
                        </Card>
                      </div>
                    </TabsContent>
                  </Tabs>
                </div>
              </div>
            </ScrollArea>
          </div>
        </div>
      </main>

      {/* Save Dialog */}
      <Dialog open={uploadDialogOpen} onOpenChange={setUploadDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save Classification Annotations</DialogTitle>
            <DialogDescription>
              Enter a name for your classification annotation file to save it to the dataset.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Input
              placeholder="Enter annotation file name..."
              value={uploadFileName}
              onChange={(e) => setUploadFileName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && uploadFileName.trim()) {
                  handleUpload();
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUploadDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleUpload} disabled={!uploadFileName.trim()}>
              <Save className="h-4 w-4 mr-2" />
              Save to Dataset
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Class Confirmation */}
      <ConfirmDeleteDialog
        open={deleteConfirmDialog.isOpen}
        onOpenChange={(open) =>
          !open && setDeleteConfirmDialog({ isOpen: false, className: '', annotationCount: 0 })
        }
        entity="class"
        itemName={deleteConfirmDialog.className}
        consequences={
          deleteConfirmDialog.annotationCount > 0
            ? [`${deleteConfirmDialog.annotationCount} annotation${deleteConfirmDialog.annotationCount !== 1 ? 's' : ''} using this class will also be deleted.`]
            : undefined
        }
        confirmLabel="Delete class"
        onConfirm={handleConfirmDeleteClass}
      />
    </div>
  );
}