import React, { useState, useEffect, useRef, useCallback, useMemo, lazy, Suspense } from 'react';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Slider } from '@/components/ui/slider';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { 
  ArrowLeft, 
  Save, 
  Trash2, 
  Square, 
  Circle, 
  MousePointer2, 
  ZoomIn, 
  ZoomOut, 
  RotateCcw,
  Download,
  Upload,
  Eye,
  EyeOff,
  Palette,
  Plus,
  Edit,
  Check,
  X,
  Layers,
  ChevronLeft, 
  ChevronRight,
  BarChart,
  Loader2,
  AlertCircle,
  Hexagon,
  Sun,
  Moon,
  Crosshair,
  Pencil,
  SkipForward,
  Filter as FilterIcon,
} from 'lucide-react';
import { AnnotationMinimap } from '@/components/AnnotationMinimap';
import { AnnotationStatusBar } from '@/components/AnnotationStatusBar';
import { CompanionLayersPanel } from '@/components/annotation/CompanionLayersPanel';
import {
  readCompanionDuplicateIds,
  readCopyOffCollectionIds,
} from '@/components/annotation/companionDuplicatePrefs';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { useTheme } from '@/components/ThemeProvider';
import { useQuery } from '@tanstack/react-query';
import { API_CONFIG, resolveBackendMediaUrl } from '@/config/api';
import {
  imageAnnotationApiBase,
  patchAnnotationImageUrl,
  segmentApiUrl,
} from '@/hooks/use-image-annotation-api';
import {
  clearSamModelReadyCache,
  isSamModelCachedReady,
  setSamModelCachedReady,
  type SamSegmentModelKey,
} from '@/utils/samReadyCache';
import type { AnnotationClass, AnnotationShape, AnnotationTool, Point } from '@/pages/image-annotation/types';
import {
  SAM_MODEL_WAIT_OVERLAY_MS,
  DEFAULT_COLORS,
  bboxToRectPoints,
  bboxToRectPointsInPixelSpace,
  buildAutoSegmentMaskOverlayStyle,
  calculatePolygonArea,
  findCocoImageForDatasetName,
  findCorrespondingImageInCollection,
  formatArea,
  pickPreferredRgbCollection,
  pointsToBbox,
  resolveClassFilterToggleNavigation,
} from '@/pages/image-annotation/utils';

export type { AnnotationTool, Point, AnnotationShape, AnnotationClass } from '@/pages/image-annotation/types';
export { resolveClassFilterToggleNavigation, buildAutoSegmentMaskOverlayStyle };

import { useApi } from '@/hooks/use-api';
import { useToast } from '@/hooks/use-toast';
import { toast as sonnerToast } from 'sonner';
import { Image, ImageCollection } from '@/types';
import { applyClassColorsToAnnotations, resolveAnnotationDisplayColor } from '@/utils/annotationColorConsistency';
import { shouldScheduleAnnotationRedraw } from '@/utils/annotationRenderVisibility';
import { detectSegmentationModeCapabilities } from '@/utils/annotations';
import { downloadCocoFile, type CocoData } from '@/utils/downloadCoco';
import { cocoSegmentationToFlatCoords } from '@/utils/cocoSegmentation';

const AnnotationStatisticsCharts = lazy(
  () => import('@/components/annotation/AnnotationStatisticsCharts'),
);

type AnnotationMode = 'mask' | 'bbox';

const ImageAnnotation = () => {
  const { id, projectId } = useParams<{ id: string; projectId?: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { api } = useApi();
  const { toast } = useToast();
  const { theme, toggleTheme } = useTheme();

  // Get annotation ID from URL params if editing existing annotation
  const annotationId = searchParams.get('annotationId');
  const modeHint = searchParams.get('modeHint');
  /** Set `?debugAnnot=1` on the URL or `sessionStorage.setItem('debugAnnotFirst','1')` then reload — logs first-image / load races in the console (filter: AnnotDebug). */
  const debugAnnotFirst =
    typeof window !== 'undefined' &&
    (searchParams.get('debugAnnot') === '1' || sessionStorage.getItem('debugAnnotFirst') === '1');
  const logAnnotDebug = (label: string, payload?: Record<string, unknown>) => {
    if (!debugAnnotFirst) return;
    console.log(`[AnnotDebug] ${label}`, { ...payload, ts: Date.now() });
  };

  // Redirect legacy /datasets/:id/annotate/segmentation to project-scoped URL
  useEffect(() => {
    if (!id || projectId || !api) return;
    let cancelled = false;
    api.getDataset(id).then((res) => {
      if (cancelled || !res.success || !res.data?.project_id) return;
      const qs = new URLSearchParams();
      if (annotationId) qs.set('annotationId', annotationId);
      if (modeHint) qs.set('modeHint', modeHint);
      const q = qs.toString() ? `?${qs.toString()}` : '';
      navigate(`/projects/${res.data.project_id}/datasets/${id}/annotate/segmentation${q}`, { replace: true });
    });
    return () => { cancelled = true; };
  }, [id, projectId, api, navigate, annotationId, modeHint]);

  // Refs
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastDrawnVisibleAnnotationsRef = useRef(0);
  const lastDrawImageKeyRef = useRef<string>('');
  const imageRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Help popover visibility for zoom/pan instructions
  const [showHelp, setShowHelp] = useState(false);
  // Full keyboard cheatsheet overlay (triggered by '?')
  const [showCheatsheet, setShowCheatsheet] = useState(false);

  // State
  const [imageCollections, setImageCollections] = useState<ImageCollection[]>([]);
  const [currentImageIndex, setCurrentImageIndex] = useState(0);
  const [currentImageName, setCurrentImageName] = useState<string>('');
  const [displayLayer, setDisplayLayer] = useState<string>('');
  const [currentImage, setCurrentImage] = useState<Image | null>(null);
  const [displayImage, setDisplayImage] = useState<Image | null>(null);
  const [noCorrespondingImage, setNoCorrespondingImage] = useState(false);
  // Explicit annotation coordinate layer: when set to a collection id, annotation
  // coordinates are stored in that layer's pixel space and remapped for display/input.
  // Empty string = off (default — no cross-layer scaling).
  const [annotationLayerId, setAnnotationLayerId] = useState<string>('');
  const [allImageNames, setAllImageNames] = useState<string[]>([]);
  const [currentLayerImageNames, setCurrentLayerImageNames] = useState<string[]>([]);
  const [mainLayer, setMainLayer] = useState<string>(''); // The primary layer that drives navigation
  // Whether the side-by-side companion layer panel is shown. Persisted per session
  // so reopening the editor restores the user's preference.
  const [companionPanelOpen, setCompanionPanelOpen] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem('annotation-companion-panel-open') !== 'false';
    } catch { return true; }
  });
  useEffect(() => {
    try { sessionStorage.setItem('annotation-companion-panel-open', String(companionPanelOpen)); } catch {}
  }, [companionPanelOpen]);
  /**
   * Companion collections that should ALSO receive a copy of every annotation
   * save (so e.g. drawing on RGB also persists annotations under a thermal
   * collection's storage). Driven by the per-row toggle in the picker. We keep
   * a ref alongside state so save callbacks always see the latest selection
   * even from stale closures.
   */
  const [duplicateCollectionIds, setDuplicateCollectionIds] = useState<string[]>(() =>
    readCompanionDuplicateIds(),
  );
  const duplicateCollectionIdsRef = useRef<string[]>(duplicateCollectionIds);
  duplicateCollectionIdsRef.current = duplicateCollectionIds;

  const handleDuplicateCollectionIdsChange = useCallback((ids: string[]) => {
    duplicateCollectionIdsRef.current = ids;
    setDuplicateCollectionIds(ids);
  }, []);

  /**
   * Refs that mirror displayLayer / mainLayer so callbacks (createAnnotation,
   * drag-handlers, etc.) always read the *current* "active" collection id
   * even when their useCallback closure was captured before the user switched
   * layers. Without these, switching from RGB → Thermal would still save new
   * annotations under the old RGB key, leaving the Save button disabled and
   * making "annotate per collection" appear broken.
   *
   * We assign during render (not via useEffect) so the refs are guaranteed
   * to be in sync the moment any callback runs in the same React tick as
   * the state update.
   */
  const displayLayerRef = useRef<string>('');
  const mainLayerRef = useRef<string>('');
  displayLayerRef.current = displayLayer;
  mainLayerRef.current = mainLayer;
  /** Resolves the active "annotating" collection id at call time (not closure time). */
  const getActiveCollectionId = useCallback(() => {
    return displayLayerRef.current || mainLayerRef.current || 'default';
  }, []);
  const [isLayerSwitching, setIsLayerSwitching] = useState(false); // Prevent flicker during layer changes
  const layerSwitchCounterRef = useRef(0); // Increment on every layer switch to force image remount
  const [isLoading, setIsLoading] = useState(true);
  const [isInitialLoad, setIsInitialLoad] = useState(true); // Track initial load to prevent flickering
  const [activeTool, setActiveTool] = useState<AnnotationTool>('select');
  const [annotationMode, setAnnotationMode] = useState<AnnotationMode>('mask');
  const [modeLocked, setModeLocked] = useState(false);
  const [bboxSwitchAllowed, setBboxSwitchAllowed] = useState(true);
  const [modeLockReason, setModeLockReason] = useState<string | null>(null);
  // Display adjustments applied to the primary canvas image (does NOT
  // alter the source pixels — only the on-screen rendering via ctx.filter).
  const [imageBrightness, setImageBrightness] = useState(100); // %
  const [imageContrast, setImageContrast] = useState(100);     // %
  const [imageSaturation, setImageSaturation] = useState(100); // %
  const [annotations, setAnnotations] = useState<AnnotationShape[]>([]);
  const [annotationsLoadingForImage, setAnnotationsLoadingForImage] = useState<string | null>(null);
  /** Always matches latest `annotations` so async loaders don't read a stale closure for the early-return / skip-clear logic. */
  const annotationsRef = useRef<AnnotationShape[]>([]);
  annotationsRef.current = annotations;
  const [classes, setClasses] = useState<AnnotationClass[]>([]);
  const [selectedClass, setSelectedClass] = useState<string | null>(null);
  // Class panel: search filter + solo (single class isolated)
  const [classSearch, setClassSearch] = useState('');
  const [soloClassId, setSoloClassId] = useState<string | null>(null);
  // Class-based image filter: only navigate through images that contain this class
  const [classFilterName, setClassFilterName] = useState<string | null>(null);
  const [classImageMap, setClassImageMap] = useState<{ [className: string]: Set<string> }>({});
  const [selectedAnnotation, setSelectedAnnotation] = useState<string | null>(null);
  const [annotationName, setAnnotationName] = useState<string>("");
  const [datasetName, setDatasetName] = useState<string>("");
  const [projectName, setProjectName] = useState<string>("");

  const baseNavigableImageNames = useMemo(() => {
    const mainLayerCollection = imageCollections.find(c => String(c.id) === String(mainLayer));
    return mainLayerCollection && mainLayerCollection.images.length > 0
      ? mainLayerCollection.images.map(img => img.fileName).sort()
      : allImageNames;
  }, [imageCollections, mainLayer, allImageNames]);

  const navigableImageNames = useMemo(() => {
    const filterSet = classFilterName ? classImageMap[classFilterName] : null;
    if (!filterSet || filterSet.size === 0) return baseNavigableImageNames;
    return baseNavigableImageNames.filter(name => filterSet.has(name));
  }, [baseNavigableImageNames, classFilterName, classImageMap]);

  // Keep annotation swatches in sync with the left-side Classes palette.
  // Must react to BOTH classes and annotation arrivals: on first image load,
  // async annotation fetch can complete after classes are already set.
  useEffect(() => {
    if (classes.length === 0 || annotations.length === 0) return;

    const remapped = applyClassColorsToAnnotations(annotations, classes);
    if (remapped === annotations) return;

    annotationsRef.current = remapped;
    setAnnotations(remapped);

    if (id && currentImageName) {
      const activeCollId = displayLayer ?? mainLayer ?? 'default';
      safeLocalStorageSet(
        `annotations_${id}_${activeCollId}_${currentImageName}`,
        JSON.stringify(remapped),
      );
    }
  }, [classes, annotations, id, currentImageName, displayLayer, mainLayer]);

  // Right sidebar UI: collapsible and resizable
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [rightWidth, setRightWidth] = useState(320); // px
  const resizingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  // Left sidebar UI: collapsible and resizable
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [leftWidth, setLeftWidth] = useState(320);
  const leftResizingRef = useRef(false);
  const leftStartXRef = useRef(0);
  const leftStartWidthRef = useRef(0);
  /** `${collectionId}::${imageName}` — skip guard must include collection so layer switches reload. */
  const lastLoadedAnnotationKeyRef = useRef<string>('');
  /** Last annotation file we opened (for invalidating lastLoadedAnnotationKeyRef when switching files). */
  const lastOpenedAnnotationFileIdRef = useRef<string | null>(null);
  /** Bumped when the annotation-file load effect cleans up or re-runs so in-flight loads don't clear caches / wipe polygons (Strict Mode + overlapping effects). */
  const annotationFileLoadGenerationRef = useRef(0);
  /** Monotonic token so stale async annotation loads cannot commit after navigating to another image. */
  const pendingAnnotationLoadTokenRef = useRef(0);
  // Always-current image name ref so stale useCallback closures can still access the latest value
  const currentImageNameRef = useRef<string>('');
  // Always-current load function ref so stale callbacks can call the latest version
  const loadAnnotationsForImageRef = useRef<((name: string, forceCollectionId?: string) => Promise<void>) | null>(null);
  // COCO image dimensions (file_name -> { width, height }) so we can scale loaded coords to actual image space
  const cocoImageDimensionsRef = useRef<Record<string, { width: number; height: number }>>({});

  /**
   * Pixel space of stored polygon coordinates (same as API / file pixels).
   * Prefer decoded bitmap WxH when the canvas image matches this file — augmented or resized
   * files often disagree with DB `Image.width/height`, which would remap polygons off-canvas.
   * Then DB row, then COCO ref.
   */
  const getAnnotReferenceDimensions = useCallback((fileName: string | undefined) => {
    if (!fileName) return undefined;
    const imgEl = imageRef.current;
    const nw = imgEl?.naturalWidth ?? 0;
    const nh = imgEl?.naturalHeight ?? 0;
    if (
      currentImage?.fileName === fileName
      && imgEl?.complete
      && nw > 0
      && nh > 0
    ) {
      return { width: nw, height: nh };
    }
    if (currentImage?.fileName === fileName && currentImage.width > 0 && currentImage.height > 0) {
      return { width: currentImage.width, height: currentImage.height };
    }
    const coco = cocoImageDimensionsRef.current[fileName];
    if (coco && coco.width > 0 && coco.height > 0) return coco;
    return undefined;
  }, [currentImage]);

  const [isDrawing, setIsDrawing] = useState(false);
  const [currentPath, setCurrentPath] = useState<Point[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [isMovingAnnotation, setIsMovingAnnotation] = useState(false);
  const [moveOffset, setMoveOffset] = useState({ x: 0, y: 0 });
  // Cursor position in image coordinates for status bar
  const [cursorImagePosition, setCursorImagePosition] = useState<{ x: number; y: number } | null>(null);
  
  // Image scaling
  const [imageScale, setImageScale] = useState(1);
  const [imageOffset, setImageOffset] = useState({ x: 0, y: 0 });
  
  // Class management
  const [newClassName, setNewClassName] = useState('');
  const [isAddingClass, setIsAddingClass] = useState(false);
  // Dismiss state for the "Let's get you annotating" first-run overlay.
  // Persisted per-dataset in sessionStorage so it stays hidden while the
  // user browses, but returns in a fresh session.
  const [onboardingDismissed, setOnboardingDismissed] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem('annotation-onboarding-dismissed') === '1';
    } catch {
      return false;
    }
  });
  const [editingClassId, setEditingClassId] = useState<string | null>(null);
  const [editingClassName, setEditingClassName] = useState('');
  // Auto-segment preview state
  const [autoSegmentPreview, setAutoSegmentPreview] = useState<{ polygons: Point[][]; maskDataUrl?: string; imageName?: string } | null>(null);
  const [autoSegmentClassId, setAutoSegmentClassId] = useState<string | null>(null);
  // SAM points for interactive segmentation (ref so second click sees latest points before re-render)
  const [samPoints, setSamPoints] = useState<Array<{ x: number; y: number; label: number }>>([]);
  const samPointsRef = useRef<Array<{ x: number; y: number; label: number }>>([]);
  useEffect(() => {
    samPointsRef.current = samPoints;
  }, [samPoints]);
  const [isSamProcessing, setIsSamProcessing] = useState(false);
  const [isSamModelLoading, setIsSamModelLoading] = useState(false);
  /** Full-screen wait modal only after slow first load (see SAM_MODEL_WAIT_OVERLAY_MS). */
  const [showSamModelWaitOverlay, setShowSamModelWaitOverlay] = useState(false);
  const samReadyAbortRef = useRef<AbortController | null>(null);
  const samSegmentAbortRef = useRef<AbortController | null>(null);
  const samReadyOverlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isSamInteractionBlocked = isSamModelLoading || isSamProcessing;
  const showSamBlockingOverlay =
    activeTool === 'auto-segment' &&
    (isSamProcessing || (isSamModelLoading && showSamModelWaitOverlay));
  const [segmentModel, setSegmentModel] = useState<'sam2' | 'sam3'>('sam2');
  const [segmentTextPrompt, setSegmentTextPrompt] = useState('');
  const [samMinArea, setSamMinArea] = useState<number>(100);

  useEffect(() => {
    if (annotationMode === 'bbox' && (activeTool === 'polygon' || activeTool === 'pencil')) {
      setActiveTool('rectangle');
    }
  }, [annotationMode, activeTool]);

  useEffect(() => {
    if (!modeLocked && annotations.length > 0) {
      setModeLocked(true);
      setBboxSwitchAllowed(false);
      if (annotationMode === 'bbox') {
        setModeLockReason('BBox mode locked after first annotation.');
      }
    }
  }, [annotations.length, modeLocked, annotationMode]);

  useEffect(() => {
    if (!annotationId) {
      setAnnotationMode(modeHint === 'bbox' ? 'bbox' : 'mask');
      setModeLocked(false);
      if (modeHint === 'bbox') {
        setBboxSwitchAllowed(false);
        setModeLocked(true);
        setModeLockReason('BBox mode selected for this new session.');
      } else {
        setBboxSwitchAllowed(true);
        setModeLockReason(null);
      }
    }
  }, [annotationId, id, modeHint]);

  const { data: sam3Available = false } = useQuery({
    queryKey: ['sam3-available'],
    queryFn: async () => {
      const r = await fetch(`${segmentApiUrl()}/ready/sam3`);
      return r.ok;
    },
    staleTime: 60 * 1000,
    retry: false,
  });

  // When SAM 3 becomes unavailable, fall back to SAM 2
  useEffect(() => {
    if (!sam3Available && segmentModel === 'sam3') setSegmentModel('sam2');
  }, [sam3Available, segmentModel]);

  const clearSamReadyOverlayTimer = useCallback(() => {
    if (samReadyOverlayTimerRef.current) {
      clearTimeout(samReadyOverlayTimerRef.current);
      samReadyOverlayTimerRef.current = null;
    }
    setShowSamModelWaitOverlay(false);
  }, []);

  const cancelSamInteraction = useCallback(() => {
    samReadyAbortRef.current?.abort();
    samReadyAbortRef.current = null;
    samSegmentAbortRef.current?.abort();
    samSegmentAbortRef.current = null;
    clearSamReadyOverlayTimer();
    setIsSamModelLoading(false);
    setIsSamProcessing(false);
    setAutoSegmentPreview(null);
    setSamPoints([]);
    samPointsRef.current = [];
    setActiveTool('select');
  }, [clearSamReadyOverlayTimer]);

  // Ensure SAM is ready when AI Segment is active (session cache skips repeat full-screen wait).
  useEffect(() => {
    if (activeTool !== 'auto-segment') {
      samReadyAbortRef.current?.abort();
      samReadyAbortRef.current = null;
      clearSamReadyOverlayTimer();
      setIsSamModelLoading(false);
      return;
    }

    const modelKey = segmentModel as SamSegmentModelKey;
    const readyUrl =
      modelKey === 'sam3'
        ? `${segmentApiUrl()}/ready/sam3`
        : `${segmentApiUrl()}/ready`;

    const controller = new AbortController();
    samReadyAbortRef.current = controller;
    let cancelled = false;

    const finishLoading = (ready: boolean) => {
      if (controller.signal.aborted || cancelled) return;
      clearSamReadyOverlayTimer();
      setIsSamModelLoading(false);
      if (ready) {
        setSamModelCachedReady(modelKey, true);
        return;
      }
      setSamModelCachedReady(modelKey, false);
      toast({
        title: 'SAM model unavailable',
        description: 'The segmentation service is not ready. Try again later.',
        variant: 'destructive',
      });
      setActiveTool('select');
    };

    const pollUntilReady = async (): Promise<boolean> => {
      while (!controller.signal.aborted && !cancelled) {
        try {
          const res = await fetch(readyUrl, { signal: controller.signal });
          if (res.ok) {
            return true;
          }
        } catch {
          if (controller.signal.aborted) return false;
        }
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      return false;
    };

    const startPollWithOptionalOverlay = () => {
      setIsSamModelLoading(true);
      setShowSamModelWaitOverlay(false);
      samReadyOverlayTimerRef.current = setTimeout(() => {
        if (!controller.signal.aborted && !cancelled) {
          setShowSamModelWaitOverlay(true);
        }
      }, SAM_MODEL_WAIT_OVERLAY_MS);
      pollUntilReady()
        .then(finishLoading)
        .catch(() => undefined);
    };

    if (isSamModelCachedReady(modelKey)) {
      setIsSamModelLoading(false);
      setShowSamModelWaitOverlay(false);
      fetch(readyUrl, { signal: controller.signal })
        .then((res) => {
          if (controller.signal.aborted || cancelled) return;
          if (!res.ok) {
            clearSamModelReadyCache(modelKey);
            startPollWithOptionalOverlay();
          }
        })
        .catch(() => {
          if (!controller.signal.aborted && !cancelled) {
            clearSamModelReadyCache(modelKey);
            startPollWithOptionalOverlay();
          }
        });
    } else {
      startPollWithOptionalOverlay();
    }

    return () => {
      cancelled = true;
      controller.abort();
      clearSamReadyOverlayTimer();
      if (samReadyAbortRef.current === controller) {
        samReadyAbortRef.current = null;
      }
    };
  }, [activeTool, segmentModel, toast, clearSamReadyOverlayTimer]);

  // Leaving AI Segment while a request is in flight should abort it.
  useEffect(() => {
    if (activeTool !== 'auto-segment') {
      samSegmentAbortRef.current?.abort();
      samSegmentAbortRef.current = null;
      setIsSamProcessing(false);
    }
  }, [activeTool]);

  // Panel tab state
  const [activePanelTab, setActivePanelTab] = useState<string>('annotations');
  const annotationListViewportRef = useRef<HTMLDivElement>(null);
  const annotationItemRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const scrollAnnotationListToSelected = useCallback((annotationId: string) => {
    const viewport = annotationListViewportRef.current;
    const el = annotationItemRefs.current.get(annotationId);
    if (!viewport || !el) return;
    if (viewport.scrollHeight <= viewport.clientHeight + 1) return;

    const viewportRect = viewport.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const padding = 12;

    if (elRect.top >= viewportRect.top + padding && elRect.bottom <= viewportRect.bottom - padding) {
      return;
    }

    const delta =
      elRect.top < viewportRect.top + padding
        ? elRect.top - viewportRect.top - padding
        : elRect.bottom - viewportRect.bottom + padding;

    viewport.scrollBy({ top: delta, behavior: 'smooth' });
  }, []);

  // Scroll the annotation list to the selected item (canvas click or list click)
  useEffect(() => {
    if (!selectedAnnotation) return;
    setRightCollapsed(false);
    setActivePanelTab('annotations');

    const runScroll = () => scrollAnnotationListToSelected(selectedAnnotation);

    // Panel expand / tab switch need time before the list viewport has final layout
    const t1 = window.setTimeout(runScroll, 0);
    const t2 = window.setTimeout(runScroll, 100);
    const t3 = window.setTimeout(runScroll, 250);

    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.clearTimeout(t3);
    };
  }, [selectedAnnotation, scrollAnnotationListToSelected]);

   // Auto-save state
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [isAutoSaving, setIsAutoSaving] = useState(false);
  const autoSaveTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastSaveTimeRef = useRef<number>(Date.now());

  // Leave confirmation dialog state
  const [showLeaveDialog, setShowLeaveDialog] = useState(false);
  const pendingNavigationRef = useRef<string | null>(null);

  // Save annotation file dialog state
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [saveAnnotationName, setSaveAnnotationName] = useState('');
  const [isSavingAnnotation, setIsSavingAnnotation] = useState(false);
  const navigateAfterSaveRef = useRef(false);
  const justSavedRef = useRef(false); // Track when we just saved to prevent reload

  // Delete all annotations confirmation dialog state
  const [showDeleteAllDialog, setShowDeleteAllDialog] = useState(false);
  const [showDeleteAnnotationDialog, setShowDeleteAnnotationDialog] = useState(false);
  const [pendingDeleteAnnotationId, setPendingDeleteAnnotationId] = useState<string | null>(null);
  const [showDeleteClassDialog, setShowDeleteClassDialog] = useState(false);
  const [pendingDeleteClassId, setPendingDeleteClassId] = useState<string | null>(null);
  const [skipDeleteAnnotationConfirm, setSkipDeleteAnnotationConfirm] = useState(false);

  useEffect(() => {
    if (!id) return;
    try {
      const raw = localStorage.getItem(`segmentation_skip_delete_confirm_${id}`);
      setSkipDeleteAnnotationConfirm(raw === '1');
    } catch {
      // no-op
    }
  }, [id]);

  useEffect(() => {
    if (!id) return;
    try {
      localStorage.setItem(`segmentation_skip_delete_confirm_${id}`, skipDeleteAnnotationConfirm ? '1' : '0');
    } catch {
      // no-op
    }
  }, [id, skipDeleteAnnotationConfirm]);

  // Helper function to safely save to localStorage with quota handling
  const safeLocalStorageSet = (key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (e) {
      if (e instanceof DOMException && e.name === 'QuotaExceededError') {
        console.warn('localStorage quota exceeded, skipping cache');
      } else {
        console.error('Error saving to localStorage:', e);
      }
      return false;
    }
  };

  // Start auto-segmentation via backend SAM only.
  // label: 1 = add to mask (left-click), 0 = remove from mask (right-click).
  const startAutoSegment = useCallback(async (imgPoint: Point, label: number = 1) => {
    if (!displayImage && !currentImage) return;
    if (isSamModelLoading || isSamProcessing) return;
    const img = (displayImage || currentImage)!;
    const samPoint = { x: imgPoint.x, y: imgPoint.y, label };
    // Use ref so rapid second click includes first point (avoids stale closure)
    const previousPoints = samPointsRef.current;
    const newPoints = [...previousPoints, samPoint];
    setSamPoints(newPoints);
    samPointsRef.current = newPoints;
    setIsSamProcessing(true);

    const preferredClass = classes.find(c => c.id === selectedClass) || classes[0] || null;
    const setPreview = (polygons: Point[][], maskDataUrl?: string) => {
      setAutoSegmentPreview({
        polygons,
        ...(maskDataUrl && { maskDataUrl }),
        imageName: img.fileName,
      });
      setAutoSegmentClassId(preferredClass ? preferredClass.id : null);
    };

    const MAX_SIDE = 1024;
    const getImageB64AndScale = (): { imageB64: string | null; sendScale: number } => {
      if (!imageRef.current) return { imageB64: null, sendScale: 1 };
      const el = imageRef.current;
      let w = el.naturalWidth;
      let h = el.naturalHeight;
      let sendScale = 1;
      if (Math.max(w, h) > MAX_SIDE) {
        sendScale = MAX_SIDE / Math.max(w, h);
        w = Math.round(w * sendScale);
        h = Math.round(h * sendScale);
      }
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return { imageB64: null, sendScale: 1 };
      ctx.drawImage(el, 0, 0, w, h);
      return { imageB64: canvas.toDataURL('image/png'), sendScale };
    };

    try {
      const { imageB64, sendScale } = getImageB64AndScale();
      const apiBase = imageAnnotationApiBase();
      const scalePoint = (p: { x: number; y: number }) =>
        imageB64 ? { x: Math.round(p.x * sendScale), y: Math.round(p.y * sendScale) } : { x: p.x, y: p.y };
      const body: Record<string, unknown> = {
        point: scalePoint(imgPoint),
        points: newPoints.map(p => ({ ...scalePoint(p), label: p.label })),
        model: segmentModel,
      };
      if (imageB64) {
        body.imageB64 = imageB64;
      } else if (img.url) {
        body.imageUrl = img.url;
      }
      if (segmentModel === 'sam3' && segmentTextPrompt.trim()) {
        body.text = segmentTextPrompt.trim();
      }
      samSegmentAbortRef.current?.abort();
      const controller = new AbortController();
      samSegmentAbortRef.current = controller;
      const timeoutId = setTimeout(() => controller.abort(), 14000);
      const res = await fetch(`${apiBase}/segment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (samSegmentAbortRef.current === controller) {
        samSegmentAbortRef.current = null;
      }
      if (!res.ok) throw new Error(`Segmentation failed: ${res.status}`);
      const json = await res.json();
      const rawPolygons = json.polygons || [];
      const isRectanglePlaceholder =
        (json.source !== 'sam2' && json.source !== 'sam3') &&
        rawPolygons.length === 1 &&
        rawPolygons[0].length >= 4 &&
        rawPolygons[0].length <= 5;
      if (isRectanglePlaceholder) {
        toast({
          title: 'SAM service needs update',
          description: 'Segmentation returned a placeholder. Ensure the SAM service (backend) is running with a valid model.',
          variant: 'destructive',
        });
        return;
      }
      let polygons: Point[][] = rawPolygons.map((poly: number[][]) =>
        poly.map((p: number[]) => ({ x: p[0], y: p[1] }))
      );
      if (imageB64 && sendScale !== 1 && polygons.length > 0) {
        const scaleBack = 1 / sendScale;
        polygons = polygons.map(poly => poly.map(p => ({ x: p.x * scaleBack, y: p.y * scaleBack })));
      }
      if (samMinArea > 0) {
        polygons = polygons.filter(poly => calculatePolygonArea(poly) >= samMinArea);
      }
      if (polygons.length > 0 && polygons[0].length > 0) {
        setPreview(polygons, json.maskBase64);
      } else {
        toast({
          title: 'No segmentation found',
          description: 'Try another point or add a second point on the object',
          variant: 'destructive',
        });
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return;
      }
      toast({
        title: 'Segmentation failed',
        description: 'Backend SAM is unavailable or failed. Ensure the SAM service is running.',
        variant: 'destructive',
      });
    } finally {
      setIsSamProcessing(false);
      samSegmentAbortRef.current = null;
    }
  }, [displayImage, currentImage, classes, selectedClass, toast, samPoints, segmentModel, segmentTextPrompt, samMinArea, isSamModelLoading, isSamProcessing]);

  const acceptAutoSegment = () => {
    if (!autoSegmentPreview || !autoSegmentPreview.polygons || autoSegmentPreview.polygons.length === 0) return;
    // Require selecting an existing class id for auto-seg — do not auto-create classes here
    if (!autoSegmentClassId) {
      toast({ title: 'No class selected', description: 'Please select a class for auto-segmented annotations', variant: 'destructive' });
      return;
    }
    const classObj = classes.find(c => c.id === autoSegmentClassId) || null;
    if (!classObj) {
      toast({ title: 'Invalid class', description: 'Selected class not found', variant: 'destructive' });
      return;
    }

    const sa = annotScaleToAnnotRef.current;
    const newAnns: AnnotationShape[] = autoSegmentPreview.polygons.map(poly => {
      const scaledPoly = (sa.x !== 1 || sa.y !== 1)
        ? poly.map(p => ({ x: p.x * sa.x, y: p.y * sa.y }))
        : poly;
      const points = annotationMode === 'bbox' ? bboxToRectPoints(pointsToBbox(scaledPoly)) : scaledPoly;
      return {
        id: `annotation_${Date.now()}_${Math.random().toString(36).substr(2,9)}`,
        type: annotationMode === 'bbox' ? 'rectangle' : 'polygon',
        points,
        label: classObj.name,
        color: classObj.color,
        visible: true
      };
    });

    setAnnotations(prev => {
      const updated = [...prev, ...newAnns];
      const annotDims = annotLayerDimsRef.current;
      const saveDims = annotDims
        ? { width: annotDims.width, height: annotDims.height }
        : { width: imageRef.current?.naturalWidth || 0, height: imageRef.current?.naturalHeight || 0 };
      saveAnnotationsToLocalStorage(
        currentImageName,
        updated,
        saveDims.width && saveDims.height ? saveDims : undefined,
      );
      return updated;
    });

    // Mark as unsaved
    setHasUnsavedChanges(true);

    // update counts
    setClasses(prev => {
      const updated = prev.map(c => c.id === classObj!.id ? { ...c, count: c.count + newAnns.length } : c);
      saveGlobalClasses(updated);
      return updated;
    });

    setAutoSegmentPreview(null);
    setSamPoints([]); // Clear points so next click starts fresh for a new object
    toast({ title: 'Auto-segment accepted', description: `Created ${newAnns.length} ${annotationMode === 'bbox' ? 'bounding boxes' : 'annotations'}` });
    computeGlobalStatsDebounced();
  };

  const cancelAutoSegment = () => {
    setAutoSegmentPreview(null);
    setSamPoints([]); // Clear SAM points when canceling
  };

  const [isApplyingAllImages, setIsApplyingAllImages] = useState(false);
  const [applyAllProgress, setApplyAllProgress] = useState<{ current: number; total: number } | null>(null);
  const applyAllCancelledRef = useRef(false);

  // Inline editing for individual annotation labels in right sidebar
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(null);
  const [editingAnnotationLabel, setEditingAnnotationLabel] = useState('');

  // Load global classes from localStorage
  const loadGlobalClasses = () => {
    try {
      const globalClassesKey = `classes_${id}`;
      const savedClasses = localStorage.getItem(globalClassesKey);
      if (savedClasses) {
        const parsedClasses = JSON.parse(savedClasses);
        setClasses(parsedClasses);
      }
    } catch (error) {
      console.error('Error loading global classes:', error);
    }
  };

  // Resize handlers for right sidebar
  const onMouseMoveResize = useCallback((e: MouseEvent) => {
    if (!resizingRef.current) return;
    const deltaX = e.clientX - startXRef.current;
    const newWidth = Math.max(200, Math.min(800, startWidthRef.current - deltaX));
    setRightWidth(newWidth);
  }, []);

  const onMouseUpResize = useCallback(() => {
    resizingRef.current = false;
    window.removeEventListener('mousemove', onMouseMoveResize);
    window.removeEventListener('mouseup', onMouseUpResize);
    // Notify that a panel resize/collapse finished so layout can be recomputed
    try {
      window.dispatchEvent(new Event('annotation-panel-resize-end'));
    } catch (err) {
      // ignore
    }
  }, [onMouseMoveResize]);

  const startResize = (e: React.MouseEvent) => {
    resizingRef.current = true;
    startXRef.current = e.clientX;
    startWidthRef.current = rightWidth;
    window.addEventListener('mousemove', onMouseMoveResize);
    window.addEventListener('mouseup', onMouseUpResize);
  };

  // Left resize handlers
  const onMouseMoveResizeLeft = useCallback((e: MouseEvent) => {
    if (!leftResizingRef.current) return;
    const deltaX = e.clientX - leftStartXRef.current;
    const newWidth = Math.max(200, Math.min(800, leftStartWidthRef.current + deltaX));
    setLeftWidth(newWidth);
  }, []);

  const onMouseUpResizeLeft = useCallback(() => {
    leftResizingRef.current = false;
    window.removeEventListener('mousemove', onMouseMoveResizeLeft);
    window.removeEventListener('mouseup', onMouseUpResizeLeft);
    // Notify that a panel resize/collapse finished so layout can be recomputed
    try {
      window.dispatchEvent(new Event('annotation-panel-resize-end'));
    } catch (err) {
      // ignore
    }
  }, [onMouseMoveResizeLeft]);

  const startResizeLeft = (e: React.MouseEvent) => {
    leftResizingRef.current = true;
    leftStartXRef.current = e.clientX;
    leftStartWidthRef.current = leftWidth;
    window.addEventListener('mousemove', onMouseMoveResizeLeft);
    window.addEventListener('mouseup', onMouseUpResizeLeft);
  };

  // Smooth zoom animation refs and helpers
  const animFrameRef = useRef<number | null>(null);
  const scaleRef = useRef<number>(imageScale);
  const offsetRef = useRef<{ x: number; y: number }>(imageOffset);
  const targetScaleRef = useRef<number | null>(null);

  // Panning refs (middle mouse or Space + drag)
  const isPanningRef = useRef(false);
  const panStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const spacePressedRef = useRef(false);
  
  // Track right mouse button state for right+left click panning
  const rightMouseDownRef = useRef(false);
  
  // Prevent zoom reset during/after panning
  const preventZoomResetRef = useRef(false);

  useEffect(() => { scaleRef.current = imageScale; }, [imageScale]);
  useEffect(() => { offsetRef.current = imageOffset; }, [imageOffset]);

  // Annotation-layer scale refs — updated by effect so callbacks never have stale values.
  // annotLayerDimsRef  : pixel dimensions of the designated annotation coordinate space.
  // annotScaleToAnnotRef: multiply display-space coords × these to get annotation-space coords.
  const annotLayerDimsRef = useRef<{ width: number; height: number } | null>(null);
  const annotScaleToAnnotRef = useRef({ x: 1, y: 1 });

  useEffect(() => {
    if (!annotationLayerId || !displayImage) {
      annotLayerDimsRef.current = null;
      annotScaleToAnnotRef.current = { x: 1, y: 1 };
      return;
    }
    const annotColl = imageCollections.find(c => String(c.id) === annotationLayerId);
    const annotImg = annotColl?.images.find(i => i.fileName === currentImageName);
    if (annotImg && annotImg.width > 0 && annotImg.height > 0 && displayImage.width > 0 && displayImage.height > 0) {
      annotLayerDimsRef.current = { width: annotImg.width, height: annotImg.height };
      annotScaleToAnnotRef.current = {
        x: annotImg.width / displayImage.width,
        y: annotImg.height / displayImage.height,
      };
    } else {
      annotLayerDimsRef.current = null;
      annotScaleToAnnotRef.current = { x: 1, y: 1 };
    }
  }, [annotationLayerId, currentImageName, imageCollections, displayImage]);

  const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

  const stopAnimation = () => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    targetScaleRef.current = null;
  };

  const animateToScale = (finalScale: number, focalImagePoint: Point, focalScreenPoint: Point) => {
    stopAnimation();
    targetScaleRef.current = finalScale;
    preserveZoomRef.current = true; // User is actively zooming, preserve this

    const step = () => {
      const cur = scaleRef.current || 1;
      const delta = finalScale - cur;
      // interpolate with easing factor for smoothness
      const next = Math.abs(delta) < 0.0001 ? finalScale : cur + delta * 0.28;

      // compute new offset so the focal image coordinate stays under the focal screen point
      const nextOffsetX = focalScreenPoint.x - focalImagePoint.x * next;
      const nextOffsetY = focalScreenPoint.y - focalImagePoint.y * next;

      // Apply new values
      setImageScale(next);
      setImageOffset({ x: nextOffsetX, y: nextOffsetY });

      // Continue until close enough
      if (Math.abs(finalScale - next) > 0.0005) {
        animFrameRef.current = requestAnimationFrame(step);
      } else {
        // finalize
        setImageScale(finalScale);
        setImageOffset({ x: focalScreenPoint.x - focalImagePoint.x * finalScale, y: focalScreenPoint.y - focalImagePoint.y * finalScale });
        stopAnimation();
      }
    };

    animFrameRef.current = requestAnimationFrame(step);
  };

  

  // Keyboard shortcuts: press number keys 1..9 to select corresponding class in the list
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ignore when typing in inputs
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;

      if (/^[1-9]$/.test(e.key)) {
        const idx = parseInt(e.key, 10) - 1;
        if (idx >= 0 && idx < classes.length) {
          setSelectedClass(classes[idx].id);
        }
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [classes]);

  // Listen for Space key down/up to enable Space+drag panning
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spacePressedRef.current = true;
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spacePressedRef.current = false;
      }
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  // Listen for right mouse button down/up to enable right+left click panning
  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (e.button === 2) { // Right click
        rightMouseDownRef.current = true;
      }
    };
    const handleMouseUp = (e: MouseEvent) => {
      if (e.button === 2) { // Right click
        rightMouseDownRef.current = false;
      }
    };
    const handleContextMenu = (e: MouseEvent) => {
      // Prevent context menu when right-clicking for panning
      if (rightMouseDownRef.current) {
        e.preventDefault();
      }
    };
    
    window.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('contextmenu', handleContextMenu);
    return () => {
      window.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('contextmenu', handleContextMenu);
    };
  }, []);

  // Keyboard shortcut to toggle the right sidebar (']' key)
  useEffect(() => {
    const toggleHandler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (e.key === ']') {
        setRightCollapsed(v => !v);
      }
    };
    window.addEventListener('keydown', toggleHandler);
    return () => window.removeEventListener('keydown', toggleHandler);
  }, []);

  // Toggle keyboard cheatsheet with '?' (Shift+/) — ignored when typing in inputs
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (e.key === '?' || (e.shiftKey && e.key === '/')) {
        e.preventDefault();
        setShowCheatsheet(v => !v);
      } else if (e.key === 'Escape') {
        setShowCheatsheet(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Save global classes to localStorage
  const saveGlobalClasses = (classesToSave: AnnotationClass[]) => {
    try {
      const globalClassesKey = `classes_${id}`;
      localStorage.setItem(globalClassesKey, JSON.stringify(classesToSave));
    } catch (error) {
      console.error('Error saving global classes:', error);
    }
  };

  // Keep currentImageNameRef always up-to-date so stale callbacks can access the latest image name
  useEffect(() => {
    currentImageNameRef.current = currentImageName;
  }, [currentImageName]);

  // Load images on mount
  useEffect(() => {
    const loadImagesEffect = async () => {
      if (!id || !api) return;
      
      try {
        setIsLoading(true);
        
        // Fetch dataset and project names
        api.getDataset(id).then(res => {
          if (res.success && res.data) {
            setDatasetName(res.data.name);
          }
        });
        if (projectId) {
          api.getProject(projectId).then(res => {
            if (res.success && res.data) {
              setProjectName(res.data.name);
            }
          });
        }

        // Only load global classes if loading an existing annotation file
        // Otherwise start with clean slate (no classes)
        if (annotationId) {
          loadGlobalClasses();
        }
        
        // Try to load image collections first
        const collectionsResponse = await api.getImageCollections(id);
        if (collectionsResponse.success && collectionsResponse.data) {
          setImageCollections(collectionsResponse.data);
          
          // Get ALL unique image names from ALL collections for navigation
          const allNames = new Set<string>();
          collectionsResponse.data.forEach(collection => {
            collection.images.forEach(img => {
              allNames.add(img.fileName);
            });
          });
          const uniqueNames = Array.from(allNames).sort();
          setAllImageNames(uniqueNames);
          
          // Check if a specific collection ID was provided in URL (to restrict navigation).
          const urlCollectionId = annotationId ? null : searchParams.get('collectionId');
          let defaultCollection: ImageCollection | undefined;
          
          if (urlCollectionId) {
            defaultCollection = collectionsResponse.data.find(c => String(c.id) === String(urlCollectionId));
            if (defaultCollection) {
              console.log('Using collection from URL:', defaultCollection.name);
            } else {
              console.warn('Collection from URL not found:', urlCollectionId);
            }
          }

          // Respect the user-chosen collection order persisted in the DB
          // (image_collections.position, set via drag-to-reorder on the Dataset
          // page). The backend already returns collections ordered by position,
          // so the first one is whatever the user put at the top — don't second-guess
          // that with a hard-coded RGB preference here.
          if (!defaultCollection) {
            defaultCollection = collectionsResponse.data[0];
          }
          
          if (defaultCollection) {
            setDisplayLayer(String(defaultCollection.id));
            setMainLayer(String(defaultCollection.id)); // Set main layer (controls which images are available for navigation)
          }
          
          // Start from an image that exists in the preferred (RGB) layer so display + annotations align
          const initialNames =
            defaultCollection && defaultCollection.images.length > 0
              ? defaultCollection.images.map(img => img.fileName).sort()
              : uniqueNames;
          if (initialNames.length > 0) {
            const firstName = initialNames[0];
            setCurrentImageName(firstName);
            currentImageNameRef.current = firstName;
            updateCurrentImages(firstName, defaultCollection ? String(defaultCollection.id) : '', collectionsResponse.data);
            // When editing an existing annotation file, do not load here: `loadFromAnnotationFile` clears
            // caches and bumps the pending-load token; an in-flight load from this line races that pipeline
            // and the first image can stay empty until next/prev forces a fresh load.
            if (!annotationId) {
              loadAnnotationsForImage(firstName, defaultCollection ? String(defaultCollection.id) : 'default');
            }
          }
          
          const navCount = urlCollectionId && defaultCollection 
            ? defaultCollection.images.length 
            : uniqueNames.length;
          
          toast({
            title: 'Collections loaded',
            description: urlCollectionId && defaultCollection 
              ? `Loaded ${collectionsResponse.data.length} collections. Navigation restricted to "${defaultCollection.name}" (${navCount} images).`
              : `Loaded ${collectionsResponse.data.length} collections with ${uniqueNames.length} unique images for navigation.`,
          });
        } else {
          // Fallback to old single collection method
          const response = await api.getImages(id);
          if (response.success && response.data) {
            // Create a single collection from images
            const defaultCollection: ImageCollection = {
              id: 'default',
              name: 'RGB Images',
              images: response.data,
              currentPage: 1,
              totalPages: 1,
              paginatedImages: response.data
            };
            
            setImageCollections([defaultCollection]);
            setDisplayLayer('default');
            setMainLayer('default'); // Set main layer for fallback case
            
            const imageNames = response.data.map(img => img.fileName).sort();
            setAllImageNames(imageNames);
            
            if (imageNames.length > 0) {
              const first = imageNames[0];
              setCurrentImageName(first);
              currentImageNameRef.current = first;
              setCurrentImage(response.data[0]);
              setDisplayImage(response.data[0]);
              if (!annotationId) {
                loadAnnotationsForImage(first, 'default');
              }
            }
          }
        }
      } catch (error) {
        console.error('Error loading images:', error);
        toast({
          title: 'Error',
          description: 'Failed to load images',
          variant: 'destructive'
        });
      } finally {
        setIsLoading(false);
        // Mark initial load as complete after a brief delay to ensure all state updates are done
        setTimeout(() => setIsInitialLoad(false), 100);
      }
    };

    loadImagesEffect();
  }, [id, api, toast, annotationId]);

  // Update images when index or layer changes (including display layer only — must refresh display bitmap)
  useEffect(() => {
    // Skip during initial load to prevent flickering
    if (isInitialLoad) return;

    const imageList = navigableImageNames;
    if (imageList.length > 0 && currentImageIndex < imageList.length) {
      const imageName = imageList[currentImageIndex];

      if (imageName !== currentImageName) {
        setCurrentImageName(imageName);
        currentImageNameRef.current = imageName;
        loadAnnotationsForImage(imageName);
      }
      updateCurrentImages(imageName, displayLayer, imageCollections);
    }
  }, [currentImageIndex, navigableImageNames, displayLayer, imageCollections, isInitialLoad]);

  // Reload annotations for the new collection when displayLayer changes (e.g. user clicks a layer tab)
  useEffect(() => {
    if (isInitialLoad || !currentImageName) return;
    // Reset the "last loaded image" guard so loadAnnotationsForImage doesn't
    // short-circuit on the (image-name unchanged, annotations still in state)
    // path — those annotations belong to the *previous* layer.
    logAnnotDebug('displayLayer effect → reset lastLoaded + reload', {
      displayLayer,
      mainLayer,
      currentImageName,
      annotRefLen: annotationsRef.current.length,
    });
    lastLoadedAnnotationKeyRef.current = '';
    loadAnnotationsForImageRef.current?.(currentImageName, displayLayer || mainLayer || 'default');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayLayer]);

  // Keep index aligned when the navigable list itself changes (layer/filter updates).
  // Do not react to every currentImageName/currentImageIndex change, otherwise
  // this effect can fight the index->name effect above and cause 2-image ping-pong.
  useEffect(() => {
    // Skip during initial load to prevent flickering
    if (isInitialLoad) return;

    const list = navigableImageNames;
    if (list.length === 0) return;

    const name = currentImageNameRef.current;
    if (!name) {
      setCurrentImageIndex(0);
      return;
    }

    const newIndex = list.findIndex((n) => n === name);
    if (newIndex === -1) {
      setCurrentImageIndex(0);
      return;
    }

    setCurrentImageIndex((prev) => (prev !== newIndex ? newIndex : prev));
  }, [navigableImageNames, isInitialLoad]);


  const updateCurrentImages = (imageName: string, layerId: string, collections: ImageCollection[]) => {
    const preferredRgb = pickPreferredRgbCollection(collections);
    let foundCurrentImage: Image | null = null;

    if (preferredRgb) {
      foundCurrentImage = preferredRgb.images.find(img => img.fileName === imageName) || null;
    }

    if (!foundCurrentImage) {
      for (const collection of collections) {
        const img = collection.images.find(i => i.fileName === imageName);
        if (img) {
          foundCurrentImage = img;
          break;
        }
      }
    }

    setCurrentImage(foundCurrentImage);

    const mainLayerCollection = collections.find(c => String(c.id) === String(mainLayer));
    if (mainLayerCollection) {
      const mainLayerImageNames = mainLayerCollection.images.map(img => img.fileName).sort();
      setCurrentLayerImageNames(prev => {
        if (
          prev.length === mainLayerImageNames.length &&
          prev.every((n, i) => n === mainLayerImageNames[i])
        ) {
          return prev;
        }
        return mainLayerImageNames;
      });
    } else {
      setCurrentLayerImageNames(prev => (prev.length === 0 ? prev : []));
    }

    const displayCollection = collections.find(c => String(c.id) === String(layerId));
    let matchedInLayer: Image | null = null;
    if (displayCollection) {
      matchedInLayer = findCorrespondingImageInCollection(displayCollection, imageName, foundCurrentImage);
    }

    // When an explicit display layer is selected, the canvas must show that layer's
    // bitmap. If no corresponding image exists in the selected layer, keep displayImage
    // null so the "No corresponding image" UI can surface instead of silently falling
    // back to the RGB/reference image — that fallback made layer switching appear broken
    // because the user saw the same bitmap regardless of which layer was picked.
    const displayPixel: Image | null = displayCollection
      ? (matchedInLayer ?? null)
      : (foundCurrentImage ?? null);

    if (displayCollection) {
      setNoCorrespondingImage(matchedInLayer === null);
    } else {
      setNoCorrespondingImage(false);
    }

    setDisplayImage(displayPixel);
  };

  /** Collection ids that may hold mirrored copies when `activeCollId` is a copy target. */
  const getMirrorSourceCollectionIds = useCallback((targetCollId: string): string[] => {
    if (!readCompanionDuplicateIds().includes(targetCollId)) return [];
    const sources = new Set<string>();
    const main = mainLayerRef.current;
    if (main && main !== targetCollId) sources.add(main);
    const preferred = pickPreferredRgbCollection(imageCollections);
    if (preferred && String(preferred.id) !== targetCollId) sources.add(String(preferred.id));
    const display = displayLayerRef.current;
    if (display && display !== targetCollId) sources.add(display);
    return [...sources];
  }, [imageCollections]);

  const readStoredAnnotationsForCollection = useCallback((
    imageName: string,
    collId: string,
  ): { annotations: AnnotationShape[]; dims?: { width: number; height: number } } | null => {
    if (!id) return null;
    const storageKey = `annotations_${id}_${collId}_${imageName}`;
    const cached = localStorage.getItem(storageKey);
    if (!cached) return null;
    try {
      const parsed = JSON.parse(cached) as AnnotationShape[];
      if (!parsed.length) return null;
      let dims: { width: number; height: number } | undefined;
      const dimsKey = `annotations_${id}_${collId}_${imageName}_dims`;
      const savedDims = localStorage.getItem(dimsKey);
      if (savedDims) {
        try {
          const d = JSON.parse(savedDims) as { width: number; height: number };
          if (d.width > 0 && d.height > 0) dims = d;
        } catch { /* ignore */ }
      }
      return { annotations: parsed, dims };
    } catch {
      return null;
    }
  }, [id]);

  const loadStoredAnnotationsWithMirrorFallback = useCallback((
    imageName: string,
    activeCollId: string,
  ): { annotations: AnnotationShape[]; dims?: { width: number; height: number }; fromCollId: string } | null => {
    const direct = readStoredAnnotationsForCollection(imageName, activeCollId);
    if (direct) return { ...direct, fromCollId: activeCollId };
    for (const sourceId of getMirrorSourceCollectionIds(activeCollId)) {
      const mirrored = readStoredAnnotationsForCollection(imageName, sourceId);
      if (mirrored) return { ...mirrored, fromCollId: sourceId };
    }
    return null;
  }, [readStoredAnnotationsForCollection, getMirrorSourceCollectionIds]);

  const commitLoadedAnnotations = useCallback((
    imageName: string,
    activeCollId: string,
    parsed: AnnotationShape[],
    dims?: { width: number; height: number },
    persistToCollId?: string,
  ) => {
    const mapped = applyClassColorsToAnnotations(parsed, classes);
    annotationsRef.current = mapped;
    setAnnotations(mapped);
    if (dims && dims.width > 0 && dims.height > 0) {
      cocoImageDimensionsRef.current[imageName] = dims;
    }
    const persistId = persistToCollId ?? activeCollId;
    if (id && mapped.length > 0) {
      const mayPersistMirror =
        persistId === activeCollId
        || readCompanionDuplicateIds().includes(persistId);
      if (mayPersistMirror) {
        safeLocalStorageSet(`annotations_${id}_${persistId}_${imageName}`, JSON.stringify(mapped));
        if (dims && dims.width > 0 && dims.height > 0) {
          safeLocalStorageSet(
            `annotations_${id}_${persistId}_${imageName}_dims`,
            JSON.stringify(dims),
          );
        }
      }
    }
    return mapped;
  }, [classes, id]);

  const loadAnnotationsForImage = async (imageName: string, forceCollectionId?: string) => {
    const activeCollId = forceCollectionId ?? displayLayer ?? mainLayer ?? 'default';
    const loadKey = `${activeCollId}::${imageName}`;
    console.log('[loadAnnotations] image:', imageName, 'collection:', activeCollId, 'last:', lastLoadedAnnotationKeyRef.current);

    if (loadKey === lastLoadedAnnotationKeyRef.current && annotationsRef.current.length > 0) {
      setAnnotationsLoadingForImage(null);
      logAnnotDebug('loadAnnotationsForImage SKIP (already have annotations for this image+layer)', {
        imageName,
        activeCollId,
        count: annotationsRef.current.length,
        token: pendingAnnotationLoadTokenRef.current,
      });
      return;
    }

    logAnnotDebug('loadAnnotationsForImage START', {
      imageName,
      activeCollId,
      lastLoaded: lastLoadedAnnotationKeyRef.current,
      annotRefLen: annotationsRef.current.length,
      annotationId: !!annotationId,
    });

    const myToken = ++pendingAnnotationLoadTokenRef.current;
    const stillFresh = () => myToken === pendingAnnotationLoadTokenRef.current;
    setAnnotationsLoadingForImage(imageName);

    try {
      lastLoadedAnnotationKeyRef.current = loadKey;

      // --- PATH A: Editing an existing annotation file → load from DB API ---
      if (annotationId && api && id) {
        try {
          const stored = loadStoredAnnotationsWithMirrorFallback(imageName, activeCollId);
          if (stored) {
            if (!stillFresh()) return;
            const mappedCache = commitLoadedAnnotations(
              imageName,
              activeCollId,
              stored.annotations,
              stored.dims,
              stored.fromCollId !== activeCollId ? activeCollId : undefined,
            );
            logAnnotDebug('loadAnnotationsForImage CACHE hit', {
              imageName,
              activeCollId,
              fromCollId: stored.fromCollId,
              count: mappedCache.length,
            });
            console.log(`[loadAnnotations] ${mappedCache.length} from localStorage cache`);
            return;
          }

          // Copy-target layer switch: keep live annotations already on canvas (from primary)
          // instead of clearing while the per-layer API round-trip runs.
          if (
            readCompanionDuplicateIds().includes(activeCollId)
            && annotationsRef.current.length > 0
          ) {
            if (!stillFresh()) return;
            const dims = cocoImageDimensionsRef.current[imageName]
              ?? (imageRef.current?.naturalWidth && imageRef.current?.naturalHeight
                ? { width: imageRef.current.naturalWidth, height: imageRef.current.naturalHeight }
                : undefined);
            commitLoadedAnnotations(imageName, activeCollId, annotationsRef.current, dims);
            logAnnotDebug('loadAnnotationsForImage KEEP in-memory mirror', {
              imageName,
              activeCollId,
              count: annotationsRef.current.length,
            });
            return;
          }

          // Prevent prior image polygons from lingering while the API round-trip completes
          if (!stillFresh()) return;
          logAnnotDebug('loadAnnotationsForImage CLEAR (await API)', {
            imageName,
            activeCollId,
            token: myToken,
          });
          annotationsRef.current = [];
          setAnnotations([]);

          const resp = await api.getImageAnnotations(
            id,
            annotationId,
            imageName,
            activeCollId,
          );
          if (!stillFresh()) return;
          if (resp.success && resp.data) {
            const { annotations: apiAnns, imageWidth, imageHeight } = resp.data;
            cocoImageDimensionsRef.current[imageName] = { width: imageWidth, height: imageHeight };

            const imageAnnotations: AnnotationShape[] = [];
            for (const ann of apiAnns) {
              const seg = ann.segmentation;
              const points: Point[] = [];
              if (seg && seg.length >= 6) {
                for (let i = 0; i < seg.length; i += 2) {
                  const x = seg[i], y = seg[i + 1];
                  if (isNaN(x) || isNaN(y) || !isFinite(x) || !isFinite(y)) continue;
                  points.push({ x: Math.max(0, Math.min(x, imageWidth - 1)), y: Math.max(0, Math.min(y, imageHeight - 1)) });
                }
              } else if (Array.isArray(ann.bbox) && ann.bbox.length >= 4) {
                const rect = bboxToRectPointsInPixelSpace(ann.bbox, imageWidth, imageHeight);
                rect.forEach((p) => {
                  points.push({
                    x: Math.max(0, Math.min(p.x, imageWidth - 1)),
                    y: Math.max(0, Math.min(p.y, imageHeight - 1)),
                  });
                });
              }
              if (points.length >= 3) {
                imageAnnotations.push({
                  id: `annotation_${ann.id}`,
                  type: seg && seg.length >= 6 ? 'polygon' : 'rectangle',
                  points,
                  label: ann.className,
                  color: ann.color || DEFAULT_COLORS[0],
                  visible: true,
                });
              }
            }

            const mappedFromApi = applyClassColorsToAnnotations(imageAnnotations, classes);
            annotationsRef.current = mappedFromApi;
            setAnnotations(mappedFromApi);
            logAnnotDebug('loadAnnotationsForImage API done', {
              imageName,
              activeCollId,
              count: mappedFromApi.length,
              token: myToken,
            });
            console.log(`[loadAnnotations] ${mappedFromApi.length} from API for ${imageName}`);

            if (mappedFromApi.length > 0) {
              safeLocalStorageSet(`annotations_${id}_${activeCollId}_${imageName}`, JSON.stringify(mappedFromApi));
              safeLocalStorageSet(
                `annotations_${id}_${activeCollId}_${imageName}_dims`,
                JSON.stringify({ width: imageWidth, height: imageHeight }),
              );
            }
            return;
          }

          // API returned nothing for this layer — try mirrored primary storage before staying empty
          const mirroredAfterApi = loadStoredAnnotationsWithMirrorFallback(imageName, activeCollId);
          if (mirroredAfterApi) {
            if (!stillFresh()) return;
            commitLoadedAnnotations(
              imageName,
              activeCollId,
              mirroredAfterApi.annotations,
              mirroredAfterApi.dims,
              mirroredAfterApi.fromCollId !== activeCollId ? activeCollId : undefined,
            );
            logAnnotDebug('loadAnnotationsForImage mirror fallback after empty API', {
              imageName,
              activeCollId,
              fromCollId: mirroredAfterApi.fromCollId,
            });
            return;
          }
        } catch (err) {
          console.warn('[loadAnnotations] API load failed, falling back:', err);
        }
      }

      // --- PATH B: New annotation session (no annotationId) → localStorage only ---
      try {
        const stored = loadStoredAnnotationsWithMirrorFallback(imageName, activeCollId);
        if (stored) {
          if (!stillFresh()) return;
          commitLoadedAnnotations(
            imageName,
            activeCollId,
            stored.annotations,
            stored.dims,
            stored.fromCollId !== activeCollId ? activeCollId : undefined,
          );
          logAnnotDebug('loadAnnotationsForImage PATH B localStorage', {
            imageName,
            activeCollId,
            fromCollId: stored.fromCollId,
            count: stored.annotations.length,
          });
          return;
        }
        if (!stillFresh()) return;
        logAnnotDebug('loadAnnotationsForImage CLEAR (path B empty / no saved)', { imageName, activeCollId });
        annotationsRef.current = [];
        setAnnotations([]);
        if (annotationId) loadGlobalClasses();
      } catch (error) {
        console.error('[loadAnnotations] error:', error);
        if (!stillFresh()) return;
        logAnnotDebug('loadAnnotationsForImage CLEAR (path B error)', { imageName, activeCollId, error: String(error) });
        annotationsRef.current = [];
        setAnnotations([]);
        if (annotationId) loadGlobalClasses();
      }
    } finally {
      if (stillFresh()) {
        setAnnotationsLoadingForImage(null);
      }
    }
  };

  // Keep refs in sync so stale useCallback closures always access the latest values
  // eslint-disable-next-line react-hooks/exhaustive-deps
  loadAnnotationsForImageRef.current = loadAnnotationsForImage;

  // Helper: Save annotations to localStorage with collection tracking.
  // When the user has enabled "Duplicate annotations" for one or more
  // companion collections in the picker, mirror the same write into each
  // companion's storage key so annotations also persist (and re-appear when
  // that collection is later opened as primary). Reads are unchanged.
  const saveAnnotationsToLocalStorage = useCallback((
    imageName: string,
    annotations: AnnotationShape[],
    dims?: { width: number; height: number }
  ) => {
    if (!id || !imageName) return;

    // Read via refs so save callbacks captured *before* a layer switch still
    // write to the user's currently-active collection (otherwise drawing on
    // Thermal after starting on RGB would silently keep saving under the RGB
    // key, leaving the Save button disabled for the new layer).
    const activeCollId =
      displayLayerRef.current || mainLayerRef.current || 'default';
    const targets = new Set<string>([activeCollId]);
    for (const dupId of readCompanionDuplicateIds()) {
      if (dupId && dupId !== activeCollId) targets.add(dupId);
    }

    const payload = JSON.stringify(annotations);
    const dimsPayload =
      dims && dims.width > 0 && dims.height > 0 ? JSON.stringify(dims) : null;

    for (const collId of targets) {
      safeLocalStorageSet(`annotations_${id}_${collId}_${imageName}`, payload);
      if (dimsPayload) {
        safeLocalStorageSet(`annotations_${id}_${collId}_${imageName}_dims`, dimsPayload);
      }
    }

    // Copy-off layers must never retain mirrored data for this image.
    for (const cid of readCopyOffCollectionIds()) {
      if (targets.has(cid)) continue;
      try {
        localStorage.removeItem(`annotations_${id}_${cid}_${imageName}`);
        localStorage.removeItem(`annotations_${id}_${cid}_${imageName}_dims`);
      } catch { /* ignore */ }
    }

    // Drop any other non-target layer cache that still matches this payload (stale mirror).
    for (const collection of imageCollections) {
      const cid = String(collection.id);
      if (targets.has(cid)) continue;
      if (readCopyOffCollectionIds().has(cid)) continue;
      if (readCompanionDuplicateIds().includes(cid)) continue;
      const key = `annotations_${id}_${cid}_${imageName}`;
      try {
        const existing = localStorage.getItem(key);
        if (existing && existing === payload) {
          localStorage.removeItem(key);
          localStorage.removeItem(`${key}_dims`);
        }
      } catch { /* ignore */ }
    }
  }, [id, imageCollections]);

  /** Must match the collection segment in saveAnnotationsToLocalStorage keys: annotations_${id}_${this}_${fileName} */
  const annotationStorageCollId = displayLayer || mainLayer || 'default';

  // Global statistics across all saved annotation files (all images)
  const [globalStats, setGlobalStats] = useState<{ [className: string]: number }>({});
  const [globalAvgAreas, setGlobalAvgAreas] = useState<{ [className: string]: number }>({});

  // Build a class -> set of image file names map from sessionStorage COCO + localStorage overlay.
  // Used by the "navigate by class" filter so we know which images contain each class.
  const buildClassImageMap = useCallback((): { [className: string]: Set<string> } => {
    const map: { [className: string]: Set<string> } = {};
    const add = (cn: string, name: string) => {
      if (!cn || !name) return;
      if (!map[cn]) map[cn] = new Set<string>();
      map[cn].add(name);
    };
    const remove = (cn: string, name: string) => map[cn]?.delete(name);

    const sessionRef = sessionStorage.getItem(`annotation_file_${id}`);
    const imageIdToFileName: { [id: string]: string } = {};
    if (sessionRef) {
      try {
        const fileData = JSON.parse(sessionRef);
        const cocoData = fileData?.cocoData;
        if (cocoData?.annotations && cocoData?.categories) {
          const catIdToName: { [k: string]: string } = {};
          cocoData.categories.forEach((c: any) => {
            if (c.id != null && c.name) catIdToName[c.id.toString()] = c.name;
          });
          cocoData.images?.forEach((img: any) => {
            if (img.file_name != null) imageIdToFileName[img.id.toString()] = img.file_name;
          });
          cocoData.annotations.forEach((a: any) => {
            if (a.category_id == null) return;
            const cn = catIdToName[a.category_id.toString()];
            const fn = imageIdToFileName[a.image_id?.toString()];
            if (cn && fn) add(cn, fn);
          });
        }
      } catch { /* ignore */ }
    }

    // Overlay localStorage edits
    const overlayCollId = displayLayer || mainLayer || 'default';
    const prefix = `annotations_${id}_${overlayCollId}_`;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(prefix)) continue;
      const imageName = key.substring(prefix.length);
      if (!imageName) continue;
      // Drop existing COCO-derived associations for this image, then rebuild from local
      Object.keys(map).forEach(cn => remove(cn, imageName));
      const saved = localStorage.getItem(key);
      if (!saved) continue;
      try {
        const parsed = JSON.parse(saved) as AnnotationShape[];
        parsed.forEach(a => add(a.label, imageName));
      } catch { /* ignore */ }
    }
    return map;
  }, [id, displayLayer, mainLayer]);

  const computeGlobalStats = useCallback(async () => {
    try {
      // Use same source as Dataset Annotations view (GET /classes) so numbers match
      if (annotationId && api) {
        try {
          const response = await api.getAnnotationClasses(id, annotationId);
          if (response.success && response.data?.classes?.length) {
            const counts: { [name: string]: number } = {};
            response.data.classes.forEach((c: { className: string; count?: number }) => {
              counts[c.className] = c.count ?? 0;
            });
            setGlobalStats(counts);
            setGlobalAvgAreas({});
            
            // Sync class counts with API. If classes aren't loaded yet, prev.map would clear the list — rebuild from API instead.
            const apiClasses = response.data.classes;
            setClasses((prev) => {
              if (prev.length === 0) {
                const built = apiClasses.map((c, idx) => ({
                  id: `class_${c.categoryId ?? idx}_${String(c.className).replace(/\W+/g, '_')}`,
                  name: c.className,
                  color: c.color || DEFAULT_COLORS[idx % DEFAULT_COLORS.length],
                  visible: true,
                  count: c.count ?? 0,
                }));
                try {
                  const globalClassesKey = `classes_${id}`;
                  localStorage.setItem(globalClassesKey, JSON.stringify(built));
                } catch {
                  /* ignore */
                }
                return built;
              }
              return prev.map((c) => ({
                ...c,
                count: counts[c.name] ?? 0,
              }));
            });

            // Build class -> image-names map from sessionStorage COCO + localStorage overlay
            try {
              const map = buildClassImageMap();
              setClassImageMap(map);
            } catch (e) {
              console.warn('Could not build class->image map:', e);
            }

            return;
          }
        } catch (dbError) {
          console.warn('Could not load statistics from database, falling back to computation:', dbError);
        }
      }
      
      const counts: { [name: string]: number } = {};
      const totalAreas: { [name: string]: number } = {};
      // class name -> set of image fileNames containing at least one annotation of that class
      const imagesByClass: { [name: string]: Set<string> } = {};
      const addImageToClass = (cn: string, name: string) => {
        if (!cn || !name) return;
        if (!imagesByClass[cn]) imagesByClass[cn] = new Set<string>();
        imagesByClass[cn].add(name);
      };
      const removeImageFromClass = (cn: string, name: string) => {
        if (!cn || !name) return;
        imagesByClass[cn]?.delete(name);
      };

      // Check if we have COCO data in sessionStorage (from loaded annotation file)
      const annotationFileRef = sessionStorage.getItem(`annotation_file_${id}`);
      
      if (annotationFileRef) {
        // Count from sessionStorage COCO data for accurate totals
        try {
          const fileData = JSON.parse(annotationFileRef);
          const cocoData = fileData.cocoData;
          
          if (cocoData.annotations && cocoData.categories) {
            // Build category ID to name map
            const categoryIdToName: { [id: string]: string } = {};
            cocoData.categories.forEach((cat: any) => {
              if (cat.id != null && cat.name) {
                categoryIdToName[cat.id.toString()] = cat.name;
              }
            });
            
            // Build image ID to dimensions map and image file_name -> image_id
            const imageDimensions: { [id: string]: { width: number, height: number } } = {};
            const imageFileNameToId: { [name: string]: number } = {};
            const imageIdToFileName: { [id: string]: string } = {};
            cocoData.images?.forEach((img: any) => {
              imageDimensions[img.id.toString()] = { width: img.width || 1, height: img.height || 1 };
              if (img.file_name != null) imageFileNameToId[img.file_name] = img.id;
              if (img.file_name != null) imageIdToFileName[img.id.toString()] = img.file_name;
            });
            
            // Per-image COCO counts/areas so we can replace with localStorage when present
            const cocoCountsByImage: { [imageId: string]: { [className: string]: number } } = {};
            const cocoAreasByImage: { [imageId: string]: { [className: string]: number } } = {};
            
            // Count all annotations from COCO data - only count valid ones
            let totalAnnotations = 0;
            let validAnnotations = 0;
            cocoData.annotations.forEach((annotation: any) => {
              totalAnnotations++;
              // Handle null category_id
              if (annotation.category_id == null) {
                console.warn('Annotation has null category_id, skipping:', annotation.id);
                return;
              }
              const className = categoryIdToName[annotation.category_id.toString()];
              if (className) {
                // Calculate area for segmentation annotations and validate
                let isValid = true;
                if (annotation.segmentation && annotation.segmentation.length > 0) {
                  const segmentation: number[] = cocoSegmentationToFlatCoords(annotation.segmentation);
                  if (segmentation.length >= 6) {
                    const imageDims = imageDimensions[annotation.image_id.toString()];
                    
                    // Detect if coordinates need scaling
                    const firstX = segmentation[0];
                    const firstY = segmentation[1];
                    const isAbnormallyLarge = firstX > 10000 || firstY > 10000;
                    const scaleFactor = isAbnormallyLarge && imageDims
                      ? { x: imageDims.width, y: imageDims.height }
                      : { x: 1, y: 1 };
                    
                    const points: Point[] = [];
                    for (let i = 0; i < segmentation.length; i += 2) {
                      let x = segmentation[i] / scaleFactor.x;
                      let y = segmentation[i + 1] / scaleFactor.y;
                      
                      // Filter out invalid coordinates (negative or NaN)
                      if (isNaN(x) || isNaN(y) || !isFinite(x) || !isFinite(y)) {
                        continue;
                      }
                      
                      // Clamp to image bounds if we have image dimensions
                      if (imageDims) {
                        x = Math.max(0, Math.min(x, imageDims.width - 1));
                        y = Math.max(0, Math.min(y, imageDims.height - 1));
                      }
                      
                      points.push({ x, y });
                    }
                    
                    // Only count annotation if it has at least 3 valid points
                    if (points.length >= 3) {
                      validAnnotations++;
                      const imgIdStr = annotation.image_id.toString();
                      counts[className] = (counts[className] || 0) + 1;
                      if (!cocoCountsByImage[imgIdStr]) cocoCountsByImage[imgIdStr] = {};
                      cocoCountsByImage[imgIdStr][className] = (cocoCountsByImage[imgIdStr][className] || 0) + 1;
                      const area = calculatePolygonArea(points);
                      totalAreas[className] = (totalAreas[className] || 0) + area;
                      if (!cocoAreasByImage[imgIdStr]) cocoAreasByImage[imgIdStr] = {};
                      cocoAreasByImage[imgIdStr][className] = (cocoAreasByImage[imgIdStr][className] || 0) + area;
                      addImageToClass(className, imageIdToFileName[imgIdStr]);
                    } else {
                      isValid = false;
                    }
                  } else {
                    isValid = false;
                  }
                } else {
                  // No segmentation, but has bbox - count it
                  validAnnotations++;
                  counts[className] = (counts[className] || 0) + 1;
                  const imgIdStr = annotation.image_id.toString();
                  if (!cocoCountsByImage[imgIdStr]) cocoCountsByImage[imgIdStr] = {};
                  cocoCountsByImage[imgIdStr][className] = (cocoCountsByImage[imgIdStr][className] || 0) + 1;
                  addImageToClass(className, imageIdToFileName[imgIdStr]);
                }
              }
            });
            
            // Overlay localStorage for any image that has been edited (so new/removed annotations are reflected)
            const overlayCollId = displayLayer || mainLayer || 'default';
            const prefix = `annotations_${id}_${overlayCollId}_`;
            for (let i = 0; i < localStorage.length; i++) {
              const key = localStorage.key(i);
              if (!key || !key.startsWith(prefix)) continue;
              const imageName = key.substring(prefix.length);
              if (!imageName) continue;
              const cocoImg =
                imageFileNameToId[imageName] != null
                  ? { id: imageFileNameToId[imageName] }
                  : findCocoImageForDatasetName(cocoData.images, imageName);
              if (cocoImg == null || cocoImg.id == null) continue;
              const imgIdStr = cocoImg.id.toString();
              const cocoImgCounts = cocoCountsByImage[imgIdStr] || {};
              const cocoImgAreas = cocoAreasByImage[imgIdStr] || {};
              Object.keys(cocoImgCounts).forEach(cn => {
                counts[cn] = (counts[cn] || 0) - cocoImgCounts[cn];
                if (counts[cn] <= 0) delete counts[cn];
              });
              Object.keys(cocoImgAreas).forEach(cn => {
                totalAreas[cn] = (totalAreas[cn] || 0) - cocoImgAreas[cn];
                if (totalAreas[cn] <= 0) delete totalAreas[cn];
              });
              // Local overlay supersedes COCO for this image — drop any class associations
              // that came from the COCO file for this image so we can rebuild from local data.
              const overlayImgName = imageIdToFileName[imgIdStr] || imageName;
              Object.keys(imagesByClass).forEach(cn => removeImageFromClass(cn, overlayImgName));
              const saved = localStorage.getItem(key);
              if (!saved) continue;
              try {
                const parsed = JSON.parse(saved) as AnnotationShape[];
                parsed.forEach(a => {
                  counts[a.label] = (counts[a.label] || 0) + 1;
                  if (a.type === 'polygon' && a.points && a.points.length >= 3) {
                    const area = calculatePolygonArea(a.points);
                    totalAreas[a.label] = (totalAreas[a.label] || 0) + area;
                  }
                  addImageToClass(a.label, overlayImgName);
                });
              } catch (err) {
                // ignore parse errors
              }
            }

            console.log(`Statistics: ${validAnnotations}/${totalAnnotations} valid annotations counted`);
            console.log('Computed global stats from sessionStorage:', counts);
          }
        } catch (e) {
          console.error('Error computing stats from sessionStorage:', e);
        }
      } else {
        // Fallback: scan localStorage for cached annotations
        // Build a set of image names to check
        const imageNamesToCheck = new Set<string>(allImageNames);
        const fbCollId = displayLayer || mainLayer || 'default';

        // Scan localStorage keys for any annotations_{id}_{collectionId}_* entries
        const prefix = `annotations_${id}_${fbCollId}_`;
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (!key) continue;
          if (key.startsWith(prefix)) {
            const imageName = key.substring(prefix.length);
            if (imageName) imageNamesToCheck.add(imageName);
          }
        }

        // Iterate over all discovered image names and count annotations
        imageNamesToCheck.forEach(name => {
          const key = `annotations_${id}_${fbCollId}_${name}`;
          const saved = localStorage.getItem(key);
          if (!saved) return;
          try {
            const parsed = JSON.parse(saved) as AnnotationShape[];
            parsed.forEach(a => {
              counts[a.label] = (counts[a.label] || 0) + 1;
              
              // Calculate area for polygon annotations
              if (a.type === 'polygon' && a.points && a.points.length >= 3) {
                const area = calculatePolygonArea(a.points);
                totalAreas[a.label] = (totalAreas[a.label] || 0) + area;
              }
              addImageToClass(a.label, name);
            });
          } catch (err) {
            // ignore parse errors per file
          }
        });
        
        console.log('Computed global stats from localStorage:', counts);
      }

      setGlobalStats(counts);
      setClassImageMap(imagesByClass);
      
      // Calculate average areas
      const avgAreas: { [name: string]: number } = {};
      Object.keys(totalAreas).forEach(className => {
        const count = counts[className] || 0;
        if (count > 0) {
          avgAreas[className] = totalAreas[className] / count;
        }
      });
      setGlobalAvgAreas(avgAreas);
    } catch (err) {
      console.error('Error computing global stats', err);
      setGlobalStats({});
      setGlobalAvgAreas({});
    }
  }, [allImageNames, id, annotationId, api, displayLayer, mainLayer]);

  // Debounced recompute for user actions (add/delete/edit) so rapid changes trigger one run
  const computeGlobalStatsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const computeGlobalStatsDebounced = useCallback(() => {
    if (computeGlobalStatsTimeoutRef.current) clearTimeout(computeGlobalStatsTimeoutRef.current);
    computeGlobalStatsTimeoutRef.current = setTimeout(() => {
      computeGlobalStatsTimeoutRef.current = null;
      computeGlobalStats();
    }, 150);
  }, [computeGlobalStats]);
  useEffect(() => {
    return () => {
      if (computeGlobalStatsTimeoutRef.current) clearTimeout(computeGlobalStatsTimeoutRef.current);
    };
  }, []);

  const applySam3OnAllImages = useCallback(async () => {
    if (!sam3Available || segmentModel !== 'sam3' || !segmentTextPrompt.trim()) {
      toast({ title: 'SAM 3 required', description: 'Select SAM 3 and enter a text prompt', variant: 'destructive' });
      return;
    }
    if (!selectedClass) {
      toast({ title: 'Select a class', description: 'Choose a class for the applied annotations', variant: 'destructive' });
      return;
    }
    const mainColl = imageCollections.find((c) => String(c.id) === mainLayer);
    if (!mainColl || mainColl.images.length === 0) {
      toast({ title: 'No images', description: 'No images in the current layer', variant: 'destructive' });
      return;
    }
    const classObj = classes.find((c) => c.id === selectedClass);
    if (!classObj) return;

    const apiBase = imageAnnotationApiBase();
    const total = mainColl.images.length;
    applyAllCancelledRef.current = false;
    setIsApplyingAllImages(true);
    setApplyAllProgress({ current: 0, total });

    let addedCount = 0;
    let failCount = 0;

    for (let i = 0; i < mainColl.images.length; i++) {
      if (applyAllCancelledRef.current) break;
      setApplyAllProgress({ current: i + 1, total });
      const img = mainColl.images[i];
      const imageUrl = img.url;
      if (!imageUrl) {
        failCount++;
        continue;
      }
      try {
        const res = await fetch(`${apiBase}/segment`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'sam3',
            text: segmentTextPrompt.trim(),
            imageUrl,
            point: {},
            points: [],
          }),
        });
        if (!res.ok) {
          failCount++;
          continue;
        }
        const json = await res.json();
        const rawPolygons = json.polygons || [];
        if (rawPolygons.length === 0) continue;

        // Use only the first polygon per image so we create one annotation per image (toast count matches saved count)
        const firstPoly = rawPolygons[0];
        const points: Point[] = firstPoly.map((p: number[]) => ({ x: p[0], y: p[1] }));
        if (points.length < 3) continue;
        if (samMinArea > 0 && calculatePolygonArea(points) < samMinArea) continue;

        const imageName = img.fileName;
        const newAnn: AnnotationShape = {
          id: `annotation_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
          type: 'polygon',
          points,
          label: classObj.name,
          color: classObj.color,
          visible: true,
        };

        const collId = displayLayer || mainLayer || 'default';
        const storageKey = `annotations_${id}_${collId}_${imageName}`;
        const raw = localStorage.getItem(storageKey);
        const existing: AnnotationShape[] = raw ? JSON.parse(raw) : [];
        const merged = [...existing, newAnn];
        const dims =
          img.width && img.height ? { width: img.width, height: img.height } : undefined;
        // Use the central helper so duplicate-annotation companions also receive the write
        saveAnnotationsToLocalStorage(imageName, merged, dims);
        
        addedCount += 1;
      } catch {
        failCount++;
      }
    }

    const wasCancelled = applyAllCancelledRef.current;
    setIsApplyingAllImages(false);
    setApplyAllProgress(null);

    if (wasCancelled) {
      if (addedCount > 0) {
        setHasUnsavedChanges(true);
        setClasses((prev) =>
          prev.map((c) => (c.id === classObj.id ? { ...c, count: c.count + addedCount } : c))
        );
        saveGlobalClasses(
          classes.map((c) => (c.id === classObj.id ? { ...c, count: c.count + addedCount } : c))
        );
        computeGlobalStatsDebounced();
        if (currentImageName && mainColl.images.some((img) => img.fileName === currentImageName)) {
          loadAnnotationsForImage(currentImageName);
        }
        toast({ title: 'Cancelled', description: `Applied ${addedCount} annotation(s) before cancel.` });
      } else {
        toast({ title: 'Cancelled', description: 'Apply on all images was cancelled.' });
      }
      return;
    }

    setHasUnsavedChanges(true);

    if (currentImageName && mainColl.images.some((img) => img.fileName === currentImageName)) {
      loadAnnotationsForImage(currentImageName);
    }
    setClasses((prev) =>
      prev.map((c) => (c.id === classObj.id ? { ...c, count: c.count + addedCount } : c))
    );
    saveGlobalClasses(
      classes.map((c) => (c.id === classObj.id ? { ...c, count: c.count + addedCount } : c))
    );
    computeGlobalStatsDebounced();

    if (failCount > 0) {
      toast({
        title: 'Apply on all images',
        description: `Added ${addedCount} annotations across images. ${failCount} image(s) failed.`,
        variant: 'destructive',
      });
    } else {
      toast({
        title: 'Apply on all images',
        description: `Added ${addedCount} annotation(s) across ${total} image(s).`,
      });
    }
  }, [
    sam3Available,
    segmentModel,
    segmentTextPrompt,
    samMinArea,
    selectedClass,
    mainLayer,
    imageCollections,
    classes,
    id,
    currentImageName,
    toast,
    loadAnnotationsForImage,
    computeGlobalStatsDebounced,
  ]);

  // Recompute global stats whenever we have changes to class list, image list or storage updates
  useEffect(() => {
    computeGlobalStats();

    const onStorage = (e: StorageEvent) => {
      if (!e.key) return;
      if (e.key.startsWith(`annotations_${id}_`)) {
        computeGlobalStats();
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [computeGlobalStats]);

  // Load annotations from annotation file when annotationId is provided
  const loadFromAnnotationFile = useCallback(async (annotationFileId: string, loadGeneration: number) => {
    if (!id) return;
    if (annotationFileLoadGenerationRef.current !== loadGeneration) return;

    const prevFileId = lastOpenedAnnotationFileIdRef.current;
    if (prevFileId != null && prevFileId !== annotationFileId) {
      lastLoadedAnnotationKeyRef.current = '';
      annotationsRef.current = [];
      setAnnotations([]);
      logAnnotDebug('loadFromAnnotationFile switched annotation file → cleared polygons', {
        prevFileId,
        annotationFileId,
      });
    }
    
    console.log('Loading segmentation annotations from annotation file:', annotationFileId);
    
    // Clear all cached annotations for this dataset to ensure fresh load with correct coordinates
    console.log('Clearing cached annotations from localStorage...');
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(`annotations_${id}_`)) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach(key => localStorage.removeItem(key));
    console.log(`Cleared ${keysToRemove.length} cached annotation entries`);

    if (annotationFileLoadGenerationRef.current !== loadGeneration) return;
    
    // First try to load from saved_annotations localStorage
    const savedAnnotations = localStorage.getItem(`saved_annotations_${id}`);
    if (savedAnnotations) {
      const annotationsList = JSON.parse(savedAnnotations);
      const targetAnnotation = annotationsList.find((ann: any) => ann.id === annotationFileId);
      
      if (targetAnnotation && targetAnnotation.content) {
        console.log('Found annotation file in localStorage:', targetAnnotation.name);
        
        setAnnotationName(targetAnnotation.name);
        const cocoData = targetAnnotation.content;
        return loadAnnotationsFromCOCO(cocoData, annotationFileId, loadGeneration);
      }
    }
    
    // If not found in localStorage, try loading from backend
    if (api) {
      try {
        console.log('Fetching annotation from backend for file ID:', annotationFileId);
        // First get annotation metadata to get the name
        const annotationResponse = await api.getAnnotation(id, annotationFileId);
        if (annotationFileLoadGenerationRef.current !== loadGeneration) return;
        const response = await api.getAnnotationContent(id, annotationFileId);
        if (annotationFileLoadGenerationRef.current !== loadGeneration) return;
        
        console.log('Backend response:', response);
        
        if (!response.success || !response.data) {
          console.error('Invalid response from backend:', response);
          throw new Error('No content in response');
        }

        const payload = response.data;
        if (payload.is_processing) {
          throw new Error(payload.message || 'Annotation import is still processing. Try again shortly.');
        }
        if (payload.is_large) {
          // Full COCO JSON is capped on the server — segmentation editor already loads each
          // image via GET .../image-annotations when annotationId is set. Build a minimal COCO
          // shell (categories + images only) so loadAnnotationsFromCOCO can init classes/session.
          if (annotationFileLoadGenerationRef.current !== loadGeneration) return;
          const [classesRes, imagesRes] = await Promise.all([
            api.getAnnotationClasses(id, annotationFileId),
            api.getImages(id),
          ]);
          if (annotationFileLoadGenerationRef.current !== loadGeneration) return;
          if (!classesRes.success || !imagesRes.success) {
            throw new Error(
              classesRes.error ||
                imagesRes.error ||
                'Could not load classes or images for this annotation file.',
            );
          }
          const apiClasses = classesRes.data?.classes ?? [];
          if (apiClasses.length === 0) {
            throw new Error(
              'No classes found for this annotation file yet. If import just finished, wait a moment and retry.',
            );
          }
          const categories = apiClasses.map(
            (c: { className: string; categoryId?: number }, idx: number) => ({
              id: c.categoryId ?? idx + 1,
              name: c.className,
              supercategory: '',
            }),
          );
          const imgs = imagesRes.data ?? [];
          if (!Array.isArray(imgs) || imgs.length === 0) {
            throw new Error('This dataset has no images — cannot open the segmentation editor.');
          }
          const cocoImages = imgs.map(
            (img: { fileName: string; width?: number; height?: number }, idx: number) => ({
              id: idx + 1,
              file_name: img.fileName,
              width: img.width || 1,
              height: img.height || 1,
            }),
          );
          const cocoData = {
            info: {},
            categories,
            images: cocoImages,
            annotations: [],
          };
          if (annotationResponse.success && annotationResponse.data?.file_name) {
            setAnnotationName(annotationResponse.data.file_name);
          }
          const n = payload.total_annotations;
          toast({
            title: 'Large annotation file',
            description:
              typeof n === 'number'
                ? `About ${n.toLocaleString()} annotations — loading in database mode. Shapes load when you open each image.`
                : 'Many annotations — loading in database mode. Shapes load when you open each image.',
          });
          return loadAnnotationsFromCOCO(cocoData, annotationFileId, loadGeneration);
        }

        const rawContent = payload.content;
        const contentStr =
          typeof rawContent === 'string'
            ? rawContent
            : rawContent != null
              ? JSON.stringify(rawContent)
              : null;

        if (contentStr) {
          console.log('Loading segmentation annotations from backend, content length:', contentStr.length);
          
          // Set annotation name if available
          if (annotationResponse.success && annotationResponse.data?.file_name) {
            setAnnotationName(annotationResponse.data.file_name);
          }
          
          try {
            const cocoData = JSON.parse(contentStr);
            console.log('Parsed COCO data:', {
              images: cocoData.images?.length,
              annotations: cocoData.annotations?.length,
              categories: cocoData.categories?.length
            });
            
            // Log sample annotation to verify format
            if (cocoData.annotations && cocoData.annotations.length > 0) {
              const sampleAnn = cocoData.annotations[0];
              console.log('Sample annotation from API:', {
                id: sampleAnn.id,
                image_id: sampleAnn.image_id,
                category_id: sampleAnn.category_id,
                has_segmentation: !!sampleAnn.segmentation,
                segmentation_length: sampleAnn.segmentation?.length || 0,
                first_polygon_length: sampleAnn.segmentation?.[0]?.length || 0
              });
            }
            
            return loadAnnotationsFromCOCO(cocoData, annotationFileId, loadGeneration);
          } catch (parseError) {
            console.error('Failed to parse COCO JSON:', parseError);
            console.error('Content preview:', contentStr.substring(0, 500));
            throw new Error('Invalid JSON format in annotation content');
          }
        } else {
          console.error('Invalid response from backend:', response);
          throw new Error('No content in response');
        }
      } catch (error) {
        console.error('Failed to load annotation from backend:', error);
        toast({
          title: "Failed to load annotations",
          description: error instanceof Error ? error.message : "Could not load the selected annotation file.",
          variant: "destructive",
        });
        return false;
      }
    }
    
    toast({
      title: "Annotation file not found",
      description: "The selected annotation file could not be found.",
      variant: "destructive",
    });
    return false;
  }, [id, api, toast]);

  // Helper function to load annotations from COCO format
  const loadAnnotationsFromCOCO = useCallback(async (cocoData: any, fileId?: string, loadGeneration?: number) => {
    try {
      if (
        loadGeneration != null
        && annotationFileLoadGenerationRef.current !== loadGeneration
      ) {
        return false;
      }
      console.log('Loading COCO data:', {
        hasCategories: !!cocoData.categories,
        categoryCount: cocoData.categories?.length || 0,
        hasImages: !!cocoData.images,
        imageCount: cocoData.images?.length || 0,
        hasAnnotations: !!cocoData.annotations,
        annotationCount: cocoData.annotations?.length || 0,
        cocoDataKeys: Object.keys(cocoData)
      });
      
      // Validate COCO data structure
      if (!cocoData.categories || !Array.isArray(cocoData.categories)) {
        throw new Error('Missing or invalid categories in COCO data');
      }
      if (!cocoData.images || !Array.isArray(cocoData.images)) {
        throw new Error('Missing or invalid images in COCO data');
      }
      if (!cocoData.annotations || !Array.isArray(cocoData.annotations)) {
        throw new Error('Missing or invalid annotations in COCO data');
      }

      const { hasMasks, hasBboxesOnly } = detectSegmentationModeCapabilities(cocoData);
      if (hasMasks) {
        setAnnotationMode('mask');
        setModeLocked(true);
        setBboxSwitchAllowed(false);
        setModeLockReason('This annotation file contains masks and must stay in mask mode.');
      } else if (hasBboxesOnly) {
        setAnnotationMode('bbox');
        setModeLocked(true);
        setBboxSwitchAllowed(false);
        setModeLockReason('BBox-only file: editing is locked to bounding box mode.');
      } else {
        // New/empty file: allow one-way switch to bbox mode.
        setAnnotationMode('mask');
        setModeLocked(false);
        setBboxSwitchAllowed(true);
        setModeLockReason(null);
      }

      // If COCO has no categories (e.g. after rename/save race), load from backend so classes are not lost
      if (cocoData.categories.length === 0 && api && fileId) {
        try {
          const res = await api.getAnnotationClasses(id, fileId);
          if (
            loadGeneration != null
            && annotationFileLoadGenerationRef.current !== loadGeneration
          ) {
            return false;
          }
          if (res?.success && res.data?.classes?.length) {
            cocoData.categories = res.data.classes.map((c: { className: string; categoryId?: number }, idx: number) => ({
              id: c.categoryId ?? idx + 1,
              name: c.className,
              supercategory: ''
            }));
            console.log('Populated categories from backend:', cocoData.categories.length);
          }
        } catch (e) {
          console.warn('Could not load classes from backend for empty COCO:', e);
        }
      }
      
      // Do not clear lastLoadedAnnotationKeyRef here: the debounced AnnotationLoader often finishes first
      // and sets lastLoaded + polygons; nulling this ref made the follow-up loadAnnotationsForImage
      // skip the early-return and run setAnnotations([]), so masks flashed then disappeared.

      // Don't load all annotations at once - just prepare the data structure
      // and load on-demand when navigating to images
      const classSet = new Set<string>();
      const classColorMap: { [name: string]: string } = {};
      
      // Extract classes from categories
      if (cocoData.categories) {
        console.log('Processing categories:', cocoData.categories);
        cocoData.categories.forEach((category: any, index: number) => {
          if (category && category.name) {
            classSet.add(category.name);
            // Assign colors from default palette
            classColorMap[category.name] = DEFAULT_COLORS[index % DEFAULT_COLORS.length];
          } else {
            console.warn('Invalid category:', category);
          }
        });
        console.log('Extracted classes:', Array.from(classSet));
      } else {
        console.warn('No categories found in COCO data');
      }
      
      // Store the full COCO data in sessionStorage for lazy loading
      const annotationFileRef = {
        id: fileId || `loaded_${Date.now()}`,
        cocoData: cocoData,
        imageCount: cocoData.images?.length || 0,
        annotationCount: cocoData.annotations?.length || 0
      };
      
      try {
        // Clear old sessionStorage first
        const sessionKey = `annotation_file_${id}`;
        sessionStorage.removeItem(sessionKey);
        // Then store new data
        sessionStorage.setItem(sessionKey, JSON.stringify(annotationFileRef));
        console.log(`Stored fresh COCO data in sessionStorage (${cocoData.images?.length} images, ${cocoData.annotations?.length} annotations)`);
        // Store COCO image dimensions so we can scale loaded coordinates to actual image dimensions when drawing
        cocoImageDimensionsRef.current = {};
        cocoData.images?.forEach((img: any) => {
          if (img.file_name != null) {
            cocoImageDimensionsRef.current[img.file_name] = {
              width: img.width || 1,
              height: img.height || 1
            };
          }
        });
      } catch (e) {
        console.warn('Could not save annotation file reference to sessionStorage:', e);
        return false;
      }
      
      // Clear all localStorage annotation caches for this dataset
      try {
        const keysToRemove: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.startsWith(`annotations_${id}_`)) {
            keysToRemove.push(key);
          }
        }
        keysToRemove.forEach(key => localStorage.removeItem(key));
        console.log(`Cleared ${keysToRemove.length} annotation caches from localStorage`);
      } catch (e) {
        console.warn('Could not clear localStorage annotation caches:', e);
      }

      if (
        loadGeneration != null
        && annotationFileLoadGenerationRef.current !== loadGeneration
      ) {
        return false;
      }
      
      // Update classes
      const newClasses: AnnotationClass[] = Array.from(classSet).map((className, index) => ({
        id: `class_${Date.now()}_${index}`,
        name: className,
        color: classColorMap[className] || DEFAULT_COLORS[index % DEFAULT_COLORS.length],
        visible: true,
        count: 0 // Will be updated by computeGlobalStats
      }));
      
      console.log('Setting classes:', newClasses);
      setClasses(newClasses);
      saveGlobalClasses(newClasses);
      
      // Load annotations for the first 2 images to populate the statistics
      const imageNames = cocoData.images?.slice(0, 2).map((img: any) => img.file_name) || [];
      let loadedCount = 0;
      
      imageNames.forEach((imageName: string) => {
        const imageEntry = findCocoImageForDatasetName(cocoData.images, imageName);
        if (!imageEntry) return;
        
        const imageAnnotations: AnnotationShape[] = [];
        const categoryIdToName: { [id: string]: string } = {};
        
        cocoData.categories.forEach((cat: any) => {
          if (cat.id != null) {
            categoryIdToName[cat.id.toString()] = cat.name;
          }
        });
        
        cocoData.annotations.forEach((annotation: any) => {
          if (String(annotation.image_id) === String(imageEntry.id)) {
            // Handle null category_id
            if (annotation.category_id == null) {
              console.warn(`Skipping annotation for ${imageName}: null category_id`);
              return;
            }
            const categoryId = annotation.category_id;
            const className = categoryIdToName[categoryId.toString()];
            
            if (className && annotation.segmentation && annotation.segmentation.length > 0) {
              // COCO: segmentation is [[x1,y1,x2,y2,...]]; some exports use flat [x1,y1,x2,y2,...]
              const segmentation: number[] = cocoSegmentationToFlatCoords(annotation.segmentation);
              if (segmentation.length >= 6) {
                const points: Point[] = [];
                
                // Detect and fix abnormally large coordinates
                const firstX = segmentation[0];
                const firstY = segmentation[1];
                const isAbnormallyLarge = firstX > 10000 || firstY > 10000;
                const scaleFactor = isAbnormallyLarge && imageEntry.width && imageEntry.height
                  ? { x: imageEntry.width, y: imageEntry.height }
                  : { x: 1, y: 1 };
                
                for (let i = 0; i < segmentation.length; i += 2) {
                  let x = segmentation[i] / scaleFactor.x;
                  let y = segmentation[i + 1] / scaleFactor.y;
                  
                  // Filter out invalid coordinates (negative or NaN)
                  if (isNaN(x) || isNaN(y) || !isFinite(x) || !isFinite(y)) {
                    continue;
                  }
                  
                  // Clamp to image bounds if we have image dimensions
                  if (imageEntry.width && imageEntry.height) {
                    x = Math.max(0, Math.min(x, imageEntry.width - 1));
                    y = Math.max(0, Math.min(y, imageEntry.height - 1));
                  }
                  
                  points.push({ x, y });
                }
                
                imageAnnotations.push({
                  id: `annotation_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                  type: 'polygon',
                  points,
                  label: className,
                  color: classColorMap[className] || DEFAULT_COLORS[0],
                  visible: true
                });
              }
            } else if (className && Array.isArray(annotation.bbox) && annotation.bbox.length >= 4) {
              const points = bboxToRectPointsInPixelSpace(
                annotation.bbox,
                imageEntry.width,
                imageEntry.height,
              );
              if (points.length >= 4) {
                imageAnnotations.push({
                  id: `annotation_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                  type: 'rectangle',
                  points,
                  label: className,
                  color: classColorMap[className] || DEFAULT_COLORS[0],
                  visible: true
                });
              }
            }
          }
        });
        
        if (imageAnnotations.length > 0) {
          const storageKey = `annotations_${id}_${annotationStorageCollId}_${imageName}`;
          try {
            safeLocalStorageSet(storageKey, JSON.stringify(imageAnnotations));
            loadedCount++;
          } catch (e) {
            console.warn(`Could not cache annotations for ${imageName}`);
          }
        }
      });
      
      console.log(`Pre-loaded annotations for ${loadedCount} images`);
      
      // Load annotations for current image — use refs so stale closures always see the latest values
      const latestImageName = currentImageNameRef.current || currentImageName;
      if (
        latestImageName
        && loadAnnotationsForImageRef.current
        && (loadGeneration == null
          || annotationFileLoadGenerationRef.current === loadGeneration)
      ) {
        logAnnotDebug('loadAnnotationsFromCOCO → tail loadAnnotationsForImage', {
          latestImageName,
          refName: currentImageNameRef.current,
          stateName: currentImageName,
          loadGeneration,
          genNow: annotationFileLoadGenerationRef.current,
          annotRefLen: annotationsRef.current.length,
        });
        loadAnnotationsForImageRef.current(latestImageName);
      }

      if (
        loadGeneration != null
        && annotationFileLoadGenerationRef.current !== loadGeneration
      ) {
        return false;
      }
      
      // Recompute global stats and wait for it to complete
      await computeGlobalStats();

      if (
        loadGeneration != null
        && annotationFileLoadGenerationRef.current !== loadGeneration
      ) {
        return false;
      }
      
      toast({
        title: "Annotations loaded",
        description: `Loaded annotation file with ${cocoData.images?.length || 0} images. Annotations load on-demand as you navigate.`,
      });

      if (fileId) lastOpenedAnnotationFileIdRef.current = fileId;
      return true;
    } catch (error) {
      console.error('Error parsing COCO data:', error);
      toast({
        title: "Failed to parse annotations",
        description: "The annotation file format is invalid.",
        variant: "destructive",
      });
      return false;
    }
  }, [id, api, computeGlobalStats, toast, annotationStorageCollId]);

  // Load from annotation file if annotationId is provided
  useEffect(() => {
    let invalidateAnnotationFileLoadOnCleanup = false;
    if (annotationId && !isLoading) {
      // Skip reload if we just saved - data is already in localStorage
      if (justSavedRef.current) {
        console.log('Skipping reload after save - data already in localStorage');
        justSavedRef.current = false;
        return undefined;
      }

      annotationFileLoadGenerationRef.current += 1;
      const loadGen = annotationFileLoadGenerationRef.current;
      invalidateAnnotationFileLoadOnCleanup = true;
      
      // Wait for images to be loaded before attempting to load annotation file
      console.log('Loading annotation file with ID:', annotationId);
      void loadFromAnnotationFile(annotationId, loadGen).then((success) => {
        if (annotationFileLoadGenerationRef.current !== loadGen) return;
        if (success) {
          console.log('Annotation file loaded successfully');
        } else {
          console.error('Failed to load annotation file');
        }
      });
    } else if (!annotationId && !isLoading && id) {
      // Starting new annotations - clear any cached data to ensure clean slate
      console.log('Starting new annotations - clearing cached data');
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(`annotations_${id}_`)) {
          keysToRemove.push(key);
        }
      }
      keysToRemove.forEach(key => localStorage.removeItem(key));
      
      // Also clear sessionStorage annotation file reference and COCO dimensions
      sessionStorage.removeItem(`annotation_file_${id}`);
      cocoImageDimensionsRef.current = {};
      
      // Clear annotations state and classes for fresh start
      annotationsRef.current = [];
      setAnnotations([]);
      setClasses([]);
      localStorage.removeItem(`classes_${id}`);
      setGlobalStats({});
      setGlobalAvgAreas({});
      
      console.log(`Cleared ${keysToRemove.length} cached entries for new annotation session`);
    }
    return () => {
      if (invalidateAnnotationFileLoadOnCleanup) {
        annotationFileLoadGenerationRef.current += 1;
      }
    };
  }, [annotationId, isLoading, loadFromAnnotationFile, id]);

  // Ensure annotations are loaded for current image when editing an existing annotation file.
  // Uses a ref to prevent infinite retries: once we've attempted a load for a given image, don't retry.
  const attemptedLoadRef = useRef<string | null>(null);
  useEffect(() => {
    if (!annotationId || !currentImageName || isLoading) return;
    if (annotationsRef.current.length > 0 && lastLoadedAnnotationKeyRef.current === `${displayLayerRef.current || mainLayerRef.current || 'default'}::${currentImageName}`) return;
    if (attemptedLoadRef.current === currentImageName) return;
    attemptedLoadRef.current = currentImageName;

    const timeoutId = setTimeout(() => {
      logAnnotDebug('AnnotationLoader timeout → loadAnnotationsForImage', {
        currentImageName,
        annotRefLen: annotationsRef.current.length,
        lastLoaded: lastLoadedAnnotationKeyRef.current,
      });
      console.log('[AnnotationLoader] loading from API for:', currentImageName);
      loadAnnotationsForImageRef.current?.(currentImageName);
    }, 150);
    return () => clearTimeout(timeoutId);
  }, [annotationId, currentImageName, isLoading, id]);
  // Reset the attempted-load guard when image changes so navigating to another image works
  useEffect(() => {
    attemptedLoadRef.current = null;
  }, [currentImageName]);

  const hasAnyAnnotations = Object.values(globalStats).reduce((s, v) => s + v, 0) > 0;
  // If globalStats is empty, check localStorage for any annotations entries as a fallback
  const hasAnyAnnotationsStored = (() => {
    if (hasAnyAnnotations) return true;
    const prefix = `annotations_${id}_`;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      if (key.startsWith(prefix)) return true;
    }
    return false;
  })();

  // Convert screen coordinates to image coordinates
  const screenToImageCoords = useCallback((screenX: number, screenY: number): Point => {
    if (!canvasRef.current) return { x: 0, y: 0 };
    
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    
    // Get coordinates relative to canvas
    const canvasX = screenX - rect.left;
    const canvasY = screenY - rect.top;
    
    // Convert to image coordinates
    const imageX = (canvasX - imageOffset.x) / imageScale;
    const imageY = (canvasY - imageOffset.y) / imageScale;
    
    return { x: imageX, y: imageY };
  }, [imageScale, imageOffset]);

  // Wheel handler for zooming (use Ctrl/Cmd + wheel to zoom) - placed after screenToImageCoords
  useEffect(() => {
    const container = containerRef.current || canvasRef.current;
    if (!container) return;

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();

      const rect = (container as HTMLElement).getBoundingClientRect();
      const screenX = e.clientX - rect.left;
      const screenY = e.clientY - rect.top;

      // Convert screen point to image coordinates using current scale/offset
      const imagePoint = screenToImageCoords(e.clientX, e.clientY);

      const zoomIntensity = 0.0015;
      const wheel = e.deltaY;
      const factor = Math.exp(-wheel * zoomIntensity);

      const minScale = 0.02;
      const maxScale = 20;
      const desired = clamp((scaleRef.current || imageScale) * factor, minScale, maxScale);

      animateToScale(desired, imagePoint, { x: screenX, y: screenY });
    };

    container.addEventListener('wheel', onWheel, { passive: false });
    return () => container.removeEventListener('wheel', onWheel);
  }, [screenToImageCoords, imageScale]);

  // Convert image coordinates to screen coordinates
  const imageToScreenCoords = useCallback((imageX: number, imageY: number): Point => {
    const screenX = imageX * imageScale + imageOffset.x;
    const screenY = imageY * imageScale + imageOffset.y;
    return { x: screenX, y: screenY };
  }, [imageScale, imageOffset]);

  // Point-in-polygon algorithm for hit detection
  const isPointInPolygon = useCallback((point: Point, polygon: Point[]): boolean => {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      if (((polygon[i].y > point.y) !== (polygon[j].y > point.y)) &&
          (point.x < (polygon[j].x - polygon[i].x) * (point.y - polygon[i].y) / (polygon[j].y - polygon[i].y) + polygon[i].x)) {
        inside = !inside;
      }
    }
    return inside;
  }, []);

  // Find annotation at given point (x,y are in natural image space)
  const findAnnotationAtPoint = useCallback((x: number, y: number): AnnotationShape | null => {
    // Convert click coords from display space to annotation storage space
    let qx = x, qy = y;
    const sa = annotScaleToAnnotRef.current;
    if (sa.x !== 1 || sa.y !== 1) {
      // Annotation layer is set — use its scale factor
      qx = x * sa.x;
      qy = y * sa.y;
    } else if (!annotationId && currentImage?.fileName && imageRef.current) {
      // Remap if stored annotation space differs from decoded bitmap (natural) size
      const refDims = getAnnotReferenceDimensions(currentImage.fileName);
      const nw = imageRef.current.naturalWidth;
      const nh = imageRef.current.naturalHeight;
      if (refDims && nw > 0 && nh > 0 && (refDims.width !== nw || refDims.height !== nh)) {
        qx = x * (refDims.width / nw);
        qy = y * (refDims.height / nh);
      }
    }
    for (const annotation of annotations) {
      if (!annotation.visible) continue;

      if (annotation.type === 'polygon') {
        if (isPointInPolygon({ x: qx, y: qy }, annotation.points)) {
          return annotation;
        }
      } else if (annotation.type === 'rectangle' && annotation.points.length >= 2) {
        const [x, y, w, h] = pointsToBbox(annotation.points);
        if (qx >= x && qx <= x + w && qy >= y && qy <= y + h) {
          return annotation;
        }
      }
    }
    return null;
  }, [annotations, isPointInPolygon, currentImage, getAnnotReferenceDimensions, annotationId]);

  // Create new annotation
  const createAnnotation = useCallback((type: 'rectangle' | 'circle' | 'polygon', points: Point[]) => {
    if (!selectedClass || !currentImage) return;

    const classObj = classes.find(c => c.id === selectedClass);
    if (!classObj) return;

    // Convert display-space points to annotation-storage space using the
    // annotation-layer scale factor (identity when annotating in place).
    const sa = annotScaleToAnnotRef.current;
    const finalPoints = (sa.x !== 1 || sa.y !== 1)
      ? points.map(p => ({ x: p.x * sa.x, y: p.y * sa.y }))
      : points;

    const newAnnotation: AnnotationShape = {
      id: `annotation_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type,
      points: finalPoints,
      label: classObj.name,
      color: classObj.color,
      visible: true
    };

    setAnnotations(prev => {
      const updated = [...prev, newAnnotation];
      // Auto-save to localStorage with collection tracking
      const annotDims = annotLayerDimsRef.current;
      const saveDims = annotDims
        ? { width: annotDims.width, height: annotDims.height }
        : { width: imageRef.current?.naturalWidth || 0, height: imageRef.current?.naturalHeight || 0 };
      saveAnnotationsToLocalStorage(currentImageName, updated, saveDims);
      return updated;
    });
    
    // Mark as unsaved
    setHasUnsavedChanges(true);
    
    // Update class count and save globally
    setClasses(prev => {
      const updated = prev.map(c => 
        c.id === selectedClass 
          ? { ...c, count: c.count + 1 }
          : c
      );
      saveGlobalClasses(updated);
      return updated;
    });

    toast({
      title: 'Annotation created',
      description: `${type} annotation added for class "${classObj.name}"`,
    });
    computeGlobalStatsDebounced();
  }, [selectedClass, classes, toast, currentImage, id, computeGlobalStatsDebounced]);

  const handleCanvasMouseDown = useCallback((e: React.MouseEvent) => {
    if (!canvasRef.current || !currentImage) return;

    // If middle button, space, Ctrl + left/right mouse, or right+left mouse is pressed, start panning
    if (e.button === 1 || spacePressedRef.current || ((e.button === 0 || e.button === 2) && e.ctrlKey) || (e.button === 0 && rightMouseDownRef.current)) {
      e.preventDefault();
      isPanningRef.current = true;
      panStartRef.current = { x: e.clientX, y: e.clientY };
      // Preserve zoom when user starts panning
      preserveZoomRef.current = true;
      preventZoomResetRef.current = true;
      return;
    }

    const imageCoords = screenToImageCoords(e.clientX, e.clientY);

    // If Auto tool is active, trigger backend segmentation for the clicked image point
    if (activeTool === 'auto-segment') {
      if (isSamModelLoading || isSamProcessing) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (classes.length === 0) {
        toast({
          title: 'No classes',
          description: 'Add at least one class before using SAM.',
          variant: 'destructive',
        });
        return;
      }
      // don't start auto-seg while drawing or while panning
      if (!isDrawing && !isPanningRef.current) {
        // Left-click = positive point (1), right-click = negative point (0 = remove from mask)
        const label = e.button === 2 ? 0 : 1;
        if (e.button === 2) {
          e.preventDefault();
          e.stopPropagation();
        }
        startAutoSegment(imageCoords, label);
      }
      return;
    }

    if (activeTool === 'select') {
      // Check if clicking on existing annotation
      const clickedAnnotation = findAnnotationAtPoint(imageCoords.x, imageCoords.y);
      setSelectedAnnotation(clickedAnnotation?.id || null);
      
      if (clickedAnnotation) {
        setIsMovingAnnotation(true);
        setMoveOffset({
          x: imageCoords.x,
          y: imageCoords.y
        });
      } else {
        setIsDragging(true);
        setDragStart({ x: e.clientX, y: e.clientY });
      }
    } else if (activeTool === 'polygon') {
      if (!selectedClass) {
        toast({
          title: 'No class selected',
          description: 'Please select a class before drawing annotations',
          variant: 'destructive'
        });
        return;
      }
      
      if (!isDrawing) {
        setIsDrawing(true);
        setCurrentPath([imageCoords]);
      } else {
        setCurrentPath(prev => [...prev, imageCoords]);
      }
    } else if (activeTool === 'pencil') {
      if (!selectedClass) {
        toast({
          title: 'No class selected',
          description: 'Please select a class before drawing annotations',
          variant: 'destructive'
        });
        return;
      }
      // Begin a free-hand stroke; points will be sampled on mouse move and
      // the stroke will be committed as a polygon on mouse up.
      setIsDrawing(true);
      setCurrentPath([imageCoords]);
    } else if (activeTool === 'rectangle') {
      if (!selectedClass) {
        toast({
          title: 'No class selected',
          description: 'Please select a class before drawing annotations',
          variant: 'destructive'
        });
        return;
      }
      setIsDrawing(true);
      setCurrentPath([imageCoords, imageCoords]);
    }
  }, [activeTool, selectedClass, classes.length, isDrawing, screenToImageCoords, findAnnotationAtPoint, startAutoSegment, toast, isSamModelLoading, isSamProcessing]);

  const handleCanvasMouseMove = useCallback((e: React.MouseEvent) => {
    if (!canvasRef.current || !currentImage) return;

    // Track cursor position in image coordinates for status bar
    const imageCoords = screenToImageCoords(e.clientX, e.clientY);
    setCursorImagePosition(imageCoords);

    // Free-hand pencil: while the mouse is down and pencil is the active
    // tool, sample points along the cursor path. We thin the stream so we
    // don't store an excessive number of nearly-identical points.
    if (isDrawing && activeTool === 'pencil') {
      setCurrentPath(prev => {
        if (prev.length === 0) return [imageCoords];
        const last = prev[prev.length - 1];
        const dx = imageCoords.x - last.x;
        const dy = imageCoords.y - last.y;
        if (dx * dx + dy * dy < 4) return prev; // ~2px min spacing in image coords
        return [...prev, imageCoords];
      });
      return;
    }

    if (isDrawing && activeTool === 'rectangle') {
      setCurrentPath((prev) => {
        if (prev.length === 0) return [imageCoords, imageCoords];
        return [prev[0], imageCoords];
      });
      return;
    }

    // Handle panning (middle button or space+drag)
    if (isPanningRef.current) {
      const deltaX = e.clientX - panStartRef.current.x;
      const deltaY = e.clientY - panStartRef.current.y;
      setImageOffset(prev => ({ x: prev.x + deltaX, y: prev.y + deltaY }));
      panStartRef.current = { x: e.clientX, y: e.clientY };
      return;
    }

    if (isDragging) {
      const deltaX = e.clientX - dragStart.x;
      const deltaY = e.clientY - dragStart.y;
      
      setImageOffset(prev => ({
        x: prev.x + deltaX,
        y: prev.y + deltaY
      }));
      
      setDragStart({ x: e.clientX, y: e.clientY });
    } else if (isMovingAnnotation && selectedAnnotation) {
      const imageCoords = screenToImageCoords(e.clientX, e.clientY);
      let deltaX = imageCoords.x - moveOffset.x;
      let deltaY = imageCoords.y - moveOffset.y;
      // Scale delta to annotation storage space.
      const sa = annotScaleToAnnotRef.current;
      if (sa.x !== 1 || sa.y !== 1) {
        // Annotation layer set — use its scale factor
        deltaX *= sa.x;
        deltaY *= sa.y;
      } else if (!annotationId && currentImage?.fileName && imageRef.current) {
        const refDims = getAnnotReferenceDimensions(currentImage.fileName);
        const nw = imageRef.current.naturalWidth;
        const nh = imageRef.current.naturalHeight;
        if (refDims && nw > 0 && nh > 0 && (refDims.width !== nw || refDims.height !== nh)) {
          deltaX *= refDims.width / nw;
          deltaY *= refDims.height / nh;
        }
      }
      
      setAnnotations(prev => prev.map(ann => {
        if (ann.id === selectedAnnotation) {
          return {
            ...ann,
            points: ann.points.map(point => ({
              x: point.x + deltaX,
              y: point.y + deltaY
            }))
          };
        }
        return ann;
      }));
      
      // Auto-save after moving (use same scaled delta when reading from localStorage)
      const deltaXFinal = deltaX;
      const deltaYFinal = deltaY;
      setTimeout(() => {
        if (currentImageName) {
          const storageKey = `annotations_${id}_${annotationStorageCollId}_${currentImageName}`;
          const currentAnnotations = JSON.parse(localStorage.getItem(storageKey) || '[]');
          const updatedAnnotations = currentAnnotations.map((ann: AnnotationShape) => {
            if (ann.id === selectedAnnotation) {
              return {
                ...ann,
                points: ann.points.map((point: Point) => ({
                  x: point.x + deltaXFinal,
                  y: point.y + deltaYFinal
                }))
              };
            }
            return ann;
          });
          const saveDims = imageRef.current?.naturalWidth && imageRef.current?.naturalHeight
            ? { width: imageRef.current.naturalWidth, height: imageRef.current.naturalHeight }
            : undefined;
          saveAnnotationsToLocalStorage(currentImageName, updatedAnnotations, saveDims);
          setHasUnsavedChanges(true);
        }
      }, 100);
      
      setMoveOffset(imageCoords);
    }
  }, [isDragging, dragStart, isMovingAnnotation, selectedAnnotation, moveOffset, screenToImageCoords, currentImage, isDrawing, activeTool, id, currentImageName, annotationStorageCollId, saveAnnotationsToLocalStorage, getAnnotReferenceDimensions, annotationId]);

  const handleCanvasMouseUp = useCallback(() => {
    if (isPanningRef.current) {
      isPanningRef.current = false;
      // Clear the prevent zoom reset flag after a short delay to allow any pending events to settle
      setTimeout(() => {
        preventZoomResetRef.current = false;
      }, 100);
      return;
    }

    // Finalize a free-hand pencil stroke into a polygon annotation.
    if (isDrawing && activeTool === 'pencil') {
      if (currentPath.length >= 3) {
        createAnnotation('polygon', currentPath);
      } else {
        toast({
          title: 'Stroke too short',
          description: 'Drag to draw a longer shape (need at least 3 points).',
          variant: 'destructive',
        });
      }
      setIsDrawing(false);
      setCurrentPath([]);
      return;
    }

    // Finalize rectangle into a bbox annotation.
    if (isDrawing && activeTool === 'rectangle') {
      if (currentPath.length >= 2) {
        const [p1, p2] = currentPath;
        const rectPoints = bboxToRectPoints(pointsToBbox([p1, p2]));
        createAnnotation('rectangle', rectPoints);
      }
      setIsDrawing(false);
      setCurrentPath([]);
      return;
    }

    if (isDragging) {
      setIsDragging(false);
    } else if (isMovingAnnotation) {
      setIsMovingAnnotation(false);
    }
  }, [isDragging, isMovingAnnotation, isDrawing, activeTool, currentPath, createAnnotation, toast]);

  const handleCanvasDoubleClick = useCallback(() => {
    if (isDrawing && activeTool === 'polygon' && currentPath.length >= 3) {
      // Complete polygon
      createAnnotation('polygon', currentPath);
      setIsDrawing(false);
      setCurrentPath([]);
    }
  }, [isDrawing, activeTool, currentPath, createAnnotation]);

  const handleCanvasRightClick = useCallback((e: React.MouseEvent) => {
    // If Ctrl+right was used for panning, don't show context menu or complete polygon
    if ((e as unknown as MouseEvent).ctrlKey) {
      e.preventDefault();
      return;
    }

    // Right-click for SAM is handled in handleCanvasMouseDown (e.button === 2); prevent context menu when SAM is active
    if (activeTool === 'auto-segment') {
      e.preventDefault();
      return;
    }

    e.preventDefault(); // Prevent context menu for polygon complete below
    if (isDrawing && activeTool === 'polygon' && currentPath.length >= 3) {
      // Complete polygon on right-click
      createAnnotation('polygon', currentPath);
      setIsDrawing(false);
      setCurrentPath([]);
    }
  }, [isDrawing, activeTool, currentPath, createAnnotation]);

  // Reset zoom and pan to default view (fit image to container and center)
  const resetZoomAndPan = useCallback(() => {
    if (!imageRef.current || !canvasRef.current || !containerRef.current) return;

    const img = imageRef.current;
    const container = containerRef.current;
    const containerRect = container.getBoundingClientRect();

    // Calculate scale to fit image in container
    const scaleX = containerRect.width / img.naturalWidth;
    const scaleY = containerRect.height / img.naturalHeight;
    const fitToContainerScale = Math.min(scaleX, scaleY);

    // Reset to fit-to-container scale
    setImageScale(fitToContainerScale);
    
    // Center image in container
    const scaledWidth = img.naturalWidth * fitToContainerScale;
    const scaledHeight = img.naturalHeight * fitToContainerScale;
    
    setImageOffset({
      x: (containerRect.width - scaledWidth) / 2,
      y: (containerRect.height - scaledHeight) / 2
    });

    // Update refs for smooth zoom
    scaleRef.current = fitToContainerScale;
    offsetRef.current = {
      x: (containerRect.width - scaledWidth) / 2,
      y: (containerRect.height - scaledHeight) / 2
    };

    toast({
      title: 'View reset',
      description: 'Zoom and pan reset to default view',
    });
  }, [toast]);

  /** Polygon and AI Segment need at least one class so annotations have a label */
  const ensureClassForDrawingTools = useCallback((): boolean => {
    if (classes.length === 0) {
      // Use Sonner (not Radix useToast): same z-index as App Toaster, stays above annotation canvas/overlays (z-100)
      sonnerToast.error('Add a class first', {
        description:
          'Create at least one class in the Classes section before using Polygon or AI Segment.',
        duration: 6000,
      });
      return false;
    }
    return true;
  }, [classes.length]);

  const enableBboxModeOnce = useCallback(() => {
    if (!bboxSwitchAllowed || modeLocked) return;
    const hasMaskAnnotations = annotations.some(
      (a) => a.type === 'polygon' && a.points && a.points.length >= 3,
    );
    if (hasMaskAnnotations) {
      toast({
        title: 'Cannot switch to bbox mode',
        description: 'Mask annotations already exist in this session/file.',
        variant: 'destructive',
      });
      return;
    }
    setAnnotationMode('bbox');
    setModeLocked(true);
    setBboxSwitchAllowed(false);
    setModeLockReason('BBox mode selected for this session. Mask tools are disabled.');
    setActiveTool('rectangle');
    setAutoSegmentPreview(null);
    setSamPoints([]);
    toast({
      title: 'Bounding box mode enabled',
      description: 'Mode is now locked. Only bbox annotations will be saved.',
    });
  }, [bboxSwitchAllowed, modeLocked, annotations, toast]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    const isInputFocused = target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);

    if (e.key === 'Escape' && isDrawing) {
      setIsDrawing(false);
      setCurrentPath([]);
      toast({
        title: 'Drawing cancelled',
        description: 'Polygon drawing has been cancelled',
      });
    } else if (e.key === 'Enter' && !isInputFocused) {
      if (autoSegmentPreview && autoSegmentPreview.polygons?.length > 0) {
        acceptAutoSegment();
      } else if (isDrawing && activeTool === 'polygon' && currentPath.length >= 3) {
        createAnnotation('polygon', currentPath);
        setIsDrawing(false);
        setCurrentPath([]);
      }
    } else if (!isInputFocused) {
      // Tool shortcuts
      if (e.key === 'v' || e.key === 'V') {
        setActiveTool('select');
      } else if (e.key === 'p' || e.key === 'P') {
        if (!isDrawing && ensureClassForDrawingTools()) {
          setActiveTool(annotationMode === 'bbox' ? 'rectangle' : 'polygon');
        }
      } else if (e.key === 'b' || e.key === 'B') {
        if (!isDrawing && ensureClassForDrawingTools()) {
          setActiveTool(annotationMode === 'bbox' ? 'rectangle' : 'pencil');
        }
      } else if (e.key === 'g' || e.key === 'G') {
        if (!isSamInteractionBlocked && ensureClassForDrawingTools()) setActiveTool('auto-segment');
      } else if ((e.key === 'r' || e.key === 'R') && !isDrawing) {
        resetZoomAndPan();
      }
    }
  }, [isDrawing, activeTool, currentPath, createAnnotation, toast, resetZoomAndPan, autoSegmentPreview, acceptAutoSegment, ensureClassForDrawingTools, isSamInteractionBlocked, annotationMode]);

  // Add keyboard event listener
  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleKeyDown]);

  const redrawCanvas = useCallback(() => {
    // Require canvas and an image to draw: either the displayImage (selected layer) or the currentImage (annotations source)
    if (!canvasRef.current || !imageRef.current || (!displayImage && !currentImage)) {
      return;
    }

    // CRITICAL: Check if image is actually loaded before attempting to draw
    // This prevents black screens when switching layers - the image element is remounted and starts loading,
    // We must wait for it to actually load before drawing
    if (!imageRef.current.complete || !imageRef.current.naturalWidth) {
      return; // Wait for image to load before drawing
    }

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Get canvas display size (the context is already scaled by dpr in handleImageResize)
    const displayWidth = canvas.clientWidth;
    const displayHeight = canvas.clientHeight;

    // Clear canvas (use display dimensions since context is scaled by dpr)
    ctx.clearRect(0, 0, displayWidth, displayHeight);

    // Save context
    ctx.save();

    // Read scale/offset from refs once for this frame (bitmap + annotations must match).
    // Declared here — not inside the drawImage if — so annotationToScreen can see them.
    const scaleNow = scaleRef.current || imageScale;
    const offsetNow = offsetRef.current || imageOffset;

    // Draw image with proper scaling and offset
    if (imageRef.current && imageRef.current.complete && imageRef.current.naturalWidth > 0) {
      // Apply display adjustments (brightness/contrast/saturation) only to
      // the bitmap, not to overlays drawn afterwards.
      const needsFilter =
        imageBrightness !== 100 || imageContrast !== 100 || imageSaturation !== 100;
      if (needsFilter) {
        ctx.filter = `brightness(${imageBrightness}%) contrast(${imageContrast}%) saturate(${imageSaturation}%)`;
      }
      ctx.drawImage(
        imageRef.current,
        offsetNow.x,
        offsetNow.y,
        imageRef.current.naturalWidth * scaleNow,
        imageRef.current.naturalHeight * scaleNow
      );
      if (needsFilter) {
        ctx.filter = 'none';
      }
    }

    // Annotation coordinate transform: map annotation-storage pixels to display
    // image pixels via uniform scale or COCO dimension remapping.
    const naturalW = imageRef.current?.naturalWidth ?? 0;
    const naturalH = imageRef.current?.naturalHeight ?? 0;

    // annot-storage pixel → display image pixel
    const annotToDisplayPx = (px: number, py: number): { x: number; y: number } => {
      if (annotationLayerId && naturalW > 0 && naturalH > 0) {
        const annotColl = imageCollections.find(c => String(c.id) === annotationLayerId);
        const annotImg = annotColl?.images.find(i => i.fileName === currentImage?.fileName);
        if (annotImg && annotImg.width > 0 && annotImg.height > 0) {
          return { x: px * naturalW / annotImg.width, y: py * naturalH / annotImg.height };
        }
      }
      // GET /image-annotations stores polygons in the displayed bitmap's pixel space. The
      // on-disk COCO file may list different width/height (or bbox-only rows); remapping
      // with those dims scales coordinates wrong and hides shapes on the canvas.
      if (annotationId) {
        return { x: px, y: py };
      }
      const refDims = getAnnotReferenceDimensions(currentImage?.fileName);
      if (refDims && naturalW > 0 && naturalH > 0 && refDims.width > 0 && refDims.height > 0 &&
          (refDims.width !== naturalW || refDims.height !== naturalH)) {
        return { x: px * naturalW / refDims.width, y: py * naturalH / refDims.height };
      }
      return { x: px, y: py };
    };

    // Use the same scale/offset that was used to draw the bitmap (refs, not
    // stale React state). This is critical on first load: handleImageResize
    // writes scaleRef/offsetRef synchronously then schedules a redraw via rAF.
    // If that rAF fires before React has committed the new imageScale state,
    // annotationToScreen via imageToScreenCoords (which closes over state) would
    // use scale=1 while the bitmap was drawn at 0.15, placing polygons off-canvas.
    const annotationToScreen = (px: number, py: number) => {
      const disp = annotToDisplayPx(px, py);
      return { x: disp.x * scaleNow + offsetNow.x, y: disp.y * scaleNow + offsetNow.y };
    };

    // Draw annotations
    let drawnVisibleAnnotations = 0;
    annotations.forEach((annotation, idx) => {
      if (!annotation.visible) {
        return;
      }
      // Solo: when a class is isolated, hide annotations from other classes
      if (soloClassId) {
        const soloClassName = classes.find(c => c.id === soloClassId)?.name;
        if (soloClassName && annotation.label !== soloClassName) return;
      }
      // Per-class visibility: hide annotations whose class is toggled off
      const annClass = classes.find(c => c.name === annotation.label);
      if (annClass && annClass.visible === false) return;

      // Always prefer the class palette color so the canvas stays in sync with
      // the left-side Classes panel, even before the reconciling effect runs
      // on the first paint after annotations load.
      const drawColor = resolveAnnotationDisplayColor(annotation, classes) ?? annotation.color;
      ctx.strokeStyle = drawColor;
      ctx.fillStyle = drawColor + '30'; // Semi-transparent fill
      ctx.lineWidth = 2;

      if (annotation.type === 'rectangle' && annotation.points.length >= 2) {
        const [bx, by, bw, bh] = pointsToBbox(annotation.points);
        const topLeft = annotationToScreen(bx, by);
        const bottomRight = annotationToScreen(bx + bw, by + bh);
        const drawW = bottomRight.x - topLeft.x;
        const drawH = bottomRight.y - topLeft.y;
        ctx.fillRect(topLeft.x, topLeft.y, drawW, drawH);
        ctx.strokeRect(topLeft.x, topLeft.y, drawW, drawH);
        drawnVisibleAnnotations += 1;

        ctx.fillStyle = drawColor;
        ctx.font = '12px Arial';
        const centerScreen = annotationToScreen(bx + bw / 2, by + bh / 2);
        ctx.fillText(annotation.label, centerScreen.x, centerScreen.y);
      } else if (annotation.type === 'polygon' && annotation.points.length > 2) {
        ctx.beginPath();

        const firstPoint = annotationToScreen(annotation.points[0].x, annotation.points[0].y);
        ctx.moveTo(firstPoint.x, firstPoint.y);

        for (let i = 1; i < annotation.points.length; i++) {
          const point = annotationToScreen(annotation.points[i].x, annotation.points[i].y);
          ctx.lineTo(point.x, point.y);
        }

        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        drawnVisibleAnnotations += 1;

        ctx.fillStyle = drawColor;
        ctx.font = '12px Arial';
        const centerX = annotation.points.reduce((sum, p) => sum + p.x, 0) / annotation.points.length;
        const centerY = annotation.points.reduce((sum, p) => sum + p.y, 0) / annotation.points.length;
        const centerScreen = annotationToScreen(centerX, centerY);
        ctx.fillText(annotation.label, centerScreen.x, centerScreen.y);
      }

      // Highlight selected annotation
      if (annotation.id === selectedAnnotation) {
        ctx.strokeStyle = '#FFD700';
        ctx.lineWidth = 3;
        
        if (annotation.type === 'rectangle' && annotation.points.length >= 2) {
          const [bx, by, bw, bh] = pointsToBbox(annotation.points);
          const topLeft = annotationToScreen(bx, by);
          const bottomRight = annotationToScreen(bx + bw, by + bh);
          ctx.strokeRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
        } else if (annotation.type === 'polygon') {
          ctx.beginPath();
          const firstPoint = annotationToScreen(annotation.points[0].x, annotation.points[0].y);
          ctx.moveTo(firstPoint.x, firstPoint.y);
          for (let i = 1; i < annotation.points.length; i++) {
            const point = annotationToScreen(annotation.points[i].x, annotation.points[i].y);
            ctx.lineTo(point.x, point.y);
          }
          ctx.closePath();
          ctx.stroke();
        }
      }
    });

    // Draw current path while drawing
    if (isDrawing && currentPath.length > 0) {
      const classObj = classes.find(c => c.id === selectedClass);
      const color = classObj?.color || '#FF0000';
      
      ctx.strokeStyle = color;
      ctx.fillStyle = color + '30';
      ctx.lineWidth = 2;

      if (activeTool === 'polygon' && currentPath.length > 0) {
        ctx.beginPath();
        
        const firstPoint = imageToScreenCoords(currentPath[0].x, currentPath[0].y);
        ctx.moveTo(firstPoint.x, firstPoint.y);
        
        for (let i = 1; i < currentPath.length; i++) {
          const point = imageToScreenCoords(currentPath[i].x, currentPath[i].y);
          ctx.lineTo(point.x, point.y);
        }
        
        if (currentPath.length > 2) {
          ctx.fill();
        }
        ctx.stroke();
        
        // Draw points
        currentPath.forEach((point) => {
          const screenPoint = imageToScreenCoords(point.x, point.y);
          ctx.beginPath();
          ctx.arc(screenPoint.x, screenPoint.y, 3, 0, 2 * Math.PI);
          ctx.fillStyle = color;
          ctx.fill();
          ctx.strokeStyle = '#FFFFFF';
          ctx.lineWidth = 1;
          ctx.stroke();
        });
      } else if (activeTool === 'pencil' && currentPath.length > 0) {
        // Render free-hand stroke as a continuous line (no per-point dots)
        // and softly fill the closed shape so the user can preview the
        // resulting polygon while drawing.
        ctx.beginPath();
        const firstPoint = imageToScreenCoords(currentPath[0].x, currentPath[0].y);
        ctx.moveTo(firstPoint.x, firstPoint.y);
        for (let i = 1; i < currentPath.length; i++) {
          const point = imageToScreenCoords(currentPath[i].x, currentPath[i].y);
          ctx.lineTo(point.x, point.y);
        }
        if (currentPath.length > 2) {
          ctx.closePath();
          ctx.fill();
        }
        ctx.stroke();
      } else if (activeTool === 'rectangle' && currentPath.length >= 2) {
        const [a, b] = currentPath;
        const [x, y, w, h] = pointsToBbox([a, b]);
        const topLeft = imageToScreenCoords(x, y);
        const bottomRight = imageToScreenCoords(x + w, y + h);
        const drawW = bottomRight.x - topLeft.x;
        const drawH = bottomRight.y - topLeft.y;
        ctx.fillRect(topLeft.x, topLeft.y, drawW, drawH);
        ctx.strokeRect(topLeft.x, topLeft.y, drawW, drawH);
      }
    }

    // SAM points (positive = green, negative = red) when auto-segment tool is active
    if (activeTool === 'auto-segment' && samPoints.length > 0) {
      samPoints.forEach((p) => {
        const screenPoint = imageToScreenCoords(p.x, p.y);
        ctx.beginPath();
        ctx.arc(screenPoint.x, screenPoint.y, 6, 0, 2 * Math.PI);
        ctx.fillStyle = p.label === 1 ? 'rgba(0, 255, 100, 0.9)' : 'rgba(255, 80, 80, 0.9)';
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.stroke();
      });
    }

    // Restore context
    ctx.restore();
    lastDrawnVisibleAnnotationsRef.current = drawnVisibleAnnotations;
    lastDrawImageKeyRef.current = currentImage?.fileName || currentImageNameRef.current || '';
  }, [annotations, selectedAnnotation, isDrawing, currentPath, activeTool, selectedClass, classes, soloClassId, samPoints, imageScale, imageOffset, displayImage, currentImage, annotationLayerId, imageCollections, imageBrightness, imageContrast, imageSaturation, getAnnotReferenceDimensions, annotationId]);

  // Redraw canvas when dependencies change
  useEffect(() => {
    redrawCanvas();
  }, [annotations, selectedAnnotation, isDrawing, currentPath, samPoints, activeTool, imageScale, imageOffset, displayImage, currentImage, redrawCanvas]);

  // Redraw canvas for image scaling and offset changes
  useEffect(() => {
    redrawCanvas();
  }, [imageScale, imageOffset, redrawCanvas]);

  // Redraw canvas when drawing state changes (for real-time feedback)
  useEffect(() => {
    if (isDrawing && currentPath.length > 0) {
      redrawCanvas();
    }
  }, [currentPath, isDrawing, redrawCanvas]);

  const addClass = () => {
    if (!newClassName.trim()) return;

    const newClass: AnnotationClass = {
      id: `class_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      name: newClassName.trim(),
      color: DEFAULT_COLORS[classes.length % DEFAULT_COLORS.length],
      visible: true,
      count: 0
    };

    setClasses(prev => {
      const updated = [...prev, newClass];
      saveGlobalClasses(updated);
      return updated;
    });
    setNewClassName('');
    setIsAddingClass(false);
    setSelectedClass(newClass.id);

    toast({
      title: 'Class added',
      description: `Class "${newClass.name}" has been created`,
    });
  };

  const deleteClass = (classId: string) => {
    const classToDelete = classes.find(c => c.id === classId);
    if (!classToDelete) return;
    setPendingDeleteClassId(classId);
    setShowDeleteClassDialog(true);
  };

  const confirmDeleteClass = async () => {
    if (!id || !pendingDeleteClassId) return;

    const classToDelete = classes.find(c => c.id === pendingDeleteClassId);
    if (!classToDelete) {
      setPendingDeleteClassId(null);
      setShowDeleteClassDialog(false);
      return;
    }

    // Persist class deletion to DB (same endpoint as dataset Annotations table).
    if (api && annotationId) {
      try {
        const response = await api.deleteAnnotationClass(id, annotationId, classToDelete.name);
        if (!response.success) {
          throw new Error(response.error || 'Failed to delete class');
        }
      } catch (error) {
        console.error('Error deleting class on server:', error);
        toast({
          variant: 'destructive',
          title: 'Could not delete class',
          description:
            error instanceof Error
              ? error.message
              : 'Class was not removed from the database. Try again from the Annotations view.',
        });
        setPendingDeleteClassId(null);
        setShowDeleteClassDialog(false);
        return;
      }
    }

    const affectedImages = new Set<string>();
    let deletedAnnotationCount = 0;

    try {
      const annotationFileRef = sessionStorage.getItem(`annotation_file_${id}`);
      if (annotationFileRef) {
        const fileData = JSON.parse(annotationFileRef);
        const cocoData = fileData?.cocoData;
        if (cocoData?.annotations && cocoData?.categories) {
          const imageIdToFileName: { [key: string]: string } = {};
          cocoData.images?.forEach((img: any) => {
            if (img?.id != null && img?.file_name) {
              imageIdToFileName[String(img.id)] = img.file_name;
            }
          });

          const removedCategoryIds = new Set(
            cocoData.categories
              .filter((category: any) => category?.name === classToDelete.name)
              .map((category: any) => String(category.id))
          );

          if (removedCategoryIds.size > 0) {
            cocoData.annotations = cocoData.annotations.filter((annotation: any) => {
              const shouldRemove = annotation?.category_id != null && removedCategoryIds.has(String(annotation.category_id));
              if (shouldRemove) {
                deletedAnnotationCount += 1;
                const imageName = imageIdToFileName[String(annotation.image_id)];
                if (imageName) affectedImages.add(imageName);
              }
              return !shouldRemove;
            });
            cocoData.categories = cocoData.categories.filter((category: any) => category?.name !== classToDelete.name);
            fileData.cocoData = cocoData;
            sessionStorage.setItem(`annotation_file_${id}`, JSON.stringify(fileData));
          }
        }
      }
    } catch (error) {
      console.warn('Could not update annotation session data during class deletion:', error);
    }

    const keyPrefix = `annotations_${id}_`;
    const keysToUpdate: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key || !key.startsWith(keyPrefix) || key.endsWith('_dims')) continue;
      keysToUpdate.push(key);
    }

    keysToUpdate.forEach((key) => {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw) as AnnotationShape[];
        if (!Array.isArray(parsed)) return;
        const filtered = parsed.filter((annotation) => annotation.label !== classToDelete.name);
        const removedCount = parsed.length - filtered.length;
        if (removedCount <= 0) return;

        deletedAnnotationCount += removedCount;
        localStorage.setItem(key, JSON.stringify(filtered));
      } catch (error) {
        console.warn('Could not update cached annotations during class deletion:', { key, error });
      }
    });

    setAnnotations((prev) => {
      const removedSelectedAnnotation = prev.some(
        (annotation) => annotation.id === selectedAnnotation && annotation.label === classToDelete.name,
      );
      const updated = prev.filter((annotation) => annotation.label !== classToDelete.name);
      if (removedSelectedAnnotation) {
        setSelectedAnnotation(null);
      }
      return updated;
    });

    setClasses((prev) => {
      const updated = prev.filter((annotationClass) => annotationClass.id !== pendingDeleteClassId);
      saveGlobalClasses(updated);
      return updated;
    });

    if (selectedClass === pendingDeleteClassId) {
      setSelectedClass(null);
    }
    if (soloClassId === pendingDeleteClassId) {
      setSoloClassId(null);
    }
    if (classFilterName === classToDelete.name) {
      setClassFilterName(null);
    }

    setGlobalStats((prev) => {
      const updated = { ...prev };
      delete updated[classToDelete.name];
      return updated;
    });
    setGlobalAvgAreas((prev) => {
      const updated = { ...prev };
      delete updated[classToDelete.name];
      return updated;
    });
    setClassImageMap((prev) => {
      const updated = { ...prev };
      delete updated[classToDelete.name];
      return updated;
    });
    setHasUnsavedChanges(true);
    setPendingDeleteClassId(null);
    setShowDeleteClassDialog(false);

    if (api && annotationId) {
      await computeGlobalStats();
    }

    const imageCount = affectedImages.size || classImageMap[classToDelete.name]?.size || 0;
    toast({
      title: 'Class deleted',
      description:
        deletedAnnotationCount > 0
          ? `Removed class "${classToDelete.name}" and ${deletedAnnotationCount} annotation(s) across ${imageCount} image(s).`
          : `Class "${classToDelete.name}" has been removed.`,
    });
  };

  const startEditingClass = (classId: string, currentName: string) => {
    setEditingClassId(classId);
    setEditingClassName(currentName);
  };

  const saveEditingClass = async () => {
    if (!editingClassId || !editingClassName.trim()) {
      setEditingClassId(null);
      setEditingClassName('');
      return;
    }

    const oldClass = classes.find(c => c.id === editingClassId);
    if (!oldClass) return;

    const oldName = oldClass.name;
    const newName = editingClassName.trim();

    if (oldName === newName) {
      setEditingClassId(null);
      setEditingClassName('');
      return;
    }

    // Check if new name already exists
    if (classes.some(c => c.name === newName && c.id !== editingClassId)) {
      toast({
        variant: 'destructive',
        title: 'Name already exists',
        description: `A class named "${newName}" already exists`,
      });
      return;
    }

    // Persist rename to backend so Annotations view shows correct counts
    if (api && annotationId) {
      try {
        const res = await api.renameAnnotationClass(id, annotationId, oldName, newName);
        if (!res.success) throw new Error(res.error || 'Failed to rename class');
      } catch (e) {
        console.error('Rename class on server:', e);
        toast({
          variant: 'destructive',
          title: 'Could not rename on server',
          description: e instanceof Error ? e.message : 'Statistics in Annotations view may be stale until you save.',
        });
        return;
      }
    }

    // Update class name locally
    setClasses(prev => {
      const updated = prev.map(c => 
        c.id === editingClassId ? { ...c, name: newName } : c
      );
      saveGlobalClasses(updated);
      return updated;
    });

    // Update all annotations with the old class name
    setAnnotations(prev => {
      const updated = prev.map(a => 
        a.label === oldName ? { ...a, label: newName } : a
      );
      if (currentImageName) {
        const saveDims = imageRef.current?.naturalWidth && imageRef.current?.naturalHeight
          ? { width: imageRef.current.naturalWidth, height: imageRef.current.naturalHeight }
          : undefined;
        saveAnnotationsToLocalStorage(currentImageName, updated, saveDims);
      }
      return updated;
    });

    setEditingClassId(null);
    setEditingClassName('');
    setHasUnsavedChanges(true);

    toast({
      title: 'Class renamed',
      description: `"${oldName}" has been renamed to "${newName}"`,
    });
    computeGlobalStatsDebounced();
  };

  const cancelEditingClass = () => {
    setEditingClassId(null);
    setEditingClassName('');
  };

  const deleteAnnotation = (annotationId: string) => {
    const annotation = annotations.find(a => a.id === annotationId);
    if (!annotation || !currentImageName) return;

    setAnnotations(prev => {
      const updated = prev.filter(a => a.id !== annotationId);
      const saveDims = imageRef.current?.naturalWidth && imageRef.current?.naturalHeight
        ? { width: imageRef.current.naturalWidth, height: imageRef.current.naturalHeight }
        : undefined;
      saveAnnotationsToLocalStorage(currentImageName, updated, saveDims);
      return updated;
    });
    
    // Mark as unsaved
    setHasUnsavedChanges(true);
    
    // Update class count and save globally
    const classObj = classes.find(c => c.name === annotation.label);
    if (classObj) {
      setClasses(prev => {
        const updated = prev.map(c => 
          c.id === classObj.id 
            ? { ...c, count: Math.max(0, c.count - 1) }
            : c
        );
        saveGlobalClasses(updated);
        return updated;
      });
    }
    computeGlobalStatsDebounced();

    if (selectedAnnotation === annotationId) {
      setSelectedAnnotation(null);
    }

    toast({
      title: 'Annotation deleted',
      description: `Deleted ${annotation.type} annotation`,
    });
  };

  const requestDeleteAnnotation = useCallback((annotationId: string) => {
    if (!annotationId) return;
    if (skipDeleteAnnotationConfirm) {
      deleteAnnotation(annotationId);
      return;
    }
    setPendingDeleteAnnotationId(annotationId);
    setShowDeleteAnnotationDialog(true);
  }, [skipDeleteAnnotationConfirm, annotations, currentImageName, classes, selectedAnnotation]);

  const confirmDeleteAnnotation = useCallback(() => {
    if (pendingDeleteAnnotationId) {
      deleteAnnotation(pendingDeleteAnnotationId);
    }
    setPendingDeleteAnnotationId(null);
    setShowDeleteAnnotationDialog(false);
  }, [pendingDeleteAnnotationId, annotations, currentImageName, classes, selectedAnnotation]);

  // Keyboard shortcut for deleting selected annotation
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Only handle Delete key if we have a selected annotation and not editing text
      if (event.key === 'Delete' && selectedAnnotation && 
          !(event.target as HTMLElement)?.tagName.match(/INPUT|TEXTAREA|SELECT/)) {
        event.preventDefault();
        requestDeleteAnnotation(selectedAnnotation);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [selectedAnnotation, requestDeleteAnnotation]);

  // Track if we should preserve zoom on resize vs reset to fit-to-screen
  const preserveZoomRef = useRef(false);
  
  const handleImageLoad = () => {
    // Reset preserve flag for new image loads
    preserveZoomRef.current = false;

    // Immediate fit avoids one or more paints at imageScale===1 (full natural size),
    // which reads as “zoomed in” relative to fit-to-view.
    handleImageResize(true);

    // Double-rAF: the first frame lets React flush its DOM mutations and starts the
    // browser layout pass; the second frame fires after that layout pass completes.
    // This is critical on initial page load where ResizablePanelGroup (flex/grid)
    // hasn't finished computing its container dimensions by the first rAF.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        handleImageResize(true);
      });
    });

    // Safety-net: if the container was still at zero/unstable size during the double-rAF
    // (e.g. browser was busy with other layout work), re-run the fit after a short delay.
    const srcAtLoad = imageRef.current?.src;
    setTimeout(() => {
      if (imageRef.current?.src !== srcAtLoad) return; // image changed, skip
      const container = containerRef.current;
      if (!container) return;
      const { width, height } = container.getBoundingClientRect();
      if (width > 0 && height > 0 && !preserveZoomRef.current) {
        handleImageResize(true);
      }
    }, 150);
  };

  // Schedule a redraw, retrying for a few frames in case the image bitmap
  // isn't ready yet (e.g. mid-resize, after a layer swap, or right after a
  // panel resize where layout is still settling). This prevents the canvas
  // from staying blank when the inline redraw call hits the early-return
  // guards inside redrawCanvas (image not complete / no naturalWidth yet).
  const scheduleRedraw = useCallback((attemptsLeft = 6) => {
    requestAnimationFrame(() => {
      const img = imageRef.current;
      const ready = !!(img && img.complete && img.naturalWidth > 0);
      if (ready) {
        redrawCanvas();
        // One more pass next frame to cover any state that just settled.
        requestAnimationFrame(() => redrawCanvas());
        return;
      }
      if (attemptsLeft > 0) scheduleRedraw(attemptsLeft - 1);
    });
  }, [redrawCanvas]);

  const expectedVisibleAnnotationsCount = useMemo(() => {
    let count = 0;
    for (const annotation of annotations) {
      if (!annotation.visible) continue;
      if (annotation.type !== 'polygon' || annotation.points.length <= 2) continue;
      if (soloClassId) {
        const soloClassName = classes.find(c => c.id === soloClassId)?.name;
        if (soloClassName && annotation.label !== soloClassName) continue;
      }
      const annClass = classes.find(c => c.name === annotation.label);
      if (annClass && annClass.visible === false) continue;
      count += 1;
    }
    return count;
  }, [annotations, classes, soloClassId]);

  // Watchdog: if annotations should be visible but last draw pass painted none,
  // force extra redraw retries. This removes the "appears only after click" race
  // that can still happen on large datasets when image/layout settles late.
  useEffect(() => {
    if (expectedVisibleAnnotationsCount <= 0) return;
    if (!canvasRef.current || !imageRef.current) return;
    const img = imageRef.current;
    const imageKey = currentImage?.fileName || currentImageNameRef.current || '';
    const shouldSchedule = shouldScheduleAnnotationRedraw({
      expectedVisibleAnnotationsCount,
      isLayerSwitching,
      imageReady: !!(img.complete && img.naturalWidth),
      currentImageKey: imageKey,
      lastDrawImageKey: lastDrawImageKeyRef.current,
      lastDrawnVisibleAnnotations: lastDrawnVisibleAnnotationsRef.current,
    });

    if (!shouldSchedule) {
      return;
    }

    if (!img.complete || !img.naturalWidth) {
      scheduleRedraw(10);
      return;
    }

    scheduleRedraw(10);
    const t1 = window.setTimeout(() => scheduleRedraw(10), 80);
    const t2 = window.setTimeout(() => scheduleRedraw(10), 220);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [
    expectedVisibleAnnotationsCount,
    currentImage?.fileName,
    isLayerSwitching,
    imageScale,
    imageOffset,
    scheduleRedraw,
  ]);

  // When annotation loading finishes, force a few redraw attempts.
  // The loading spinner only reflects data fetch; canvas/image readiness may
  // settle slightly later. Without this, polygons can stay invisible until some
  // unrelated interaction (draw/toggle class) triggers redraw.
  useEffect(() => {
    if (!currentImageName) return;
    if (annotationsLoadingForImage !== null) return;
    if (annotations.length <= 0) return;

    scheduleRedraw(12);
    const t1 = window.setTimeout(() => scheduleRedraw(12), 90);
    const t2 = window.setTimeout(() => scheduleRedraw(12), 260);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [
    annotationsLoadingForImage,
    annotations.length,
    currentImageName,
    displayLayer,
    annotationLayerId,
    scheduleRedraw,
  ]);

  // Annotation-layer scale refs are stored in useRef and may update after the
  // first paint for an image/layer. Trigger redraws when these related states
  // settle so transformed polygons are drawn without requiring user interaction.
  useEffect(() => {
    if (!currentImageName) return;
    if (!annotations.length) return;

    scheduleRedraw(12);
    const t = window.setTimeout(() => scheduleRedraw(12), 120);
    return () => window.clearTimeout(t);
  }, [
    annotationLayerId,
    displayLayer,
    currentImageName,
    annotations.length,
    scheduleRedraw,
  ]);

  const handleImageResize = (forceRefit = false) => {
    if (!imageRef.current || !canvasRef.current || !containerRef.current) return;

    const img = imageRef.current;
    const canvas = canvasRef.current;
    const container = containerRef.current;

    // Set canvas size to match container
    const containerRect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    // Guard against zero-sized container during transient resize states.
    // Drawing into a 0×0 canvas would just clear the visible bitmap and leave it blank.
    if (containerRect.width <= 0 || containerRect.height <= 0) {
      scheduleRedraw();
      return;
    }
    
    // Set canvas internal size with device pixel ratio
    canvas.width = containerRect.width * dpr;
    canvas.height = containerRect.height * dpr;
    
    // Set canvas display size
    canvas.style.width = `${containerRect.width}px`;
    canvas.style.height = `${containerRect.height}px`;
    
    // Scale canvas context to match device pixel ratio
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.scale(dpr, dpr);
    }

    // Calculate scale to fit image in container
    const scaleX = containerRect.width / img.naturalWidth;
    const scaleY = containerRect.height / img.naturalHeight;
    const fitToContainerScale = Math.min(scaleX, scaleY);

    // Only reset zoom if this is initial load, we're explicitly not preserving zoom, AND we're not preventing reset due to panning
    if (forceRefit || (!preserveZoomRef.current && !preventZoomResetRef.current)) {
      const scaledWidth = img.naturalWidth * fitToContainerScale;
      const scaledHeight = img.naturalHeight * fitToContainerScale;
      const newOffset = {
        x: (containerRect.width - scaledWidth) / 2,
        y: (containerRect.height - scaledHeight) / 2,
      };
      // Sync refs immediately so the imminent scheduleRedraw() (and any draw
      // pulled in via stale closure / pre-commit rAF) uses the fit values, not
      // the initial imageScale === 1 that would render the bitmap at native
      // resolution and look "zoomed in" on the first paint.
      scaleRef.current = fitToContainerScale;
      offsetRef.current = newOffset;
      setImageScale(fitToContainerScale);
      setImageOffset(newOffset);
      // The scale/offset state changes will trigger the redraw useEffect, but
      // we also schedule retried redraws as a safety net (image may not be
      // 'complete' on the first frame after a layer switch).
      requestAnimationFrame(() => {
        setIsLayerSwitching(false);
      });
      scheduleRedraw();
    } else {
      // Preserve zoom: state isn't changing, so the redraw useEffect won't fire.
      // We must trigger the redraw ourselves — and retry until the image is
      // actually ready, otherwise the just-resized (and therefore cleared)
      // canvas will stay blank until the user navigates Next/Back.
      requestAnimationFrame(() => {
        setIsLayerSwitching(false);
      });
      scheduleRedraw();
    }
  };

    // Recompute canvas when a side panel is toggled. We want the image to
    // grow into freed space (or shrink to fit when a panel reopens), so we
    // explicitly refit instead of preserving the current zoom.
    useEffect(() => {
      if (imageRef.current && imageRef.current.complete && imageRef.current.naturalWidth > 0) {
        preserveZoomRef.current = false;
        const t = setTimeout(() => {
          handleImageResize(true);
        }, 50);
        return () => clearTimeout(t);
      }
      return undefined;
      }, [leftCollapsed, rightCollapsed]);

    // Listen for explicit resize-end notifications from resize handlers and toggles
    useEffect(() => {
      const onResizeEnd = () => {
        // small timeout to allow DOM to settle
        setTimeout(() => {
          // Preserve zoom during panel resizes - don't reset zoom just because panels changed
          preserveZoomRef.current = true;
          handleImageResize();
        }, 10);
      };
      window.addEventListener('annotation-panel-resize-end', onResizeEnd as EventListener);
      return () => window.removeEventListener('annotation-panel-resize-end', onResizeEnd as EventListener);
    }, []);

  const saveAnnotations = async () => {
    if (!currentImage || annotations.length === 0) return;

    try {
      const naturalW = imageRef.current?.naturalWidth || 1920;
      const naturalH = imageRef.current?.naturalHeight || 1080;
      const refDims = getAnnotReferenceDimensions(currentImage.fileName);
      const toNatural = annotationId
        ? (p: Point) => p
        : refDims && (refDims.width !== naturalW || refDims.height !== naturalH) && refDims.width > 0 && refDims.height > 0
          ? (p: Point) => ({ x: p.x * (naturalW / refDims.width), y: p.y * (naturalH / refDims.height) })
          : (p: Point) => p;

      // Create COCO format export (always in natural image pixel coordinates)
      const cocoData = {
        info: {
          description: `Annotations for ${currentImage.fileName}`,
          version: "1.0",
          year: new Date().getFullYear(),
          contributor: "AI Data Creator",
          date_created: new Date().toISOString()
        },
        images: [{
          id: 1,
          file_name: currentImage.fileName,
          width: naturalW,
          height: naturalH
        }],
        categories: classes.map((cls, index) => ({
          id: index + 1,
          name: cls.name,
          supercategory: "object"
        })),
        annotations: annotations.map((ann, index) => {
          const categoryId = classes.findIndex(c => c.name === ann.label) + 1;
          
          if (ann.type === 'polygon' || ann.type === 'rectangle') {
            const pointsNatural = ann.points.map(toNatural);
            const [minX, minY, width, height] = pointsToBbox(pointsNatural);
            const segmentation =
              ann.type === 'polygon' ? [pointsNatural.flatMap((p) => [p.x, p.y])] : [];
            const area = ann.type === 'polygon' ? calculatePolygonArea(pointsNatural) : width * height;
            return {
              id: index + 1,
              image_id: 1,
              category_id: categoryId,
              segmentation,
              area,
              bbox: [minX, minY, width, height],
              iscrowd: 0
            };
          }
          return null;
        }).filter(Boolean)
      };

      // Save to localStorage using image name (and reference dimensions so edit uses correct scale when image size differs)
      const collId = displayLayer || mainLayer || 'default';
      const storageKey = `annotations_${id}_${collId}_${currentImageName}`;
      safeLocalStorageSet(storageKey, JSON.stringify(annotations));
      const dimsKey = `annotations_${id}_${collId}_${currentImageName}_dims`;
      safeLocalStorageSet(dimsKey, JSON.stringify({ width: naturalW, height: naturalH }));
      
      // Export as downloadable file
      const dataStr = JSON.stringify(cocoData, null, 2);
      const dataUri = 'data:application/json;charset=utf-8,'+ encodeURIComponent(dataStr);
      
      const exportFileDefaultName = `annotations_${currentImageName.split('.')[0]}.json`;
      
      const linkElement = document.createElement('a');
      linkElement.setAttribute('href', dataUri);
      linkElement.setAttribute('download', exportFileDefaultName);
      linkElement.click();

      toast({
        title: 'Annotations saved',
        description: `Saved ${annotations.length} annotations and exported COCO file`,
      });
    } catch (error) {
      console.error('Error saving annotations:', error);
      toast({
        title: 'Save failed',
        description: 'Failed to save annotations',
        variant: 'destructive'
      });
    }
  };

  // Update an annotation's class by selecting an existing class id
  const saveAnnotationLabel = (annotationId: string, targetClassId: string | null) => {
    if (!annotationId || !currentImageName || !targetClassId) return;
    const ann = annotations.find(a => a.id === annotationId);
    if (!ann) return;

    console.log('[saveAnnotationLabel] Before update:', { annotationId, oldLabel: ann.label, oldVisible: ann.visible, targetClassId });

    const oldLabel = ann.label;
    const targetClass = classes.find(c => c.id === targetClassId);
    if (!targetClass) return; // no changes if class not found

    // Update annotation label
    setAnnotations(prev => {
      const updated = prev.map(a => a.id === annotationId ? { ...a, label: targetClass!.name, color: targetClass!.color } : a);
      
      // Log the updated annotation to verify visible property is preserved
      const updatedAnn = updated.find(a => a.id === annotationId);
      console.log('[saveAnnotationLabel] After update:', { 
        annotationId, 
        newLabel: updatedAnn?.label, 
        newVisible: updatedAnn?.visible, 
        hasPoints: !!updatedAnn?.points?.length 
      });
      
      // persist (and keep reference dimensions in sync)
      const saveDims = imageRef.current?.naturalWidth && imageRef.current?.naturalHeight
        ? { width: imageRef.current.naturalWidth, height: imageRef.current.naturalHeight }
        : undefined;
      saveAnnotationsToLocalStorage(currentImageName!, updated, saveDims);
      return updated;
    });

    // Mark as unsaved
    setHasUnsavedChanges(true);

    // Adjust class counts: decrement old, increment new
    setClasses(prev => {
      const updated = prev.map(c => {
        if (c.name === oldLabel) return { ...c, count: Math.max(0, c.count - 1) };
        if (c.id === targetClass.id) return { ...c, count: c.count + 1 };
        return c;
      });
      saveGlobalClasses(updated);
      return updated;
    });
    computeGlobalStatsDebounced();
  };

  const buildCocoExportInfo = (): CocoData['info'] => ({
    description: `${projectName ? `Project: ${projectName} | ` : ''}Dataset: ${datasetName || id}${annotationName ? ` | Annotation: ${annotationName}` : ''}`,
    version: '1.0',
    year: new Date().getFullYear(),
    contributor: 'LAI',
    date_created: new Date().toISOString(),
  });

  const resolveExportDimensions = (imageName: string, collId: string): { width: number; height: number } => {
    const dimsKey = `annotations_${id}_${collId}_${imageName}_dims`;
    const savedDims = localStorage.getItem(dimsKey);
    if (savedDims) {
      try {
        const dims = JSON.parse(savedDims) as { width: number; height: number };
        if (dims.width > 0 && dims.height > 0) return dims;
      } catch { /* ignore */ }
    }
    const cocoDims = cocoImageDimensionsRef.current[imageName];
    if (cocoDims && cocoDims.width > 0 && cocoDims.height > 0) return cocoDims;
    if (imageName === currentImageName) {
      const refDims = getAnnotReferenceDimensions(imageName);
      if (refDims && refDims.width > 0 && refDims.height > 0) return refDims;
    }
    return { width: 0, height: 0 };
  };

  const hasLocalExportOverride = (imageName: string, collId: string): boolean => {
    if (imageName === currentImageName) return true;
    return localStorage.getItem(`annotations_${id}_${collId}_${imageName}`) !== null;
  };

  const getExportShapesForImage = (imageName: string, collId: string): AnnotationShape[] | null => {
    if (imageName === currentImageName) return annotations;
    const storageKey = `annotations_${id}_${collId}_${imageName}`;
    const saved = localStorage.getItem(storageKey);
    if (saved === null) return null;
    try {
      return JSON.parse(saved) as AnnotationShape[];
    } catch {
      return [];
    }
  };

  const shapesToCocoAnnEntries = (
    shapes: AnnotationShape[],
    imageId: number,
    startAnnId: number,
  ): { entries: CocoData['annotations']; nextAnnId: number } => {
    let annId = startAnnId;
    const entries: CocoData['annotations'] = [];
    for (const ann of shapes) {
      if (ann.type !== 'polygon' && ann.type !== 'rectangle') continue;
      const [minX, minY, width, height] = pointsToBbox(ann.points);
      const categoryId = (classes.findIndex(c => c.name === ann.label) + 1) || 1;
      const segmentation = ann.type === 'polygon' ? [ann.points.flatMap((p) => [p.x, p.y])] : [];
      const area = ann.type === 'polygon' ? calculatePolygonArea(ann.points) : width * height;
      entries.push({
        id: annId++,
        image_id: imageId,
        category_id: categoryId,
        segmentation,
        area,
        bbox: [minX, minY, width, height],
        iscrowd: 0,
      });
    }
    return { entries, nextAnnId: annId };
  };

  const apiAnnotationsToShapes = (
    apiAnns: Array<{
      id: number;
      className: string;
      color: string;
      segmentation: number[];
      bbox: number[] | null;
    }>,
    imageWidth: number,
    imageHeight: number,
  ): AnnotationShape[] => {
    const shapes: AnnotationShape[] = [];
    for (const ann of apiAnns) {
      const seg = ann.segmentation;
      const points: Point[] = [];
      if (seg && seg.length >= 6) {
        for (let i = 0; i < seg.length; i += 2) {
          const x = seg[i];
          const y = seg[i + 1];
          if (isNaN(x) || isNaN(y) || !isFinite(x) || !isFinite(y)) continue;
          points.push({
            x: Math.max(0, Math.min(x, imageWidth - 1)),
            y: Math.max(0, Math.min(y, imageHeight - 1)),
          });
        }
      } else if (Array.isArray(ann.bbox) && ann.bbox.length >= 4) {
        bboxToRectPointsInPixelSpace(ann.bbox, imageWidth, imageHeight).forEach((p) => {
          points.push({
            x: Math.max(0, Math.min(p.x, imageWidth - 1)),
            y: Math.max(0, Math.min(p.y, imageHeight - 1)),
          });
        });
      }
      if (points.length < 3) continue;
      shapes.push({
        id: `annotation_${ann.id}`,
        type: seg && seg.length >= 6 ? 'polygon' : 'rectangle',
        points,
        label: ann.className,
        color: ann.color || DEFAULT_COLORS[0],
        visible: true,
      });
    }
    return applyClassColorsToAnnotations(shapes, classes);
  };

  const buildCocoFromLocalStorageOnly = (collId: string): CocoData => {
    const imagesArr: CocoData['images'] = [];
    const annotationsArr: CocoData['annotations'] = [];
    const categoryMap = classes.map((cls, idx) => ({ id: idx + 1, name: cls.name }));
    let annId = 1;
    let imageId = 1;

    for (const imageName of allImageNames) {
      const shapes = getExportShapesForImage(imageName, collId);
      if (shapes === null) continue;

      const dims = resolveExportDimensions(imageName, collId);
      if (dims.width <= 0 || dims.height <= 0) {
        if (shapes.length === 0) continue;
      }

      imagesArr.push({
        id: imageId,
        file_name: imageName,
        width: dims.width,
        height: dims.height,
      });

      const { entries, nextAnnId } = shapesToCocoAnnEntries(shapes, imageId, annId);
      annotationsArr.push(...entries);
      annId = nextAnnId;
      imageId++;
    }

    return {
      info: buildCocoExportInfo(),
      images: imagesArr,
      categories: categoryMap,
      annotations: annotationsArr,
    };
  };

  const mergeLocalOverridesIntoCoco = (baseCoco: CocoData, collId: string): CocoData => {
    const images = [...baseCoco.images];
    const fileToImageId = new Map(images.map((img) => [img.file_name, img.id]));
    let nextImageId = Math.max(0, ...images.map((i) => i.id)) + 1;
    let nextAnnId = Math.max(0, ...baseCoco.annotations.map((a) => a.id)) + 1;

    const overriddenNames = allImageNames.filter((name) => hasLocalExportOverride(name, collId));
    let mergedAnnotations = baseCoco.annotations.filter((ann) => {
      const img = images.find((i) => i.id === ann.image_id);
      return !img || !overriddenNames.includes(img.file_name);
    });

    for (const imageName of overriddenNames) {
      const shapes = getExportShapesForImage(imageName, collId) ?? [];
      const dims = resolveExportDimensions(imageName, collId);
      let imgId = fileToImageId.get(imageName);

      if (!imgId) {
        if (dims.width <= 0 || dims.height <= 0) continue;
        imgId = nextImageId++;
        images.push({ id: imgId, file_name: imageName, width: dims.width, height: dims.height });
        fileToImageId.set(imageName, imgId);
      } else if (dims.width > 0 && dims.height > 0) {
        const idx = images.findIndex((i) => i.id === imgId);
        if (idx >= 0) {
          images[idx] = { ...images[idx], width: dims.width, height: dims.height };
        }
      }

      const { entries, nextAnnId: updatedAnnId } = shapesToCocoAnnEntries(shapes, imgId, nextAnnId);
      nextAnnId = updatedAnnId;
      mergedAnnotations = mergedAnnotations.concat(entries);
    }

    return {
      ...baseCoco,
      info: baseCoco.info ?? buildCocoExportInfo(),
      images,
      annotations: mergedAnnotations,
      categories: classes.length > 0
        ? classes.map((cls, idx) => ({ id: idx + 1, name: cls.name }))
        : baseCoco.categories,
    };
  };

  const buildCocoFromAllImagesViaApi = async (collId: string): Promise<CocoData> => {
    const imagesArr: CocoData['images'] = [];
    const annotationsArr: CocoData['annotations'] = [];
    const categoryMap = classes.map((cls, idx) => ({ id: idx + 1, name: cls.name }));
    let annId = 1;
    let imageId = 1;

    for (const imageName of allImageNames) {
      let shapes: AnnotationShape[] | null = null;
      let dims = resolveExportDimensions(imageName, collId);

      if (hasLocalExportOverride(imageName, collId)) {
        shapes = getExportShapesForImage(imageName, collId) ?? [];
      } else if (api && annotationId && id) {
        try {
          const resp = await api.getImageAnnotations(id, annotationId, imageName, collId);
          if (resp.success && resp.data) {
            dims = { width: resp.data.imageWidth, height: resp.data.imageHeight };
            cocoImageDimensionsRef.current[imageName] = dims;
            shapes = apiAnnotationsToShapes(resp.data.annotations, dims.width, dims.height);
          }
        } catch (err) {
          console.warn(`Export: failed to load annotations for ${imageName}`, err);
        }
      }

      if (shapes === null) continue;
      if ((dims.width <= 0 || dims.height <= 0) && shapes.length === 0) continue;

      imagesArr.push({
        id: imageId,
        file_name: imageName,
        width: dims.width,
        height: dims.height,
      });

      if (shapes.length > 0) {
        const { entries, nextAnnId } = shapesToCocoAnnEntries(shapes, imageId, annId);
        annotationsArr.push(...entries);
        annId = nextAnnId;
      }
      imageId++;
    }

    return {
      info: buildCocoExportInfo(),
      images: imagesArr,
      categories: categoryMap,
      annotations: annotationsArr,
    };
  };

  // Download annotations as COCO JSON file (all images, not just the current one)
  const downloadAnnotationsJSON = async () => {
    try {
      const collId = annotationStorageCollId;

      if (id && currentImageName) {
        const dims = resolveExportDimensions(currentImageName, collId);
        if (dims.width > 0 && dims.height > 0) {
          saveAnnotationsToLocalStorage(currentImageName, annotations, dims);
        } else {
          saveAnnotationsToLocalStorage(currentImageName, annotations);
        }
      }

      toast({
        title: 'Preparing export...',
        description: 'Collecting annotations from all images.',
      });

      let coco: CocoData;

      if (annotationId && api && id) {
        let baseCoco: CocoData | null = null;
        try {
          const response = await api.getAnnotationContent(id, annotationId);
          if (
            response.success
            && response.data?.content
            && !response.data.is_large
            && !response.data.is_processing
          ) {
            baseCoco = JSON.parse(response.data.content) as CocoData;
          }
        } catch (err) {
          console.warn('Full annotation export from backend failed, falling back to per-image fetch', err);
        }

        coco = baseCoco
          ? mergeLocalOverridesIntoCoco(baseCoco, collId)
          : await buildCocoFromAllImagesViaApi(collId);
      } else {
        coco = buildCocoFromLocalStorageOnly(collId);
      }

      downloadCocoFile(coco, `annotations_all_${id}`);

      toast({
        title: 'Downloaded',
        description: `Downloaded ${coco.annotations.length} annotations from ${coco.images.length} images as JSON file`,
      });
    } catch (err) {
      console.error('Error downloading annotations', err);
      toast({ title: 'Download failed', description: 'Failed to download annotations', variant: 'destructive' });
    }
  };

  // Save new annotation file with name prompt
  const saveNewAnnotationFile = async (name: string) => {
    if (!id || !api) {
      toast({ 
        title: 'Cannot save', 
        description: 'Dataset ID or API not available',
        variant: 'destructive'
      });
      return false;
    }

    if (!name.trim()) {
      toast({ 
        title: 'Invalid name', 
        description: 'Please provide a name for the annotation file',
        variant: 'destructive'
      });
      return false;
    }

    try {
      setIsSavingAnnotation(true);

      // Build minimal annotation data (no full COCO building)
      const imagesArr: any[] = [];
      const annotationsArr: any[] = [];
      const categoryMap = classes.map((cls, idx) => ({ id: idx + 1, name: cls.name, supercategory: 'object' }));

      let annId = 1;
      let imageId = 1;
      const activeCollId = displayLayer || mainLayer || 'default';

      for (const imageName of allImageNames) {
        const storageKey = `annotations_${id}_${activeCollId}_${imageName}`;
        const saved = localStorage.getItem(storageKey);
        
        // Get stored dimensions for this specific image
        const dimsKey = `annotations_${id}_${activeCollId}_${imageName}_dims`;
        const savedDims = localStorage.getItem(dimsKey);
        let imgWidth = 0;
        let imgHeight = 0;
        
        if (savedDims) {
          try {
            const dims = JSON.parse(savedDims) as { width: number; height: number };
            imgWidth = dims.width || 0;
            imgHeight = dims.height || 0;
          } catch (e) {
            console.warn(`Failed to parse dimensions for ${imageName}`);
          }
        }
        
        // If no dimensions found, try to get from current image or COCO data
        if ((imgWidth === 0 || imgHeight === 0) && cocoImageDimensionsRef.current[imageName]) {
          const cocoDims = cocoImageDimensionsRef.current[imageName];
          imgWidth = cocoDims.width || 0;
          imgHeight = cocoDims.height || 0;
        }
        
        // Final fallback: if this is the current image, use its dimensions
        if ((imgWidth === 0 || imgHeight === 0) && imageName === currentImageName) {
          const img = displayImage || currentImage;
          if (img) {
            imgWidth = (img as any)?.naturalWidth || 0;
            imgHeight = (img as any)?.naturalHeight || 0;
          }
        }
        
        if (!saved) {
          // Add image entry even if no annotations (if we have dimensions)
          if (imgWidth > 0 && imgHeight > 0) {
            imagesArr.push({ 
              id: imageId, 
              file_name: imageName, 
              width: imgWidth, 
              height: imgHeight 
            });
          }
          imageId++;
          continue;
        }

        let parsed: AnnotationShape[] = [];
        try { 
          parsed = JSON.parse(saved); 
        } catch (err) { 
          parsed = []; 
        }

        // Only add image if we have dimensions
        if (imgWidth > 0 && imgHeight > 0) {
          imagesArr.push({ 
            id: imageId, 
            file_name: imageName, 
            width: imgWidth, 
            height: imgHeight 
          });
        } else {
          // If we have annotations but no dimensions, that's a problem
          if (parsed.length > 0) {
            console.warn(`Skipping ${parsed.length} annotations for ${imageName}: no image dimensions available`);
          }
          // Skip this image if no dimensions
          imageId++;
          continue;
        }

        parsed.forEach((ann) => {
          if (ann.type === 'polygon' || ann.type === 'rectangle') {
            const [minX, minY, width, height] = pointsToBbox(ann.points);
            const categoryId = (classes.findIndex(c => c.name === ann.label) + 1) || 1;
            const segmentation = ann.type === 'polygon' ? [ann.points.flatMap((p) => [p.x, p.y])] : [];
            const area = ann.type === 'polygon' ? calculatePolygonArea(ann.points) : width * height;
            annotationsArr.push({
              id: annId++,
              image_id: imageId,
              category_id: categoryId,
              segmentation,
              area,
              bbox: [minX, minY, width, height],
              iscrowd: 0
            });
          }
        });

        imageId++;
      }

      // Save directly to backend without building full COCO file
      const response = await fetch(`${imageAnnotationApiBase()}/datasets/${id}/annotations/save-direct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name,
          categories: categoryMap,
          images: imagesArr,
          annotations: annotationsArr,
          active_collection_id: activeCollId,
        })
      });
      
      if (!response.ok) {
        const error = await response.json().catch(() => ({ detail: 'Unknown error' }));
        throw new Error(error.detail || 'Failed to save annotations');
      }
      
      const result = await response.json();
      
      if (result.success) {
        const fileName = name.endsWith('.json') ? name : `${name}.json`;
        const newAnnotationFileId = result.annotation_file_id;
        
        // Update the URL to include the annotation ID so subsequent edits work correctly
        if (newAnnotationFileId) {
          // Mark that we just saved so we don't reload and clear localStorage
          justSavedRef.current = true;
          
          // Update URL params to include the new annotation file ID
          const currentParams = new URLSearchParams(window.location.search);
          currentParams.set('annotationId', newAnnotationFileId);
          navigate(`${window.location.pathname}?${currentParams.toString()}`, { replace: true });
          
          // Reload annotation data from database to get fresh statistics
          if (api) {
            try {
              const annotationResponse = await api.getAnnotation(id, newAnnotationFileId);
              const contentResponse = await api.getAnnotationContent(id, newAnnotationFileId);
              
              if (contentResponse.success && contentResponse.data) {
                // Store in sessionStorage for future reference
                sessionStorage.setItem(`annotation_file_${id}`, JSON.stringify({
                  fileId: newAnnotationFileId,
                  fileName: fileName,
                  cocoData: contentResponse.data
                }));
                
                // Refresh statistics from the database
                await computeGlobalStats();
              }
            } catch (error) {
              console.warn('Could not reload annotation data after save:', error);
            }
          }
        }
        
        toast({ 
          title: 'Saved successfully', 
          description: `Annotation file "${fileName}" has been created with ${annotationsArr.length} annotations from ${imagesArr.length} images` 
        });
        return true;
      } else {
        throw new Error(result.message || 'Failed to save annotation file');
      }
    } catch (error) {
      console.error('Error saving annotation file:', error);
      toast({ 
        title: 'Save failed', 
        description: 'An error occurred while saving the annotation file',
        variant: 'destructive'
      });
      return false;
    } finally {
      setIsSavingAnnotation(false);
    }
  };

  // Handler for save button in dialog
  const handleSaveAnnotationFile = async () => {
    const success = await saveNewAnnotationFile(saveAnnotationName);
    if (success) {
      setHasUnsavedChanges(false);
      setShowSaveDialog(false);
      setSaveAnnotationName('');
      // Navigate away if this save was triggered by "Save & Leave"
      if (navigateAfterSaveRef.current && pendingNavigationRef.current) {
        navigateAfterSaveRef.current = false;
        navigate(pendingNavigationRef.current);
        pendingNavigationRef.current = null;
      }
    }
  };

  // Update database with current annotations: sync each image via PATCH (no full COCO replace).
  // This avoids ever running process_coco_annotation_file from here, so classes are never wiped.
  const updateDatabaseAnnotations = async () => {
    if (!annotationId || !api) {
      toast({
        title: 'Cannot update',
        description: 'No annotation selected for editing or API not available',
        variant: 'destructive'
      });
      return;
    }

    const apiBase = imageAnnotationApiBase();
    let totalAnnotations = 0;
    let imagesUpdated = 0;
    let lastError: string | null = null;

    try {
      const activeCollId = displayLayer || mainLayer || 'default';
      for (const imageName of allImageNames) {
        const storageKey = `annotations_${id}_${activeCollId}_${imageName}`;
        const saved = localStorage.getItem(storageKey);
        if (!saved) continue;

        let parsed: AnnotationShape[] = [];
        try {
          parsed = JSON.parse(saved);
        } catch {
          continue;
        }

        const annotationsData = parsed
          .filter((ann) => (ann.type === 'polygon' || ann.type === 'rectangle') && !!ann.points?.length)
          .map((ann) => {
            const [minX, minY, width, height] = pointsToBbox(ann.points);
            const segmentation = ann.type === 'polygon' ? [ann.points.flatMap((p: Point) => [p.x, p.y])] : [];
            const area = ann.type === 'polygon' ? calculatePolygonArea(ann.points) : width * height;
            return {
              category_name: ann.label,
              segmentation,
              bbox: [minX, minY, width, height],
              area
            };
          });

        const url = patchAnnotationImageUrl(id!, annotationId!, imageName);
        const response = await fetch(url, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            annotations: annotationsData,
            image_width: 0,
            image_height: 0,
            collection_id: activeCollId,
          })
        });
        const data = await response.json();

        if (response.ok && data.success) {
          imagesUpdated += 1;
          totalAnnotations += annotationsData.length;
        } else {
          lastError = data.detail || data.error || response.statusText;
        }
      }

      if (imagesUpdated > 0) {
        toast({
          title: 'Database updated',
          description: `Synced ${totalAnnotations} annotations from ${imagesUpdated} images (incremental update, no full replace).`
        });
        computeGlobalStats();
      }
      if (lastError && imagesUpdated === 0) {
        toast({
          title: 'Update failed',
          description: lastError,
          variant: 'destructive'
        });
      } else if (lastError && imagesUpdated < allImageNames.length) {
        toast({
          title: 'Partially updated',
          description: `Updated ${imagesUpdated} images. Some failed: ${lastError}`,
          variant: 'destructive'
        });
      }
    } catch (err) {
      console.error('Error updating annotation in database:', err);
      toast({
        title: 'Update failed',
        description: err instanceof Error ? err.message : 'Could not sync annotations',
        variant: 'destructive'
      });
    }
  };

  // Save current image annotations to database (single image only)
  const saveCurrentImageToDatabase = useCallback(async (
    overrideAnnotations?: AnnotationShape[],
  ): Promise<boolean> => {
    if (!annotationId || !api || !currentImageName) {
      return false;
    }

    // Allow callers (e.g. "Delete all annotations") to bypass the stale
    // `annotations` closure by passing the authoritative list explicitly.
    const annotationsToSave = overrideAnnotations ?? annotations;

    try {
      // Get current image dimensions
      const img = displayImage || currentImage;
      const imageWidth = (img as any)?.naturalWidth || 0;
      const imageHeight = (img as any)?.naturalHeight || 0;

      // Convert annotations to COCO format for this image
      const shapesToApiPayload = (shapes: AnnotationShape[]) =>
        shapes
          .filter((ann) => (ann.type === 'polygon' || ann.type === 'rectangle') && !!ann.points?.length)
          .map((ann, idx) => {
            const [minX, minY, width, height] = pointsToBbox(ann.points);
            const categoryId = (classes.findIndex(c => c.name === ann.label) + 1) || 1;
            const segmentation = ann.type === 'polygon' ? [ann.points.flatMap((p) => [p.x, p.y])] : [];
            const area = ann.type === 'polygon' ? calculatePolygonArea(ann.points) : width * height;
            return {
              id: idx + 1,
              image_id: 1,
              category_id: categoryId,
              category_name: ann.label,
              segmentation,
              bbox: [minX, minY, width, height],
              area,
              iscrowd: 0,
            };
          });

      const annotationsData = shapesToApiPayload(annotationsToSave);

      const activeCollId = getActiveCollectionId();
      const url = patchAnnotationImageUrl(id!, annotationId!, currentImageName);

      const patchCollection = async (
        collectionId: string,
        payload: typeof annotationsData,
      ): Promise<boolean> => {
        const numericCollectionId = Number(collectionId);
        const response = await fetch(url, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            annotations: payload,
            image_width: imageWidth,
            image_height: imageHeight,
            ...(Number.isFinite(numericCollectionId)
              ? { collection_id: numericCollectionId }
              : {}),
          }),
        });
        const data = await response.json();
        return response.ok && data.success;
      };

      const collectionTargets = new Map<string, typeof annotationsData>();
      collectionTargets.set(String(activeCollId), annotationsData);

      for (const dupId of readCompanionDuplicateIds()) {
        if (String(dupId) === String(activeCollId)) continue;
        collectionTargets.set(String(dupId), annotationsData);
      }

      for (const offId of readCopyOffCollectionIds()) {
        if (String(offId) === String(activeCollId)) continue;
        collectionTargets.set(String(offId), []);
      }

      let allOk = true;
      for (const [collId, payload] of collectionTargets) {
        const ok = await patchCollection(collId, payload);
        if (!ok) allOk = false;
      }

      const response = { ok: allOk };
      const data = { success: allOk };

      if (response.ok && data.success) {
        console.log('Image annotations saved:', data);

        const saveDims =
          imageWidth > 0 && imageHeight > 0
            ? { width: imageWidth, height: imageHeight }
            : imageRef.current?.naturalWidth && imageRef.current?.naturalHeight
              ? {
                  width: imageRef.current.naturalWidth,
                  height: imageRef.current.naturalHeight,
                }
              : undefined;
        saveAnnotationsToLocalStorage(currentImageName, annotationsToSave, saveDims);
        
        // Update sessionStorage COCO data to reflect the saved changes
        try {
          const annotationFileRef = sessionStorage.getItem(`annotation_file_${id}`);
          if (annotationFileRef) {
            const fileData = JSON.parse(annotationFileRef);
            const cocoData = fileData.cocoData;
            
            if (cocoData && cocoData.annotations && cocoData.images) {
              // Find the image ID for this image name
              const imageEntry = findCocoImageForDatasetName(cocoData.images, currentImageName);
              if (imageEntry) {
                // Update categories to include all current classes
                const existingCategoryNames = new Set(cocoData.categories?.map((c: any) => c.name) || []);
                classes.forEach((cls, idx) => {
                  if (!existingCategoryNames.has(cls.name)) {
                    // Add new category with next available ID
                    const maxCategoryId = Math.max(0, ...(cocoData.categories?.map((c: any) => c.id) || [0]));
                    cocoData.categories = cocoData.categories || [];
                    cocoData.categories.push({
                      id: maxCategoryId + 1,
                      name: cls.name,
                      supercategory: ""
                    });
                    console.log(`Added new category to sessionStorage: ${cls.name} with id ${maxCategoryId + 1}`);
                  }
                });
                
                // Build a category name to ID map for annotation category_id lookup
                const categoryNameToId: { [name: string]: number } = {};
                cocoData.categories?.forEach((cat: any) => {
                  categoryNameToId[cat.name] = cat.id;
                });
                
                // Remove old annotations for this image
                cocoData.annotations = cocoData.annotations.filter((ann: any) => ann.image_id !== imageEntry.id);
                
                // Add new annotations with proper COCO format
                let nextAnnId = Math.max(0, ...cocoData.annotations.map((a: any) => a.id || 0)) + 1;
                annotationsToSave.forEach((ann) => {
                  if (ann.type === 'polygon' || ann.type === 'rectangle') {
                    const [minX, minY, width, height] = pointsToBbox(ann.points);
                    // Use category ID from the COCO categories, not from frontend index
                    const categoryId = categoryNameToId[ann.label] || 1;
                    const segmentation = ann.type === 'polygon' ? [ann.points.flatMap((p) => [p.x, p.y])] : [];
                    const area = ann.type === 'polygon' ? calculatePolygonArea(ann.points) : width * height;
                    cocoData.annotations.push({
                      id: nextAnnId++,
                      image_id: imageEntry.id,
                      category_id: categoryId,
                      segmentation,
                      bbox: [minX, minY, width, height],
                      area,
                      iscrowd: 0
                    });
                  }
                });
                
                // Save back to sessionStorage
                fileData.cocoData = cocoData;
                sessionStorage.setItem(`annotation_file_${id}`, JSON.stringify(fileData));
                console.log(`Updated sessionStorage with ${annotationsToSave.length} annotations for ${currentImageName}`);

                
                // Recompute global statistics to reflect the changes
                await computeGlobalStats();
              }
            }
          }
        } catch (e) {
          console.warn('Could not update sessionStorage:', e);
        }
        
        return true;
      } else {
        console.error('Failed to save image annotations:', data.error || data.detail);
        return false;
      }
    } catch (error) {
      console.error('Error saving image annotations:', error);
      return false;
    }
  }, [annotationId, api, currentImageName, annotations, displayImage, currentImage, classes, id, getActiveCollectionId, saveAnnotationsToLocalStorage]);

  // Auto-save function with debouncing
  const autoSaveToDatabase = useCallback(async () => {
    // Only auto-save if in edit mode and there are unsaved changes
    if (!annotationId || !hasUnsavedChanges || isAutoSaving) {
      return;
    }

    // Debounce: only save if at least 60 seconds have passed since last save
    const now = Date.now();
    const timeSinceLastSave = now - lastSaveTimeRef.current;
    if (timeSinceLastSave < 60000) {
      return;
    }

    try {
      setIsAutoSaving(true);
      const success = await saveCurrentImageToDatabase();
      if (success) {
        setHasUnsavedChanges(false);
        lastSaveTimeRef.current = Date.now();
      }
    } catch (error) {
      console.error('Auto-save failed:', error);
      // Don't show toast for auto-save failures to avoid interrupting user
    } finally {
      setIsAutoSaving(false);
    }
  }, [annotationId, hasUnsavedChanges, isAutoSaving, saveCurrentImageToDatabase]);

  // Save all annotations from all images into a single COCO file
  const saveAllAnnotations = async () => {
    try {
      // Build images array and annotations array by reading per-image localStorage
      const imagesArr: any[] = [];
      const annotationsArr: any[] = [];
      const categoryMap = classes.map((cls, idx) => ({ id: idx + 1, name: cls.name }));

      let annId = 1;
      let imageId = 1;
      const exportCollId = annotationStorageCollId;

      for (const name of allImageNames) {
        const storageKey = `annotations_${id}_${exportCollId}_${name}`;
        const saved = localStorage.getItem(storageKey);
        
        // Get stored dimensions for this specific image (not current image!)
        const dimsKey = `annotations_${id}_${exportCollId}_${name}_dims`;
        const savedDims = localStorage.getItem(dimsKey);
        let imgWidth = 0;
        let imgHeight = 0;
        
        if (savedDims) {
          try {
            const dims = JSON.parse(savedDims) as { width: number; height: number };
            imgWidth = dims.width || 0;
            imgHeight = dims.height || 0;
          } catch (e) {
            console.warn(`Failed to parse dimensions for ${name}, using fallback`);
            imgWidth = imageRef.current?.naturalWidth || 0;
            imgHeight = imageRef.current?.naturalHeight || 0;
          }
        } else {
          // Fallback to current image dimensions (may be incorrect if different image)
          imgWidth = imageRef.current?.naturalWidth || 0;
          imgHeight = imageRef.current?.naturalHeight || 0;
        }
        
        if (!saved) {
          // still add image entry to keep indexing consistent
          imagesArr.push({ id: imageId, file_name: name, width: imgWidth, height: imgHeight });
          imageId++;
          continue;
        }

        let parsed: AnnotationShape[] = [];
        try { parsed = JSON.parse(saved); } catch (err) { parsed = []; }

        imagesArr.push({ id: imageId, file_name: name, width: imgWidth, height: imgHeight });

        parsed.forEach((ann) => {
          if (ann.type === 'polygon' || ann.type === 'rectangle') {
            const [minX, minY, width, height] = pointsToBbox(ann.points);
            const categoryId = (classes.findIndex(c => c.name === ann.label) + 1) || 1;
            const segmentation = ann.type === 'polygon' ? [ann.points.flatMap((p) => [p.x, p.y])] : [];
            const area = ann.type === 'polygon' ? calculatePolygonArea(ann.points) : width * height;
            annotationsArr.push({
              id: annId++,
              image_id: imageId,
              category_id: categoryId,
              segmentation,
              area,
              bbox: [minX, minY, width, height],
              iscrowd: 0
            });
          }
        });

        imageId++;
      }

      const coco = {
        info: {
          description: `${projectName ? `Project: ${projectName} | ` : ''}Dataset: ${datasetName || id}${annotationName ? ` | Annotation: ${annotationName}` : ''}`,
          version: '1.0',
          year: new Date().getFullYear(),
          contributor: 'LAI',
          date_created: new Date().toISOString()
        },
        images: imagesArr,
        categories: categoryMap,
        annotations: annotationsArr
      };

      const dataStr = JSON.stringify(coco, null, 2);

      // Always download the JSON file
      const dataUri = 'data:application/json;charset=utf-8,'+ encodeURIComponent(dataStr);
      const fileName = `annotations_all_${id}.json`;

      const link = document.createElement('a');
      link.setAttribute('href', dataUri);
      link.setAttribute('download', fileName);
      link.click();

      // If in edit mode (annotationId exists), also update the database
      if (annotationId && api) {
        try {
          const file = new File([dataStr], annotationName || fileName, { type: 'application/json' });
          const response = await api.updateAnnotationContent(parseInt(id), annotationId, file);
          
          if (response.success) {
            toast({ 
              title: 'Saved & Updated', 
              description: `Exported ${annotationsArr.length} annotations from ${imagesArr.length} images and updated database annotation "${annotationName}"` 
            });
          } else {
            toast({ 
              title: 'Partially saved', 
              description: `Exported JSON file but failed to update database: ${response.error}`,
              variant: 'destructive'
            });
          }
        } catch (updateError) {
          console.error('Error updating annotation in database:', updateError);
          toast({ 
            title: 'Partially saved', 
            description: `Exported JSON file but failed to update database annotation`,
            variant: 'destructive'
          });
        }
      } else {
        // Not in edit mode, just show standard export message
        toast({ title: 'Saved', description: `Exported ${annotationsArr.length} annotations from ${imagesArr.length} images` });
      }
    } catch (err) {
      console.error('Error exporting all annotations', err);
      toast({ title: 'Export failed', description: 'Failed to export all annotations', variant: 'destructive' });
    }
  };

  // Delete annotations for current image only
  const deleteCurrentImageAnnotations = async () => {
    if (!currentImageName || !id) return;

    setShowDeleteAllDialog(false); // Close the dialog

    const deletedCount = annotations.length;
    
    // Compute class counts BEFORE clearing annotations
    const countsByName: { [name: string]: number } = {};
    annotations.forEach((a: any) => {
      countsByName[a.label] = (countsByName[a.label] || 0) + 1;
    });

    // Clear in-memory annotations
    setAnnotations([]);
    
    // Persist the empty array (also mirrors to any "duplicate annotation"
    // companion collections, so deletes don't leave orphan annotations behind
    // on a previously mirrored layer).
    saveAnnotationsToLocalStorage(currentImageName, []);

    // Also update sessionStorage COCO data to remove annotations for this image
    try {
      const annotationFileRef = sessionStorage.getItem(`annotation_file_${id}`);
      if (annotationFileRef) {
        const fileData = JSON.parse(annotationFileRef);
        const cocoData = fileData.cocoData;
        
        if (cocoData && cocoData.annotations && cocoData.images) {
          // Find the image ID for this image name
          const imageEntry = findCocoImageForDatasetName(cocoData.images, currentImageName);
          if (imageEntry) {
            // Remove all annotations for this image from COCO data
            cocoData.annotations = cocoData.annotations.filter((ann: any) => ann.image_id !== imageEntry.id);
            
            // Save back to sessionStorage
            fileData.cocoData = cocoData;
            sessionStorage.setItem(`annotation_file_${id}`, JSON.stringify(fileData));
            console.log(`Removed annotations for ${currentImageName} from sessionStorage COCO data`);
          }
        }
      }
    } catch (e) {
      console.warn('Could not update sessionStorage:', e);
    }

    // Update global class counts by reducing the deleted annotation counts
    // Don't clear classes - they should persist across images
    setClasses(prev => {
      const updated = prev.map(c => ({
        ...c,
        count: Math.max(0, c.count - (countsByName[c.name] || 0))
      }));
      saveGlobalClasses(updated);
      return updated;
    });

    // Save deletion to database if in edit mode
    if (annotationId) {
      const saveSuccess = await saveCurrentImageToDatabase([]);
      if (saveSuccess) {
        // Set unsaved changes to false BEFORE recomputing stats
        setHasUnsavedChanges(false);
        lastSaveTimeRef.current = Date.now();
        
        // Recompute global stats after successful database save
        // Use a small delay to ensure backend has processed the update
        await new Promise(resolve => setTimeout(resolve, 500));
        await computeGlobalStats();
        
        toast({ 
          title: 'Annotations deleted', 
          description: `Removed ${deletedCount} annotation(s) from "${currentImageName}" and saved to database` 
        });
      } else {
        toast({ 
          title: 'Deletion saved locally', 
          description: `Removed ${deletedCount} annotation(s) but failed to save to database. Please try saving manually.`,
          variant: 'destructive'
        });
      }
    } else {
      // Recompute global stats even if not in edit mode
      await computeGlobalStats();
      toast({ 
        title: 'Annotations deleted', 
        description: `Removed ${deletedCount} annotation(s) from "${currentImageName}"` 
      });
    }
  };

  const handleBack = () => {
    const backUrl = projectId 
      ? `/projects/${projectId}/datasets/${id}` 
      : `/datasets/${id}`;
    
    // For new annotations (no annotationId), check if any annotations exist in localStorage
    // that haven't been saved to the database as an annotation file
    const hasUnsavedWork = annotationId 
      ? hasUnsavedChanges 
      : (hasUnsavedChanges || allImageNames.some(imageName => {
          const storageKey = `annotations_${id}_${annotationStorageCollId}_${imageName}`;
          const saved = localStorage.getItem(storageKey);
          return saved && saved !== '[]';
        }));

    if (hasUnsavedWork) {
      pendingNavigationRef.current = backUrl;
      setShowLeaveDialog(true);
    } else {
      navigate(backUrl);
    }
  };

  const handleLeaveConfirm = async (shouldSave: boolean) => {
    if (shouldSave) {
      if (annotationId) {
        // Edit mode: save directly to database
        await saveCurrentImageToDatabase();
        setHasUnsavedChanges(false);
        setShowLeaveDialog(false);
        if (pendingNavigationRef.current) {
          navigate(pendingNavigationRef.current);
          pendingNavigationRef.current = null;
        }
      } else {
        // New mode: need to ask for annotation file name first
        setShowLeaveDialog(false);
        navigateAfterSaveRef.current = true;
        setShowSaveDialog(true);
      }
    } else {
      setShowLeaveDialog(false);
      if (pendingNavigationRef.current) {
        navigate(pendingNavigationRef.current);
        pendingNavigationRef.current = null;
      }
    }
  };

  // When activating a class filter, jump to the first image that contains the class
  // (only if the current image doesn't already contain it).
  useEffect(() => {
    if (!classFilterName) return;
    const filterSet = classImageMap[classFilterName];
    if (!filterSet || filterSet.size === 0) {
      toast({
        title: 'No images for this class',
        description: `No saved annotations of "${classFilterName}" found. Filter cleared.`,
      });
      setClassFilterName(null);
      return;
    }
    if (currentImageName && filterSet.has(currentImageName)) return;
    const imageList = navigableImageNames;
    const target = imageList.find(n => filterSet.has(n));
    if (!target) return;
    const idx = imageList.findIndex(n => n === target);
    if (idx >= 0 && idx !== currentImageIndex) {
      setCurrentImageIndex(idx);
      setCurrentImageName(target);
      currentImageNameRef.current = target;
      updateCurrentImages(target, displayLayer, imageCollections);
      loadAnnotationsForImage(target);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classFilterName, classImageMap, navigableImageNames]);

  const navigateImage = useCallback(async (direction: 'prev' | 'next') => {
    const imageList = navigableImageNames;
    if (imageList.length === 0) return;
    
    // Save current image annotations to localStorage and database before navigating
    if (currentImageName) {
      try {
        if (annotations.length > 0) {
          // Route through the central helper so any companion collections
          // marked "duplicate" also receive the latest copy.
          const saveDims = imageRef.current?.naturalWidth && imageRef.current?.naturalHeight
            ? { width: imageRef.current.naturalWidth, height: imageRef.current.naturalHeight }
            : undefined;
          saveAnnotationsToLocalStorage(currentImageName, annotations, saveDims);
        } else {
          // Empty list — clear under the active collection AND any duplicates
          // so a user-initiated "delete all" propagates the same way saves do.
          const activeCollId = displayLayerRef.current || mainLayerRef.current || 'default';
          const targets = new Set<string>([activeCollId]);
          for (const dupId of readCompanionDuplicateIds()) {
            if (dupId && dupId !== activeCollId) targets.add(dupId);
          }
          for (const cid of targets) {
            try {
              localStorage.removeItem(`annotations_${id}_${cid}_${currentImageName}`);
            } catch { /* ignore */ }
          }
        }
      } catch (e) {
        if (e instanceof DOMException && e.name === 'QuotaExceededError') {
          console.warn('localStorage quota exceeded, relying on database save');
        } else {
          console.error('Error saving to localStorage:', e);
        }
      }
      // Save to database if in edit mode and has changes
      if (annotationId && hasUnsavedChanges) {
        await saveCurrentImageToDatabase();
        setHasUnsavedChanges(false);
        lastSaveTimeRef.current = Date.now();
        // Refresh statistics after saving
        await computeGlobalStats();
      }
    }
    
    // Determine target image. When a class filter is active, navigate only through
    // images that contain that class (intersected with the current layer's images).
    let newIndex: number;
    newIndex = direction === 'next'
      ? Math.min(currentImageIndex + 1, imageList.length - 1)
      : Math.max(currentImageIndex - 1, 0);

    // Clean up localStorage - remove cached annotations for images that are far away (more than 5 images)
    try {
      for (let i = 0; i < imageList.length; i++) {
        if (Math.abs(i - newIndex) > 5) {
          const oldStorageKey = `annotations_${id}_${annotationStorageCollId}_${imageList[i]}`;
          if (localStorage.getItem(oldStorageKey)) {
            localStorage.removeItem(oldStorageKey);
          }
        }
      }
    } catch (e) {
      // Ignore cleanup errors
    }
      
    setCurrentImageIndex(newIndex);
    const newImageName = imageList[newIndex];
    setCurrentImageName(newImageName);
    currentImageNameRef.current = newImageName;
    
    // Load global classes when editing an existing annotation file (not when starting new segmentation)
    if (annotationId) loadGlobalClasses();
    
    // Update the currentImage object as well
    updateCurrentImages(newImageName, displayLayer, imageCollections);
    
    // Load annotations for the new image
    loadAnnotationsForImage(newImageName);
  }, [currentImageIndex, navigableImageNames, displayLayer, imageCollections, loadAnnotationsForImage, currentImageName, annotations, id, annotationId, hasUnsavedChanges, saveCurrentImageToDatabase, annotationStorageCollId]);

  // Keyboard shortcuts: Arrow keys or A/D for previous/next image navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ignore when typing in inputs
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;

      // Left arrow or A key for previous image
      if (e.key === 'ArrowLeft' || e.key.toLowerCase() === 'a') {
        e.preventDefault();
        navigateImage('prev');
      }
      // Right arrow or D key for next image
      else if (e.key === 'ArrowRight' || e.key.toLowerCase() === 'd') {
        e.preventDefault();
        navigateImage('next');
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [navigateImage]);

  // Auto-save timer: check every 60 seconds if auto-save is needed
  useEffect(() => {
    if (!annotationId) return;

    const interval = setInterval(() => {
      autoSaveToDatabase();
    }, 60000); // Check every 60 seconds

    return () => clearInterval(interval);
  }, [annotationId, autoSaveToDatabase]);

  // Notify user when there are unsaved changes
  const prevHasUnsavedRef = useRef(false);
  useEffect(() => {
    if (hasUnsavedChanges && !prevHasUnsavedRef.current && annotationId) {
      toast({
        title: 'Unsaved changes',
        description: 'You have unsaved annotation changes. Click "Save Changes" to persist them.',
      });
    }
    prevHasUnsavedRef.current = hasUnsavedChanges;
  }, [hasUnsavedChanges, annotationId]);

  // Auto-save before navigating away from the page
  useEffect(() => {
    const handleBeforeUnload = async (e: BeforeUnloadEvent) => {
      if (hasUnsavedChanges && annotationId) {
        // Try to save immediately
        autoSaveToDatabase();
        
        // Show browser warning if there are unsaved changes
        e.preventDefault();
        e.returnValue = '';
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [hasUnsavedChanges, annotationId, autoSaveToDatabase]);

  // Determine if an image (by name) has any annotations.
  const isImageAnnotated = useCallback((imageName: string): boolean => {
    if (!imageName) return false;
    if (imageName === currentImageName && annotations.length > 0) return true;
    try {
      const storageKey = `annotations_${id}_${annotationStorageCollId}_${imageName}`;
      const cached = localStorage.getItem(storageKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed) && parsed.length > 0) return true;
      }
    } catch { /* ignore */ }
    try {
      const ref = sessionStorage.getItem(`annotation_file_${id}`);
      if (ref) {
        const fileData = JSON.parse(ref);
        const cocoData = fileData.cocoData;
        const imageEntry = cocoData?.images?.find((img: any) => img.file_name === imageName);
        if (imageEntry) {
          const has = cocoData.annotations?.some((a: any) => String(a.image_id) === String(imageEntry.id));
          if (has) return true;
        }
      }
    } catch { /* ignore */ }
    return false;
  }, [id, annotationStorageCollId, currentImageName, annotations.length]);

  const goToNextUnannotated = async () => {
    const imageList = navigableImageNames;
    for (let i = currentImageIndex + 1; i < imageList.length; i++) {
      if (!isImageAnnotated(imageList[i])) {
        await goToImage(i);
        return;
      }
    }
    toast({ title: 'No unannotated image found', description: 'All remaining images already have annotations.' });
  };

  const goToImage = async (index: number) => {
    const imageList = navigableImageNames;
    if (index >= 0 && index < imageList.length) {
      // Save current image annotations to localStorage and database before navigating
      if (currentImageName) {
        const storageKey = `annotations_${id}_${annotationStorageCollId}_${currentImageName}`;
        // Try to update localStorage - but don't fail if quota exceeded
        try {
          if (annotations.length > 0) {
            safeLocalStorageSet(storageKey, JSON.stringify(annotations));
          } else {
            localStorage.removeItem(storageKey);
          }
        } catch (e) {
          if (e instanceof DOMException && e.name === 'QuotaExceededError') {
            console.warn('localStorage quota exceeded, relying on database save');
          } else {
            console.error('Error saving to localStorage:', e);
          }
        }
        // Save to database if in edit mode and has changes
        if (annotationId && hasUnsavedChanges) {
          await saveCurrentImageToDatabase();
          setHasUnsavedChanges(false);
          lastSaveTimeRef.current = Date.now();
        }
      }

      // Clean up localStorage - remove cached annotations for images that are far away (more than 5 images)
      try {
        for (let i = 0; i < imageList.length; i++) {
          if (Math.abs(i - index) > 5) {
            const oldStorageKey = `annotations_${id}_${annotationStorageCollId}_${imageList[i]}`;
            if (localStorage.getItem(oldStorageKey)) {
              localStorage.removeItem(oldStorageKey);
            }
          }
        }
      } catch (e) {
        // Ignore cleanup errors
      }

      setCurrentImageIndex(index);
      const newImageName = imageList[index];
      setCurrentImageName(newImageName);
      currentImageNameRef.current = newImageName;
      
      // Update the currentImage object as well
      updateCurrentImages(newImageName, displayLayer, imageCollections);
      
      // Load annotations for the new image
      loadAnnotationsForImage(newImageName);
      
      // Pre-load annotations for next 2 images in the background
      setTimeout(() => {
        for (let i = 1; i <= 2; i++) {
          const nextIndex = index + i;
          if (nextIndex < imageList.length) {
            const nextImageName = imageList[nextIndex];
            const storageKey = `annotations_${id}_${annotationStorageCollId}_${nextImageName}`;
            
            // Only pre-load if not already in localStorage
            if (!localStorage.getItem(storageKey)) {
              try {
                const annotationFileRef = sessionStorage.getItem(`annotation_file_${id}`);
                if (annotationFileRef) {
                  const fileData = JSON.parse(annotationFileRef);
                  const cocoData = fileData.cocoData;
                  
                  // Find and cache annotations for this image
                  const imageEntry = cocoData.images?.find((img: any) => img.file_name === nextImageName);
                  if (imageEntry) {
                    const imageAnnotations: any[] = [];
                    const categoryIdToName: { [id: string]: string } = {};
                    const categoryIdToColor: { [id: string]: string } = {};
                    const classColorMapByName: { [name: string]: string } = {};
                    classes.forEach((cls) => {
                      classColorMapByName[cls.name.toLowerCase()] = cls.color;
                    });
                    
                    cocoData.categories?.forEach((cat: any, idx: number) => {
                      if (cat.id != null && cat.name) {
                        categoryIdToName[cat.id.toString()] = cat.name;
                        categoryIdToColor[cat.id.toString()] =
                          classColorMapByName[String(cat.name).toLowerCase()] ||
                          DEFAULT_COLORS[idx % DEFAULT_COLORS.length];
                      }
                    });
                    
                    cocoData.annotations?.forEach((annotation: any) => {
                      if (annotation.image_id === imageEntry.id && annotation.segmentation && annotation.segmentation.length > 0) {
                        // Handle null category_id
                        if (annotation.category_id == null) {
                          return;
                        }
                        const segmentation: number[] = cocoSegmentationToFlatCoords(annotation.segmentation);
                        if (segmentation.length >= 6) {
                          const points = [];
                          
                          // Detect and fix abnormally large coordinates
                          const firstX = segmentation[0];
                          const firstY = segmentation[1];
                          const isAbnormallyLarge = firstX > 10000 || firstY > 10000;
                          const scaleFactor = isAbnormallyLarge && imageEntry.width && imageEntry.height
                            ? { x: imageEntry.width, y: imageEntry.height }
                            : { x: 1, y: 1 };
                          
                          for (let j = 0; j < segmentation.length; j += 2) {
                            let x = segmentation[j] / scaleFactor.x;
                            let y = segmentation[j + 1] / scaleFactor.y;
                            
                            // Filter out invalid coordinates
                            if (isNaN(x) || isNaN(y) || !isFinite(x) || !isFinite(y)) {
                              continue;
                            }
                            
                            // Clamp to image bounds
                            if (imageEntry.width && imageEntry.height) {
                              x = Math.max(0, Math.min(x, imageEntry.width - 1));
                              y = Math.max(0, Math.min(y, imageEntry.height - 1));
                            }
                            
                            points.push({ x, y });
                          }
                          
                          // Only add if we have at least 3 valid points
                          if (points.length >= 3) {
                            const className = categoryIdToName[annotation.category_id.toString()];
                            if (className) {
                              imageAnnotations.push({
                                id: `annotation_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                                type: 'polygon',
                                points,
                                label: className,
                                color: categoryIdToColor[annotation.category_id.toString()] || DEFAULT_COLORS[0],
                                visible: true
                              });
                            }
                          }
                        }
                      }
                    });
                    
                    if (imageAnnotations.length > 0) {
                      safeLocalStorageSet(storageKey, JSON.stringify(imageAnnotations));
                      console.log(`Pre-loaded ${imageAnnotations.length} annotations for ${nextImageName}`);
                    }
                  }
                }
              } catch (e) {
                // Silently fail pre-loading
                console.warn(`Could not pre-load annotations for ${nextImageName}:`, e);
              }
            }
          }
        }
      }, 100);
    }
  };

  const handleLayerChange = (layerId: string) => {
    setIsLayerSwitching(true);
    layerSwitchCounterRef.current += 1;
    preserveZoomRef.current = false;
    preventZoomResetRef.current = false;
    lastLoadedAnnotationKeyRef.current = ''; // force annotation reload for new collection
    setDisplayLayer(layerId);
    // Display bitmap + noCorrespondingImage are synced in the effect that calls updateCurrentImages when displayLayer changes
    // Force a refit after layer switch to ensure proper image sizing
    setTimeout(() => {
      // Ensure zoom isn't preserved from previous layer
      preserveZoomRef.current = false;
      preventZoomResetRef.current = false;
      // Force refit to fit new layer's image dimensions
      if (imageRef.current && imageRef.current.complete && imageRef.current.naturalWidth > 0) {
        handleImageResize(true);
      }
    }, 50);
  };

  // If layer switch leaves nothing to load (no img onLoad), clear the switching overlay.
  // Covers two cases: (1) no image at all, and (2) an explicit display layer was picked
  // but the current image doesn't exist in that layer — in both cases the <img> element
  // is unmounted, so handleImageLoad never fires and the overlay would otherwise be stuck.
  useEffect(() => {
    if (!isLayerSwitching) return;
    const hasBitmap = displayLayer ? !!displayImage : !!(displayImage || currentImage);
    if (!hasBitmap) {
      setIsLayerSwitching(false);
    }
  }, [isLayerSwitching, displayImage, currentImage, displayLayer]);

  const handleMainLayerChange = (layerId: string) => {
    setMainLayer(layerId);
    
    // Update the navigation list to use the new main layer
    const mainLayerCollection = imageCollections.find(c => String(c.id) === String(layerId));
    if (mainLayerCollection) {
      const mainLayerImageNames = mainLayerCollection.images.map(img => img.fileName).sort();
      setCurrentLayerImageNames(mainLayerImageNames);
      
      // Reset to the first image in the new main layer
      if (mainLayerImageNames.length > 0) {
        setCurrentImageIndex(0);
        const firstImageName = mainLayerImageNames[0];
        setCurrentImageName(firstImageName);
        currentImageNameRef.current = firstImageName;
        updateCurrentImages(firstImageName, displayLayer, imageCollections);
        loadAnnotationsForImage(firstImageName, layerId);
      }
    }
  };

  const annotationStatistics = useMemo(() => {
    const mergedStats: Record<string, number> = { ...globalStats };
    const unsavedCounts: Record<string, number> = {};
    if (hasUnsavedChanges && annotations.length > 0) {
      annotations.forEach((a) => {
        if (a.label) {
          unsavedCounts[a.label] = (unsavedCounts[a.label] || 0) + 1;
        }
      });
      Object.entries(unsavedCounts).forEach(([name, count]) => {
        mergedStats[name] = (mergedStats[name] || 0) + count;
      });
    }
    const total = Object.values(mergedStats).reduce((s, v) => s + v, 0);
    const sortedClasses = [...classes].sort(
      (a, b) => (mergedStats[b.name] || 0) - (mergedStats[a.name] || 0),
    );
    const stats = sortedClasses.map((c) => {
      const count = mergedStats[c.name] || 0;
      const avgArea = globalAvgAreas[c.name] || 0;
      return {
        id: c.id,
        name: c.name,
        color: c.color,
        count,
        percentage: total > 0 ? (count / total) * 100 : 0,
        avgArea: avgArea > 0 ? avgArea : undefined,
        hasUnsaved: (unsavedCounts[c.name] || 0) > 0,
        unsavedDelta: unsavedCounts[c.name] || 0,
      };
    });
    return { stats, total };
  }, [globalStats, globalAvgAreas, classes, hasUnsavedChanges, annotations]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <div className="text-center">
          <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-primary mx-auto"></div>
          <p className="mt-4 text-muted-foreground">Loading images...</p>
        </div>
      </div>
    );
  }

  if (!currentImage && !displayImage) {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <div className="text-center">
          <p className="text-muted-foreground">No images found in this dataset</p>
          <Button onClick={handleBack} className="mt-4">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Dataset
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-background text-foreground">
      {/* Keyboard cheatsheet overlay (toggle with '?') */}
      {showCheatsheet && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-background/70 backdrop-blur-sm animate-fade-in"
          onClick={() => setShowCheatsheet(false)}
        >
          <div
            className="relative w-[min(720px,92vw)] max-h-[85vh] overflow-auto rounded-xl border border-border bg-card shadow-2xl p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Keyboard shortcuts</h2>
              <Button variant="ghost" size="sm" onClick={() => setShowCheatsheet(false)} aria-label="Close">
                <X className="w-4 h-4" />
              </Button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-5 text-sm">
              <section>
                <h3 className="text-xs uppercase tracking-wide text-muted-foreground mb-2">Tools</h3>
                <ul className="space-y-1.5">
                  <li className="flex justify-between"><span>Select</span><kbd className="px-1.5 py-0.5 bg-muted rounded text-xs">V</kbd></li>
                  <li className="flex justify-between"><span>Polygon</span><kbd className="px-1.5 py-0.5 bg-muted rounded text-xs">P</kbd></li>
                  <li className="flex justify-between"><span>SAM (auto-segment)</span><kbd className="px-1.5 py-0.5 bg-muted rounded text-xs">G</kbd></li>
                </ul>
              </section>
              <section>
                <h3 className="text-xs uppercase tracking-wide text-muted-foreground mb-2">Drawing</h3>
                <ul className="space-y-1.5">
                  <li className="flex justify-between"><span>Close polygon</span><kbd className="px-1.5 py-0.5 bg-muted rounded text-xs">Enter</kbd></li>
                  <li className="flex justify-between"><span>Cancel current shape</span><kbd className="px-1.5 py-0.5 bg-muted rounded text-xs">Esc</kbd></li>
                  <li className="flex justify-between"><span>SAM positive point</span><span className="text-muted-foreground text-xs">Click</span></li>
                  <li className="flex justify-between"><span>SAM negative point</span><span className="text-muted-foreground text-xs">Shift + Click</span></li>
                </ul>
              </section>
              <section>
                <h3 className="text-xs uppercase tracking-wide text-muted-foreground mb-2">Zoom & Pan</h3>
                <ul className="space-y-1.5">
                  <li className="flex justify-between"><span>Zoom</span><span className="text-muted-foreground text-xs">Ctrl/⌘ + Scroll</span></li>
                  <li className="flex justify-between"><span>Pan</span><span className="text-muted-foreground text-xs">Space + drag · Middle click</span></li>
                  <li className="flex justify-between"><span>Reset view</span><kbd className="px-1.5 py-0.5 bg-muted rounded text-xs">R</kbd></li>
                </ul>
              </section>
              <section>
                <h3 className="text-xs uppercase tracking-wide text-muted-foreground mb-2">General</h3>
                <ul className="space-y-1.5">
                  <li className="flex justify-between"><span>Save</span><span className="text-muted-foreground text-xs">Ctrl/⌘ + S</span></li>
                  <li className="flex justify-between"><span>Toggle this panel</span><kbd className="px-1.5 py-0.5 bg-muted rounded text-xs">?</kbd></li>
                  <li className="flex justify-between"><span>Close panel</span><kbd className="px-1.5 py-0.5 bg-muted rounded text-xs">Esc</kbd></li>
                </ul>
              </section>
            </div>
            <p className="mt-5 text-xs text-muted-foreground">Tip: shortcuts are disabled while typing in inputs.</p>
          </div>
        </div>
      )}

      {/* Header */}
      <header className="flex items-center justify-between p-4 bg-card border-b border-border">
        <div className="flex items-center gap-4">
          <Button variant="ghost" onClick={handleBack}>
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold">Segmentation Annotation</h1>
              {annotationId && annotationName && (
                <Badge variant="outline" className="text-xs border-primary/40 text-primary">
                  Editing {annotationName}
                </Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              Image {currentImageIndex + 1} of {allImageNames.length}: {currentImage?.fileName || currentImageName}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 relative">
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9"
            onClick={toggleTheme}
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          >
            {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
          {/* Save button - unified for both new and edit modes */}
          {!annotationId ? (
            <Button 
              onClick={() => {
                const hasAnnotations = allImageNames.some(imageName => {
                  const storageKey = `annotations_${id}_${annotationStorageCollId}_${imageName}`;
                  const saved = localStorage.getItem(storageKey);
                  return saved && saved !== '[]';
                });
                
                if (!hasAnnotations) {
                  toast({ 
                    title: 'No annotations', 
                    description: 'Please create some annotations before saving',
                    variant: 'destructive'
                  });
                  return;
                }
                
                setShowSaveDialog(true);
              }}
              disabled={
                !id ||
                isSavingAnnotation ||
                (annotations.length === 0 && !hasAnyAnnotationsStored)
              }
              title="Save annotations as new annotation file"
            >
              {isSavingAnnotation ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Save className="w-4 h-4 mr-2" />
                  Save
                </>
              )}
            </Button>
          ) : (
            <Button 
              onClick={async () => {
                const success = await saveCurrentImageToDatabase();
                if (success) {
                  setHasUnsavedChanges(false);
                  lastSaveTimeRef.current = Date.now();
                  toast({ 
                    title: 'Saved', 
                    description: `Changes for "${currentImageName}" saved to database` 
                  });
                } else {
                  toast({ 
                    title: 'Save failed', 
                    description: 'Failed to save changes to database',
                    variant: 'destructive'
                  });
                }
              }}
              disabled={!currentImageName || (!hasUnsavedChanges && annotations.length === 0)}
              title="Save current image annotations to database"
            >
              <Save className="w-4 h-4 mr-2" />
              Save Changes
            </Button>
          )}

          {/* Status badges - shown in both modes */}
          {isAutoSaving && (
            <Badge variant="outline" className="gap-1.5 border-muted-foreground/30 text-muted-foreground animate-pulse">
              <Loader2 className="w-3 h-3 animate-spin" />
              Saving…
            </Badge>
          )}
          
          {!isAutoSaving && hasUnsavedChanges && (
            <Badge variant="outline" className="gap-1.5 border-yellow-500/40 bg-yellow-500/10 text-yellow-600 dark:text-yellow-400">
              <AlertCircle className="w-3 h-3" />
              Unsaved
            </Badge>
          )}
          
          {!isAutoSaving && !hasUnsavedChanges && (annotations.length > 0 || annotationId) && (
            <Badge variant="outline" className="gap-1.5 border-green-500/40 bg-green-500/10 text-green-600 dark:text-green-400">
              <Check className="w-3 h-3" />
              Saved
            </Badge>
          )}

          <Button 
            onClick={downloadAnnotationsJSON} 
            disabled={!hasAnyAnnotationsStored}
            title="Download COCO JSON file with all annotations"
            variant="outline"
          >
            <Download className="w-4 h-4 mr-2" />
            Download JSON
          </Button>

          <Button
            size="sm"
            variant="outline"
            onClick={resetZoomAndPan}
            aria-label="Reset zoom and pan to default view"
            title="Reset zoom and pan to default view"
          >
            <RotateCcw className="w-4 h-4" />
          </Button>

          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShowHelp(v => !v)}
            aria-label="Zoom & Pan help"
            title="Zoom & Pan help"
          >
            <ZoomIn className="w-4 h-4" />
          </Button>

          {showHelp && (
            <div className="absolute right-0 top-full mt-2 z-50 w-[280px]">
              <Card className="bg-card border-border">
                <CardHeader>
                  <CardTitle className="text-sm">Zoom & Pan</CardTitle>
                </CardHeader>
                <CardContent className="text-xs text-muted-foreground">
                  <div className="mb-1"><strong>Zoom</strong>: Hold <kbd className="px-1 bg-muted rounded">Ctrl</kbd> (or <kbd className="px-1 bg-muted rounded">⌘</kbd>) + scroll</div>
                  <div className="mb-1"><strong>Pan</strong>: Middle-button drag, hold <kbd className="px-1 bg-muted rounded">Space</kbd> + drag, <strong>Ctrl</strong> + left/right drag, or <strong>Right + Left</strong> click drag</div>
                  <div className="mb-1"><strong>Reset View</strong>: Press <kbd className="px-1 bg-muted rounded">R</kbd> or click the reset button</div>
                  <div className="mb-1"><strong>Select</strong>: Press <kbd className="px-1 bg-muted rounded">V</kbd> | <strong>Draw</strong>: <kbd className="px-1 bg-muted rounded">P/B</kbd> | <strong>SAM</strong>: <kbd className="px-1 bg-muted rounded">G</kbd></div>
                  <div className="text-xs text-muted-foreground/70 mt-1">Tip: scroll over area you want to zoom into</div>
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      </header>

  <div className="flex flex-1 min-h-0 overflow-hidden relative">
        {/* Left Sidebar - Tools and Classes (collapsible & resizable) */}
        <div
           className="bg-card border-r border-border flex flex-col overflow-hidden"
          style={{ width: leftCollapsed ? 0 : leftWidth, minWidth: leftCollapsed ? 0 : undefined }}
        >
          <div className="p-2 border-b border-border flex items-center justify-between">
            <div className="text-sm font-medium">Tools</div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={() => {
                setLeftCollapsed(v => !v);
                setTimeout(() => { try { window.dispatchEvent(new Event('annotation-panel-resize-end')); } catch (err) {} }, 20);
              }}>
                {leftCollapsed ? <ChevronRight className="w-4 h-4"/> : <ChevronLeft className="w-4 h-4"/>}
              </Button>
            </div>
          </div>
          {/* Tools section moved inside content below */}
          {/* Tools */}
          <div className="p-4 border-b border-border">
            <h3 className="text-sm font-medium mb-3">Tools</h3>
            <div className="mb-3 space-y-2">
              <div className="flex items-center justify-between text-xs rounded-md border border-border bg-muted/30 px-2 py-1.5">
                <span className="text-muted-foreground">Mode</span>
                <span className="font-medium">{annotationMode === 'bbox' ? 'Bounding box' : 'Mask'}</span>
              </div>
              {annotationMode === 'mask' && bboxSwitchAllowed && !modeLocked && (
                <Button
                  variant="secondary"
                  size="sm"
                  className="w-full"
                  onClick={enableBboxModeOnce}
                  title="Switch once to bbox-only mode for this file/session"
                >
                  Switch to bbox mode (one-way)
                </Button>
              )}
              {modeLockReason && (
                <div className="text-[11px] text-muted-foreground">{modeLockReason}</div>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant={activeTool === 'select' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setActiveTool('select')}
                title="Select / move (V)"
              >
                <MousePointer2 className="w-4 h-4 mr-1" />
                <span className="flex-1 text-left">Select</span>
                <kbd className="ml-1 px-1 py-0 text-[10px] font-mono rounded bg-muted text-muted-foreground border border-border">V</kbd>
              </Button>
              {annotationMode === 'bbox' ? (
                <Button
                  variant={activeTool === 'rectangle' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => {
                    if (!ensureClassForDrawingTools()) return;
                    setActiveTool('rectangle');
                  }}
                  title="Bounding box drawing (P/B)"
                >
                  <Square className="w-4 h-4 mr-1" />
                  <span className="flex-1 text-left">Bounding box</span>
                  <kbd className="ml-1 px-1 py-0 text-[10px] font-mono rounded bg-muted text-muted-foreground border border-border">P/B</kbd>
                </Button>
              ) : (
                <>
                  <Button
                    variant={activeTool === 'polygon' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => {
                      if (!ensureClassForDrawingTools()) return;
                      setActiveTool('polygon');
                    }}
                    title="Polygon — click to add points (P)"
                  >
                    <Square className="w-4 h-4 mr-1" />
                    <span className="flex-1 text-left">Polygon</span>
                    <kbd className="ml-1 px-1 py-0 text-[10px] font-mono rounded bg-muted text-muted-foreground border border-border">P</kbd>
                  </Button>
                  <Button
                    variant={activeTool === 'pencil' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => {
                      if (!ensureClassForDrawingTools()) return;
                      setActiveTool('pencil');
                    }}
                    title="Free-hand draw — click and drag to outline a shape (B)"
                  >
                    <Pencil className="w-4 h-4 mr-1" />
                    <span className="flex-1 text-left">Pencil</span>
                    <kbd className="ml-1 px-1 py-0 text-[10px] font-mono rounded bg-muted text-muted-foreground border border-border">B</kbd>
                  </Button>
                </>
              )}
              <Button
                variant={activeTool === 'auto-segment' ? 'default' : 'outline'}
                size="sm"
                onClick={() => {
                  if (!ensureClassForDrawingTools()) return;
                  setActiveTool('auto-segment');
                  setSamPoints([]);
                }}
                disabled={isSamInteractionBlocked}
                title={
                  isSamModelLoading
                    ? 'Waiting for SAM model...'
                    : isSamProcessing
                    ? 'Processing segmentation...'
                    : annotationMode === 'bbox'
                    ? 'AI Segment — masks are converted to bounding boxes (G)'
                    : 'AI Segment — click on image to segment (G)'
                }
              >
                {isSamInteractionBlocked ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                    <span className="flex-1 text-left">{isSamModelLoading ? 'Loading model...' : 'Processing...'}</span>
                  </>
                ) : (
                  <>
                    <Hexagon className="w-4 h-4 mr-1" />
                    <span className="flex-1 text-left">AI Segment</span>
                    <kbd className="ml-1 px-1 py-0 text-[10px] font-mono rounded bg-muted text-muted-foreground border border-border">G</kbd>
                  </>
                )}
              </Button>
              {activeTool === 'auto-segment' && samPoints.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0 text-muted-foreground hover:text-white"
                  onClick={() => setSamPoints([])}
                  title="Clear SAM points"
                >
                  <X className="h-4 w-4" />
                </Button>
              )}
            </div>
            <div className="mt-2">
              <Label className="text-xs text-muted-foreground">Min detection area (px²)</Label>
              <Input
                type="number"
                min={0}
                step={10}
                className="h-8 text-xs bg-muted border-border mt-1"
                value={samMinArea}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  setSamMinArea(isNaN(v) || v < 0 ? 0 : v);
                }}
                title="Detections smaller than this area (in pixels²) will be discarded. Set to 0 to keep all."
              />
            </div>
            <div className="mt-2">
              <Label className="text-xs text-muted-foreground">Segment with</Label>
              <Select
                value={segmentModel}
                onValueChange={(v: 'sam2' | 'sam3') => setSegmentModel(v)}
                disabled={classes.length === 0 || isSamInteractionBlocked}
              >
                <SelectTrigger
                  className="h-8 text-xs bg-muted border-border mt-1"
                  title={classes.length === 0 ? 'Add at least one class first' : undefined}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sam2">SAM 2 (point)</SelectItem>
                  <SelectItem
                    value="sam3"
                    disabled={!sam3Available}
                    title={
                      !sam3Available
                        ? 'SAM 3: set SAM3_MODELS_HOST_PATH + SAM3_CHECKPOINT_FILENAME in .env (run lai install), or SAM3_ALLOW_HF_DOWNLOAD=true + HF_TOKEN'
                        : undefined
                    }
                  >
                    SAM 3 (point / text){!sam3Available ? ' — not available' : ''}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            {segmentModel === 'sam3' && (
              <>
                <div className="mt-2">
                  <Label className="text-xs text-muted-foreground">Text prompt (optional)</Label>
                  <Input
                    className="h-8 text-xs bg-muted border-border mt-1 placeholder:text-muted-foreground focus-visible:ring-ring"
                    placeholder="e.g. dog, person, red car"
                    value={segmentTextPrompt}
                    onChange={(e) => setSegmentTextPrompt(e.target.value)}
                    title="Describe what to segment. Leave empty to use point/box only (segment under click)."
                  />
                </div>
                <div className="mt-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full h-8 text-xs"
                    disabled={
                      isApplyingAllImages ||
                      !segmentTextPrompt.trim() ||
                      !selectedClass ||
                      imageCollections.find((c) => String(c.id) === mainLayer)?.images.length === 0
                    }
                    onClick={applySam3OnAllImages}
                    title="Run SAM 3 text segmentation on every image in the current layer and add annotations for the selected class"
                  >
                    {isApplyingAllImages && applyAllProgress ? (
                      <>
                        <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />
                        Applying {applyAllProgress.current}/{applyAllProgress.total}
                      </>
                    ) : (
                      <>
                        <Layers className="w-3 h-3 mr-1.5" />
                        Apply on all images
                      </>
                    )}
                  </Button>
                </div>
              </>
            )}
          </div>

          {/* Left: tools and classes only (Image Layers moved to bottom) */}

          {/* Classes */}
          <div className="flex-1 flex flex-col min-h-0">
            <div className="p-4 border-b border-border relative">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-medium">Classes</h3>
                <div className="relative">
                  {/* Pulsing ring around the + button while no classes exist
                      to draw the user's eye to the first action. */}
                  {classes.length === 0 && !isAddingClass && (
                    <span
                      aria-hidden
                      className="absolute inset-0 rounded-md ring-2 ring-primary/60 animate-ping"
                    />
                  )}
                  <Button
                    size="sm"
                    variant={classes.length === 0 ? 'default' : 'outline'}
                    aria-label="Add new class"
                    onClick={() => setIsAddingClass(true)}
                    className="relative"
                  >
                    <Plus className="w-4 h-4" />
                  </Button>
                </div>
              </div>

              {/* First-run hint inline in the Classes panel */}
              {classes.length === 0 && !isAddingClass && (
                <div className="mb-3 rounded-md border border-primary/30 bg-primary/5 p-2.5 text-xs text-foreground animate-fade-in">
                  <div className="flex items-start gap-2">
                    <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-[10px] font-semibold">
                      1
                    </span>
                    <div className="leading-snug">
                      <div className="font-medium">Add a class to get started</div>
                      <div className="text-muted-foreground mt-0.5">
                        Click the <span className="inline-flex items-center"><Plus className="inline h-3 w-3" /></span> button to define your first label, then start annotating.
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {isAddingClass && (
                <div className="flex gap-2 mb-3">
                  <Input
                    placeholder="Class name"
                    value={newClassName}
                    onChange={(e) => setNewClassName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') addClass();
                      if (e.key === 'Escape') {
                        setIsAddingClass(false);
                        setNewClassName('');
                      }
                    }}
                    className="h-8"
                    autoFocus
                  />
                  <Button size="sm" onClick={addClass}>
                    <Check className="w-4 h-4" />
                  </Button>
                  <Button 
                    size="sm" 
                    variant="outline"
                    onClick={() => {
                      setIsAddingClass(false);
                      setNewClassName('');
                    }}
                  >
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              )}
              {/* Class search — appears only when there are several classes to filter */}
              {classes.length >= 6 && (
                <div className="mb-2">
                  <Input
                    placeholder="Search classes…"
                    value={classSearch}
                    onChange={(e) => setClassSearch(e.target.value)}
                    className="h-7 text-xs"
                  />
                </div>
              )}
              {soloClassId && (
                <div className="mb-2 flex items-center justify-between rounded-md border border-primary/40 bg-primary/10 px-2 py-1 text-xs">
                  <span>
                    Showing only <strong>{classes.find(c => c.id === soloClassId)?.name}</strong>
                  </span>
                  <button
                    onClick={() => setSoloClassId(null)}
                    className="text-primary hover:underline"
                  >
                    Clear
                  </button>
                </div>
              )}
              {classFilterName && (
                <div className="mb-2 flex items-center justify-between rounded-md border border-primary/40 bg-primary/10 px-2 py-1 text-xs">
                  <span className="flex items-center gap-1.5 min-w-0">
                    <FilterIcon className="h-3 w-3 text-primary shrink-0" />
                    <span className="truncate">
                      Navigating images with{' '}
                      <strong>{classFilterName}</strong>{' '}
                    </span>
                  </span>
                  <button
                    onClick={() => {
                      const nextList = baseNavigableImageNames;
                      setClassFilterName(null);
                      if (nextList.length > 0) {
                        const first = nextList[0];
                        setCurrentImageIndex(0);
                        setCurrentImageName(first);
                        currentImageNameRef.current = first;
                        updateCurrentImages(first, displayLayer, imageCollections);
                        loadAnnotationsForImage(first);
                      }
                    }}
                    className="text-primary hover:underline shrink-0 ml-2"
                  >
                    Clear
                  </button>
                </div>
              )}
            </div>

            <ScrollArea className="flex-1 scrollbar-thin">
              <div className="p-4 space-y-2">
                  {classes
                    .filter(c => !classSearch || c.name.toLowerCase().includes(classSearch.toLowerCase()))
                    .map((classObj, idx) => (
                    <div
                      key={classObj.id}
                      className={`p-2 rounded border cursor-pointer transition-colors ${
                        selectedClass === classObj.id 
                          ? 'border-primary bg-primary/20' 
                          : 'border-border hover:border-muted-foreground/50'
                      }`}
                      onClick={() => {
                        if (editingClassId !== classObj.id) {
                          setSelectedClass(classObj.id);
                        }
                      }}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                          <Popover>
                            <PopoverTrigger asChild>
                              <button
                                className="w-4 h-4 rounded flex-shrink-0 ring-offset-background transition-all hover:ring-2 hover:ring-ring hover:ring-offset-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                style={{ backgroundColor: classObj.color }}
                                onClick={(e) => e.stopPropagation()}
                                title="Change class color"
                              />
                            </PopoverTrigger>
                            <PopoverContent className="w-auto p-3" align="start" side="right">
                              <div className="grid grid-cols-5 gap-1.5">
                                {DEFAULT_COLORS.map((color) => (
                                  <button
                                    key={color}
                                    className={`w-6 h-6 rounded-md border-2 transition-all hover:scale-110 ${
                                      classObj.color === color ? 'border-foreground ring-1 ring-ring' : 'border-transparent'
                                    }`}
                                    style={{ backgroundColor: color }}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setClasses(prev => {
                                        const updated = prev.map(c => c.id === classObj.id ? { ...c, color } : c);
                                        saveGlobalClasses(updated);
                                        return updated;
                                      });
                                      setAnnotations(prev => prev.map(a => a.label === classObj.name ? { ...a, color } : a));
                                      setHasUnsavedChanges(true);
                                    }}
                                  />
                                ))}
                              </div>
                              <Separator className="my-2" />
                              <div className="flex items-center gap-2">
                                <label className="text-xs text-muted-foreground">Custom:</label>
                                <input
                                  type="color"
                                  value={classObj.color}
                                  onChange={(e) => {
                                    const color = e.target.value;
                                    setClasses(prev => {
                                      const updated = prev.map(c => c.id === classObj.id ? { ...c, color } : c);
                                      saveGlobalClasses(updated);
                                      return updated;
                                    });
                                    setAnnotations(prev => prev.map(a => a.label === classObj.name ? { ...a, color } : a));
                                    setHasUnsavedChanges(true);
                                  }}
                                  className="w-6 h-6 rounded cursor-pointer border-0 p-0"
                                  onClick={(e) => e.stopPropagation()}
                                />
                              </div>
                            </PopoverContent>
                          </Popover>
                          {editingClassId === classObj.id ? (
                            <div className="flex items-center gap-1 flex-1">
                              <Input
                                value={editingClassName}
                                onChange={(e) => setEditingClassName(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') saveEditingClass();
                                  if (e.key === 'Escape') cancelEditingClass();
                                }}
                                className="h-6 text-sm py-0 px-1"
                                autoFocus
                                onClick={(e) => e.stopPropagation()}
                              />
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 w-6 p-0"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  saveEditingClass();
                                }}
                              >
                                <Check className="w-3 h-3 text-green-500" />
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 w-6 p-0"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  cancelEditingClass();
                                }}
                              >
                                <X className="w-3 h-3 text-gray-400" />
                              </Button>
                            </div>
                          ) : (
                            <span className="text-sm truncate">{classObj.name}</span>
                          )}
                        </div>

                        {editingClassId !== classObj.id && (
                          <div className="flex items-center gap-1">
                            {/* Visibility toggle */}
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-6 w-6 p-0 hover:bg-muted"
                              onClick={(e) => {
                                e.stopPropagation();
                                setClasses(prev => {
                                  const updated = prev.map(c => c.id === classObj.id ? { ...c, visible: c.visible === false ? true : false } : c);
                                  saveGlobalClasses(updated);
                                  return updated;
                                });
                              }}
                              title={classObj.visible === false ? 'Show class' : 'Hide class'}
                            >
                              {classObj.visible === false ? <EyeOff className="w-3 h-3 text-muted-foreground" /> : <Eye className="w-3 h-3 text-muted-foreground" />}
                            </Button>
                            {/* Solo */}
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-6 w-6 p-0 hover:bg-muted"
                              onClick={(e) => {
                                e.stopPropagation();
                                setSoloClassId(prev => prev === classObj.id ? null : classObj.id);
                              }}
                              title={soloClassId === classObj.id ? 'Exit solo (show all)' : 'Solo: show only this class'}
                            >
                              <Crosshair className={`w-3 h-3 ${soloClassId === classObj.id ? 'text-primary' : 'text-muted-foreground'}`} />
                            </Button>
                            {/* Filter navigation by this class */}
                            <Button
                              size="sm"
                              variant="ghost"
                              className={`h-6 w-6 p-0 hover:bg-muted ${classFilterName === classObj.name ? 'bg-primary/15 ring-1 ring-primary/40' : ''}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                const nav = resolveClassFilterToggleNavigation(
                                  baseNavigableImageNames,
                                  classImageMap,
                                  classFilterName,
                                  classObj.name,
                                );
                                setClassFilterName(nav.nextFilterName);
                                if (nav.firstImage) {
                                  const first = nav.firstImage;
                                  setCurrentImageIndex(0);
                                  setCurrentImageName(first);
                                  currentImageNameRef.current = first;
                                  updateCurrentImages(first, displayLayer, imageCollections);
                                  loadAnnotationsForImage(first);
                                }
                              }}
                              title={
                                classFilterName === classObj.name
                                  ? 'Clear class filter — show all images'
                                  : `Navigate only images containing "${classObj.name}"`
                              }
                            >
                              <FilterIcon className={`w-3 h-3 ${classFilterName === classObj.name ? 'text-primary' : 'text-muted-foreground'}`} />
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                               className="h-6 w-6 p-0 hover:bg-muted"
                              onClick={(e) => {
                                e.stopPropagation();
                                startEditingClass(classObj.id, classObj.name);
                              }}
                              title="Rename class"
                            >
                              <Edit className="w-3 h-3 text-primary" />
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-6 w-6 p-0 hover:bg-muted"
                              onClick={(e) => {
                                e.stopPropagation();
                                deleteClass(classObj.id);
                              }}
                              title="Delete class"
                            >
                              <Trash2 className="w-3 h-3 text-red-400" />
                            </Button>
                            {/* Shortcut hint */}
                            <div className="text-xs text-muted-foreground px-1.5 py-0.5 rounded border border-border ml-1">
                              {idx + 1}
                            </div>
                         </div>
                         )}
                       </div>
                     </div>
                   ))}
              </div>
            </ScrollArea>
          </div>
          {/* Side panels are no longer resizable — toggle only. */}
        </div>

        {/* Floating expand button when left sidebar is collapsed */}
        {leftCollapsed && (
          <div className="absolute left-2 top-1/2 -translate-y-1/2 z-50">
            <Button
              size="sm"
              onClick={() => {
                setLeftCollapsed(false);
                setTimeout(() => { try { window.dispatchEvent(new Event('annotation-panel-resize-end')); } catch (err) {} }, 20);
              }}
              aria-label="Expand left panel"
              className="bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg rounded-full p-1"
            >
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        )}


        {/* Main Canvas Area */}
        <div className="flex-1 flex flex-col min-h-0 min-w-0">
          <ResizablePanelGroup direction="horizontal" className="flex-1 min-h-0 relative">
            <ResizablePanel defaultSize={imageCollections.length > 1 && companionPanelOpen ? 70 : 100} minSize={30}>
              <div
                ref={containerRef}
                className="h-full relative overflow-hidden bg-muted/30 min-w-0"
              >
            {/**
             * The canvas must render the bitmap for the *selected display layer*. When a
             * display layer is active we only show `displayImage` (which was looked up in
             * that specific layer); falling back to `currentImage` would mean switching
             * from e.g. "RGB Images" to "Depth" kept showing the RGB bitmap. When no
             * display layer is set (initial state), we still allow `currentImage` as a
             * fallback so the canvas isn't blank during bootstrap.
             */}
            {(() => {
              const bitmap = displayLayer ? displayImage : (displayImage || currentImage);
              return bitmap ? (
              <>
                <img
                  key={`layer-${layerSwitchCounterRef.current}-${displayLayer}`}
                  ref={imageRef}
                  src={resolveBackendMediaUrl(bitmap.url) || bitmap.url || ''}
                  alt={bitmap.fileName || 'Current image'}
                  className="absolute opacity-0"
                  onLoad={handleImageLoad}
                  onError={(e) => {
                    console.error('Image failed to load:', e);
                    console.error('Image src:', bitmap.url);
                  }}
                  crossOrigin="anonymous"
                />
                <canvas
                  ref={canvasRef}
                  className={`absolute w-full h-full ${activeTool === 'select' ? 'cursor-default' : 'cursor-crosshair'} ${isSamInteractionBlocked && activeTool === 'auto-segment' ? 'pointer-events-none' : ''}`}
                  onMouseDown={handleCanvasMouseDown}
                  onMouseMove={handleCanvasMouseMove}
                  onMouseUp={handleCanvasMouseUp}
                  onDoubleClick={handleCanvasDoubleClick}
                  onContextMenu={handleCanvasRightClick}
                />
                {/* Show loading overlay during layer switching */}
                {isLayerSwitching && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/50 backdrop-blur-sm z-10">
                    <div className="text-center text-white">
                      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white mx-auto mb-2"></div>
                      <div className="text-sm">Switching layer...</div>
                    </div>
                  </div>
                )}
                {!isLayerSwitching && annotationsLoadingForImage === currentImageName && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/35 backdrop-blur-[1px] z-10 pointer-events-none">
                    <div className="inline-flex items-center gap-2 rounded-md bg-background/90 text-foreground px-3 py-2 border border-border shadow-lg">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span className="text-sm font-medium">Loading annotations...</span>
                    </div>
                  </div>
                )}
                {showSamBlockingOverlay && (
                  <div
                    className="absolute inset-0 z-30 flex items-center justify-center bg-black/45 backdrop-blur-[1px]"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                  >
                    <div className="flex flex-col items-center gap-3 rounded-lg border border-border bg-card/95 px-6 py-5 shadow-lg max-w-xs text-center">
                      <Loader2 className="h-8 w-8 animate-spin text-primary" />
                      <p className="text-sm font-medium">
                        {isSamProcessing ? 'Running segmentation…' : 'Loading SAM model…'}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {isSamProcessing
                          ? 'Please wait while the mask is generated.'
                          : 'First-time model load can take a minute.'}
                      </p>
                      <Button size="sm" variant="outline" onClick={cancelSamInteraction}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="text-center text-muted-foreground">
                  <div className="text-2xl mb-2">📷</div>
                  {noCorrespondingImage && displayLayer ? (
                    <>
                      <div className="text-lg font-medium">No corresponding image found</div>
                      <div className="text-sm">
                        Image "{currentImageName}" not found in {imageCollections.find(c => String(c.id) === String(displayLayer))?.name || 'this layer'}
                      </div>
                      <div className="text-xs mt-2 text-muted-foreground/70">Switch to a different layer or choose another image</div>
                    </>
                  ) : (
                    <>
                      <div className="text-lg font-medium">No Image Available</div>
                      <div className="text-sm">
                        Image "{currentImageName}" does not exist in {imageCollections.find(c => String(c.id) === String(displayLayer))?.name || 'this layer'}
                      </div>
                      <div className="text-xs mt-2 text-muted-foreground/70">Switch to a different layer or navigate to another image</div>
                    </>
                  )}
                </div>
              </div>
            );
            })()}

            {/* Active-tool hint pill (top-center) — explains what the current tool does */}
            {activeTool !== 'select' && currentImage && (
              <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 pointer-events-none animate-fade-in">
                <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card/90 backdrop-blur-sm px-3 py-1 text-xs font-medium shadow-sm">
                  {activeTool === 'polygon' && (
                    <>
                      <Hexagon className="h-3.5 w-3.5 text-primary" />
                      <span><strong>Polygon</strong> — click to add points · <kbd className="px-1 bg-muted rounded">Enter</kbd> close · <kbd className="px-1 bg-muted rounded">Esc</kbd> cancel</span>
                    </>
                  )}
                  {activeTool === 'pencil' && (
                    <>
                      <Pencil className="h-3.5 w-3.5 text-primary" />
                      <span><strong>Pencil</strong> — drag to free-draw outline · release to close</span>
                    </>
                  )}
                  {activeTool === 'auto-segment' && (
                    <>
                      <Crosshair className="h-3.5 w-3.5 text-primary" />
                      <span>
                        <strong>SAM</strong> — click positive point · <kbd className="px-1 bg-muted rounded">Shift</kbd>+click negative · <kbd className="px-1 bg-muted rounded">Enter</kbd> accept
                        {isSamModelLoading && !showSamModelWaitOverlay && (
                          <span className="ml-1 text-muted-foreground">(checking service…)</span>
                        )}
                      </span>
                    </>
                  )}
                  {activeTool === 'rectangle' && (
                    <>
                      <Square className="h-3.5 w-3.5 text-primary" />
                      <span><strong>Rectangle</strong> — drag to draw bounding box</span>
                    </>
                  )}
                  {activeTool === 'circle' && (
                    <>
                      <span><strong>Circle</strong> — drag from center outward</span>
                    </>
                  )}
                </div>
              </div>
            )}

            {/* On-canvas HUD chip (bottom-left) — zoom %, cursor px, current class */}
            {currentImage && (
              <div className="absolute bottom-3 left-3 z-20 pointer-events-none">
                <div className="inline-flex items-center gap-3 rounded-md border border-border bg-card/85 backdrop-blur-sm px-2.5 py-1 text-[11px] font-mono shadow-sm">
                  <span className="text-muted-foreground">
                    <span className="text-foreground font-semibold">{Math.round(imageScale * 100)}%</span>
                  </span>
                  <span className="text-muted-foreground">
                    {cursorImagePosition
                      ? <>x:<span className="text-foreground">{Math.round(cursorImagePosition.x)}</span> y:<span className="text-foreground">{Math.round(cursorImagePosition.y)}</span></>
                      : <>x:— y:—</>}
                  </span>
                  {(() => {
                    const cls = classes.find(c => c.id === selectedClass);
                    if (!cls) return <span className="text-muted-foreground">no class</span>;
                    return (
                      <span className="inline-flex items-center gap-1.5">
                        <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: cls.color }} />
                        <span className="text-foreground">{cls.name}</span>
                      </span>
                    );
                  })()}
                  <span className="text-muted-foreground">
                    <kbd className="px-1 bg-muted rounded text-[10px]">?</kbd> shortcuts
                  </span>
                </div>
              </div>
            )}

            {/* First-run onboarding overlay: shown over the canvas while no
                classes have been defined. Walks the user through the
                two-step flow: add classes → then annotate. */}
            {classes.length === 0 && !onboardingDismissed && (
              <div className="absolute inset-0 z-20 pointer-events-none flex items-center justify-center">
                {/* Soft scrim so the message reads cleanly over any image */}
                <div className="absolute inset-0 bg-background/60 backdrop-blur-[2px] animate-fade-in" />

                <div className="relative animate-scale-in pointer-events-auto max-w-md mx-4">
                  <div className="rounded-xl border border-border bg-card/95 shadow-2xl p-5">
                    <div className="flex items-center gap-2 mb-3">
                      <Palette className="h-5 w-5 text-primary" />
                      <h2 className="text-base font-semibold">Let's get you annotating</h2>
                    </div>

                    <ol className="space-y-3">
                      <li className="flex items-start gap-3 animate-fade-in" style={{ animationDelay: '80ms', animationFillMode: 'backwards' }}>
                        <span className="relative inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm font-semibold">
                          1
                          <span aria-hidden className="absolute inset-0 rounded-full ring-2 ring-primary/50 animate-ping" />
                        </span>
                        <div>
                          <div className="text-sm font-medium">Add your classes first</div>
                          <div className="text-xs text-muted-foreground">
                            Open the <span className="font-medium text-foreground">Classes</span> panel on the left and click <Plus className="inline h-3 w-3 -mt-0.5" /> to define labels (e.g. <em>person</em>, <em>car</em>).
                          </div>
                        </div>
                      </li>

                      <li className="flex items-start gap-3 animate-fade-in opacity-80" style={{ animationDelay: '260ms', animationFillMode: 'backwards' }}>
                        <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground text-sm font-semibold">
                          2
                        </span>
                        <div>
                          <div className="text-sm font-medium">Then annotate</div>
                          <div className="text-xs text-muted-foreground">
                            Pick a tool — {annotationMode === 'bbox' ? 'Bounding box or AI Segment' : 'Polygon, Pencil, or AI Segment'} — and draw on the image.
                          </div>
                        </div>
                      </li>
                    </ol>

                    <div className="mt-4 flex justify-end gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setOnboardingDismissed(true);
                          try { sessionStorage.setItem('annotation-onboarding-dismissed', '1'); } catch {}
                        }}
                      >
                        Just browsing
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => {
                          setIsAddingClass(true);
                          setOnboardingDismissed(true);
                          try { sessionStorage.setItem('annotation-onboarding-dismissed', '1'); } catch {}
                        }}
                        className="gap-1"
                      >
                        <Plus className="h-4 w-4" />
                        Add first class
                      </Button>
                    </div>
                  </div>

                  {/* Bouncing arrow toward the Classes panel on the left */}
                  <div className="hidden md:flex absolute -left-10 top-1/2 -translate-y-1/2 items-center text-primary animate-bounce">
                    <ChevronLeft className="h-8 w-8 drop-shadow" />
                  </div>
                </div>
              </div>
            )}

            {/* Drawing Instructions */}
            {isDrawing && activeTool === 'polygon' && (
              <div className="absolute top-4 left-4 bg-background/90 backdrop-blur-sm border border-border text-foreground px-4 py-2 rounded-lg text-sm z-10">
                <div className="flex flex-col gap-1">
                  <div className="font-semibold">Drawing Polygon ({currentPath.length} points)</div>
                  <div className="text-xs text-muted-foreground">
                    • Click to add points
                    • <strong>Double-click</strong> to finish
                    • <strong>Right-click</strong> to finish  
                    • <strong>Enter</strong> to finish
                    • <strong>Esc</strong> to cancel
                  </div>
                  {currentPath.length < 3 && (
                    <div className="text-xs text-yellow-500">
                      Need at least 3 points to finish
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Auto-segment preview overlay with accept/cancel controls */}
            {autoSegmentPreview && (() => {
              // Read from the same refs the canvas uses so the SAM preview
              // (fill "bitmask" + outline) stays aligned with the bitmap and
              // already-accepted annotation polygons during zoom/pan. Using
              // only React state here lags one render behind scaleRef/offsetRef
              // updated synchronously by handleImageResize and the zoom anim,
              // which made the bitmask drift while the outline stayed correct.
              const sNow = scaleRef.current || imageScale;
              const oNow = offsetRef.current || imageOffset;
              const toScreen = (p: Point) =>
                `${(p.x * sNow + oNow.x).toFixed(2)},${(p.y * sNow + oNow.y).toFixed(2)}`;
              return (
              <div className="absolute inset-0 pointer-events-none">
                {/* draw polygon outlines on top using an SVG overlay */}
                <svg className="absolute inset-0 w-full h-full pointer-events-none">
                  {autoSegmentPreview.polygons.map((poly, i) => (
                    <polygon
                      key={`fill_${i}`}
                      points={poly.map(toScreen).join(' ')}
                      fill="rgba(0, 255, 170, 0.25)"
                      stroke="none"
                    />
                  ))}
                  {autoSegmentPreview.polygons.map((poly, i) => (
                    <polyline
                      key={i}
                      points={poly.map(toScreen).join(' ')}
                      fill="none"
                      stroke="#00FFAA"
                      strokeWidth={2}
                    />
                  ))}
                </svg>

                {/* Controls - accept/cancel */}
                <div className="absolute right-6 bottom-6 z-40 pointer-events-auto flex flex-col gap-2 w-64 bg-card/90 backdrop-blur-sm border border-border p-3 rounded-lg">
                  <p className="text-xs text-muted-foreground">
                    Left-click: add to mask. Right-click: remove from mask. Add more points to refine. Press Enter to accept.
                  </p>
                  <div className="flex gap-2">
                    <Select value={autoSegmentClassId || ''} onValueChange={(v) => {
                      const idVal = v || null;
                      setAutoSegmentClassId(idVal);
                    }}>
                      <SelectTrigger className="w-36"><SelectValue placeholder="Class" /></SelectTrigger>
                      <SelectContent>
                        {classes.map(c => (
                          <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="flex justify-end gap-2 mt-2">
                    <Button size="sm" onClick={acceptAutoSegment}>Accept</Button>
                    <Button size="sm" variant="outline" onClick={cancelAutoSegment}>Cancel</Button>
                  </div>
                </div>
              </div>
              );
            })()}

            {/* Image adjustments — brightness/contrast/saturation. Display-only,
                does not modify the source image or saved annotations. */}
            <div className="absolute top-2 right-2 z-20">
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    className="inline-flex items-center gap-1.5 text-xs font-medium rounded-md px-2 py-1 border border-border bg-card/90 backdrop-blur-sm hover:bg-accent shadow-sm"
                    title="Adjust brightness, contrast, saturation"
                  >
                    <Sun className="h-3.5 w-3.5 text-primary" />
                    Adjust
                    {(imageBrightness !== 100 || imageContrast !== 100 || imageSaturation !== 100) && (
                      <span className="ml-1 inline-block w-1.5 h-1.5 rounded-full bg-primary" />
                    )}
                  </button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-72 p-3 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-medium text-muted-foreground">Image adjustments</div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 text-xs px-2"
                      onClick={() => {
                        setImageBrightness(100);
                        setImageContrast(100);
                        setImageSaturation(100);
                      }}
                      disabled={imageBrightness === 100 && imageContrast === 100 && imageSaturation === 100}
                    >
                      Reset
                    </Button>
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span>Brightness</span>
                      <span className="text-muted-foreground tabular-nums">{imageBrightness}%</span>
                    </div>
                    <Slider
                      value={[imageBrightness]}
                      min={0}
                      max={200}
                      step={1}
                      onValueChange={(v) => setImageBrightness(v[0])}
                    />
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span>Contrast</span>
                      <span className="text-muted-foreground tabular-nums">{imageContrast}%</span>
                    </div>
                    <Slider
                      value={[imageContrast]}
                      min={0}
                      max={200}
                      step={1}
                      onValueChange={(v) => setImageContrast(v[0])}
                    />
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span>Saturation</span>
                      <span className="text-muted-foreground tabular-nums">{imageSaturation}%</span>
                    </div>
                    <Slider
                      value={[imageSaturation]}
                      min={0}
                      max={200}
                      step={1}
                      onValueChange={(v) => setImageSaturation(v[0])}
                    />
                  </div>

                  <div className="text-[10px] text-muted-foreground">
                    Display-only — does not change the original image or annotations.
                  </div>
                </PopoverContent>
              </Popover>
            </div>

            {/* Minimap */}
            <AnnotationMinimap
              imageRef={imageRef}
              containerRef={containerRef}
              imageScale={imageScale}
              imageOffset={imageOffset}
              onNavigate={(offset) => setImageOffset(offset)}
            />
          </div>
            </ResizablePanel>
            {imageCollections.length > 1 && companionPanelOpen && (
              <>
                <ResizableHandle withHandle />
                <ResizablePanel defaultSize={30} minSize={15}>
                  {/* Companion layers — read-only side-by-side view of the same image
                      from other collections, with shared annotations overlaid. */}
                  <CompanionLayersPanel
                    collections={imageCollections}
                    primaryCollectionId={displayLayer || mainLayer}
                    primaryImage={displayImage || currentImage}
                    imageName={currentImageName}
                    datasetId={id ?? null}
                    annotations={annotations}
                    primaryCocoDims={currentImageName ? (getAnnotReferenceDimensions(currentImageName) ?? null) : null}
                    onClose={() => setCompanionPanelOpen(false)}
                    onPrev={() => goToImage(currentImageIndex - 1)}
                    onNext={() => goToImage(currentImageIndex + 1)}
                    canPrev={currentImageIndex > 0}
                    canNext={currentImageIndex < (currentLayerImageNames.length > 0 ? currentLayerImageNames.length : allImageNames.length) - 1}
                    onDuplicateChange={handleDuplicateCollectionIdsChange}
                  />
                </ResizablePanel>
              </>
            )}
            {imageCollections.length > 1 && !companionPanelOpen && (
              <button
                onClick={() => setCompanionPanelOpen(true)}
                className="absolute top-2 right-24 z-20 inline-flex items-center gap-1.5 text-xs font-medium rounded-md px-2 py-1 border border-border bg-card/90 backdrop-blur-sm hover:bg-accent shadow-sm"
                title="Show image collections"
              >
                <Layers className="h-3.5 w-3.5 text-primary" />
                Image collections
              </button>
            )}
          </ResizablePanelGroup>

          {/* Image Navigation — Primary layer Prev/Next, spans full bottom of main area */}
          <div className="p-3 bg-card border-t border-border">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-4 flex-wrap">
                {(() => {
                  const filteredList = navigableImageNames;
                  const posInFiltered = filteredList.findIndex(n => n === currentImageName);
                  const displayPos = posInFiltered === -1 ? currentImageIndex : posInFiltered;
                  const displayTotal = filteredList.length;
                  const atFirst = displayPos <= 0;
                  const atLast = displayPos >= displayTotal - 1;
                  return (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => navigateImage('prev')}
                        disabled={atFirst}
                        aria-label="Previous image (primary layer)"
                      >
                        <ChevronLeft className="h-4 w-4 mr-1" />
                        Previous
                      </Button>

                      <div className="flex items-center gap-2">
                        <span className="text-sm text-muted-foreground">
                          {displayPos + 1} / {displayTotal}
                        </span>
                        {classFilterName && (
                          <span className="text-xs text-primary inline-flex items-center gap-1">
                            <FilterIcon className="h-3 w-3" />
                            {classFilterName}
                          </span>
                        )}
                        {currentLayerImageNames.length > 0 && (
                          <span className="text-xs text-primary">
                            ({imageCollections.find(c => String(c.id) === mainLayer)?.name || 'layer'})
                          </span>
                        )}
                        {currentImageName && (
                          <span className="text-xs text-muted-foreground/70 truncate max-w-[260px]">
                            {currentImageName}
                          </span>
                        )}
                      </div>

                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => navigateImage('next')}
                        disabled={atLast}
                        aria-label="Next image (primary layer)"
                      >
                        Next
                        <ChevronRight className="h-4 w-4 ml-1" />
                      </Button>
                    </>
                  );
                })()}

                <Button
                  variant="secondary"
                  size="sm"
                  onClick={goToNextUnannotated}
                  disabled={
                    !!classFilterName ||
                    currentImageIndex === navigableImageNames.length - 1
                  }
                  aria-label="Next unannotated image"
                  title={
                    classFilterName
                      ? `Unavailable while filtering images by class: ${classFilterName}`
                      : 'Jump to the next image with no annotations'
                  }
                >
                  <SkipForward className="h-4 w-4 mr-1" />
                  Next unannotated
                </Button>

                {/* Primary layer selector — kept next to Prev/Next so user knows which layer they're navigating */}
                {imageCollections.length > 0 && (
                  <div className="flex items-center gap-2 pl-2 ml-2 border-l border-border">
                    <span className="text-sm text-muted-foreground">Primary layer:</span>
                    <Select value={displayLayer} onValueChange={handleLayerChange}>
                      <SelectTrigger className="w-48">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {imageCollections.map(collection => (
                          <SelectItem key={collection.id} value={String(collection.id)}>
                            {collection.name} ({collection.images.length} images)
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>

                    {!displayImage && currentImageName && displayLayer && (
                      <span className="text-xs text-yellow-500">
                        Image "{currentImageName}" not available in {imageCollections.find(c => String(c.id) === String(displayLayer))?.name || 'this layer'}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Status Bar */}
          <AnnotationStatusBar
            cursorPosition={cursorImagePosition}
            zoom={imageScale}
            imageWidth={imageRef.current?.naturalWidth || 0}
            imageHeight={imageRef.current?.naturalHeight || 0}
            annotationCount={annotations.length}
            currentImageIndex={currentImageIndex}
            totalImages={currentLayerImageNames.length > 0 ? currentLayerImageNames.length : allImageNames.length}
            hasUnsavedChanges={hasUnsavedChanges}
            isAutoSaving={isAutoSaving}
            activeTool={activeTool}
            annotationMode={annotationMode}
          />
        </div>

  {/* Right Sidebar - Annotations Panel (redesigned container) */}
        <div
           className="bg-card border-l border-border flex flex-col min-h-0 self-stretch overflow-hidden"
          style={{ width: rightCollapsed ? 0 : rightWidth, minWidth: rightCollapsed ? 0 : undefined }}
        >
          {/* Panel Header */}
          <div className="bg-card border-b border-border p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-2 h-2 bg-primary rounded-full"></div>
                <h2 className="text-sm font-semibold">Annotations Panel</h2>
              </div>
              <Button size="sm" variant="ghost" onClick={() => {
                setRightCollapsed(v => !v);
                setTimeout(() => { try { window.dispatchEvent(new Event('annotation-panel-resize-end')); } catch (err) {} }, 20);
              }}>
                {rightCollapsed ? <ChevronLeft className="w-4 h-4"/> : <ChevronRight className="w-4 h-4"/>}
              </Button>
            </div>
            
            {/* Navigation Layer selector removed — primary layer is now
                controlled from the bottom Image Navigation bar. */}
          </div>

          {/* Panel Content */}
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden bg-card">
            <Tabs value={activePanelTab} onValueChange={setActivePanelTab} className="flex flex-1 flex-col min-h-0 overflow-hidden">
              {/* Tab Navigation */}
              <div className="border-b border-border flex-shrink-0">
                <TabsList className="grid grid-cols-2 w-full bg-transparent border-0 p-1">
                  <TabsTrigger 
                    value="annotations" 
                    className="data-[state=active]:bg-accent data-[state=active]:text-foreground text-muted-foreground text-xs"
                  >
                    Annotations ({annotations.length})
                  </TabsTrigger>
                  <TabsTrigger 
                    value="statistics" 
                    className="data-[state=active]:bg-accent data-[state=active]:text-foreground text-muted-foreground text-xs"
                  >
                    Statistics
                  </TabsTrigger>
                </TabsList>
              </div>

              {/* Annotations Tab */}
              <TabsContent value="annotations" className="flex-1 flex flex-col min-h-0 h-0 overflow-hidden m-0 p-0 mt-0 data-[state=inactive]:hidden">
                <div className="flex-shrink-0 p-3 border-b border-border">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>Current Image Annotations</span>
                      <span className="bg-muted px-2 py-1 rounded">{annotations.length}</span>
                    </div>
                    {annotations.length > 0 && (
                      <Button
                        variant="destructive"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => setShowDeleteAllDialog(true)}
                        title="Delete all annotations for this image"
                      >
                        <Trash2 className="w-3 h-3 mr-1" />
                        Delete All
                      </Button>
                    )}
                  </div>
                </div>
                
                <div
                  ref={annotationListViewportRef}
                  className="flex-1 min-h-0 h-0 overflow-y-auto overflow-x-hidden overscroll-contain"
                >
                  <div className="p-3">
                  {annotations.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-32 text-center">
                      <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mb-3">
                        <Square className="w-6 h-6 text-muted-foreground" />
                      </div>
                      <p className="text-sm text-muted-foreground mb-1">No annotations yet</p>
                      <p className="text-xs text-muted-foreground/70">Select a class and start drawing!</p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {annotations.map((annotation, index) => {
                        return (
                        <div 
                          key={annotation.id}
                          ref={(node) => {
                            if (node) annotationItemRefs.current.set(annotation.id, node);
                            else annotationItemRefs.current.delete(annotation.id);
                          }}
                          data-annotation-id={annotation.id}
                          className={`group border rounded-lg p-3 cursor-pointer transition-all duration-200 ${
                            selectedAnnotation === annotation.id 
                              ? 'border-primary bg-primary/10 shadow-lg shadow-primary/20' 
                              : 'border-border bg-muted/50 hover:border-muted-foreground/30 hover:bg-muted'
                          }`}
                          onClick={() => {
                            console.log('Card clicked, setting selectedAnnotation to:', annotation.id);
                            setSelectedAnnotation(annotation.id);
                          }}
                        >
                          <div className="flex items-start justify-between">
                            {/* Left side - Color indicator and content */}
                            <div className="flex items-start gap-3 flex-1 min-w-0">
                              <div 
                                className="w-4 h-4 rounded-md border border-border flex-shrink-0 mt-0.5"
                                style={{ backgroundColor: resolveAnnotationDisplayColor(annotation, classes) ?? annotation.color }}
                              />
                              <div className="flex-1 min-w-0">
                                {editingAnnotationId === annotation.id ? (
                                  <div className="space-y-2">
                                    <Select value={editingAnnotationLabel || ''} onValueChange={(v) => setEditingAnnotationLabel(v)}>
                                      <SelectTrigger className="w-full h-8 text-sm bg-muted border-border">
                                        <SelectValue placeholder="Select class" />
                                      </SelectTrigger>
                                      <SelectContent>
                                        {classes.map(c => (
                                          <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                    <div className="flex justify-end gap-1">
                                      <Button 
                                        size="sm" 
                                        className="h-7 px-2 text-xs"
                                        onClick={() => { 
                                          saveAnnotationLabel(annotation.id, editingAnnotationLabel); 
                                          setEditingAnnotationId(null); 
                                        }}
                                      >
                                        Save
                                      </Button>
                                      <Button 
                                        size="sm" 
                                        variant="outline" 
                                        className="h-7 px-2 text-xs"
                                        onClick={() => setEditingAnnotationId(null)}
                                      >
                                        Cancel
                                      </Button>
                                    </div>
                                  </div>
                                ) : (
                                  <div>
                                    <p 
                                      className="text-sm font-medium cursor-pointer hover:text-foreground transition-colors truncate"
                                      onClick={(e) => { 
                                        e.stopPropagation(); 
                                        setEditingAnnotationId(annotation.id); 
                                        const cls = classes.find(c => c.name === annotation.label); 
                                        setEditingAnnotationLabel(cls ? cls.id : ''); 
                                      }}
                                    >
                                      #{index + 1} {annotation.label}
                                    </p>
                                    <div className="flex items-center gap-2 mt-1">
                                      {annotation.type === 'polygon' && annotation.points && annotation.points.length >= 3 && (
                                        <span className="text-xs text-primary" title="Area in image coordinates">
                                          Area: {formatArea(calculatePolygonArea(annotation.points))}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                )}
                              </div>
                            </div>

                            {/* Right side - Action buttons */}
                            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="w-7 h-7 p-0 hover:bg-muted"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setAnnotations(prev => prev.map(a => 
                                    a.id === annotation.id 
                                      ? { ...a, visible: !a.visible }
                                      : a
                                  ));
                                  setHasUnsavedChanges(true);
                                }}
                                title={annotation.visible ? "Hide annotation" : "Show annotation"}
                              >
                                {annotation.visible ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="w-7 h-7 p-0 hover:bg-muted"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setEditingAnnotationId(annotation.id);
                                  const cls = classes.find(c => c.name === annotation.label);
                                  setEditingAnnotationLabel(cls ? cls.id : '');
                                }}
                                title="Edit annotation"
                              >
                                <Edit className="w-3 h-3" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="w-7 h-7 p-0 hover:bg-red-600/20 hover:text-red-400"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  requestDeleteAnnotation(annotation.id);
                                }}
                                title="Delete annotation"
                              >
                                <Trash2 className="w-3 h-3" />
                              </Button>
                            </div>
                          </div>
                        </div>
                        );
                      })}
                    </div>
                  )}
                  </div>
                </div>
              </TabsContent>

              {/* Statistics Tab */}
              <TabsContent value="statistics" className="flex-1 flex flex-col min-h-0 overflow-hidden m-0 p-0 mt-0 data-[state=inactive]:hidden">
                <ScrollArea className="flex-1 min-h-0">
                  <div className="p-3">
                    {classes.length === 0 ? (
                      <div className="flex flex-col items-center justify-center h-32 text-center">
                        <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mb-3">
                          <BarChart className="w-6 h-6 text-muted-foreground" />
                        </div>
                        <p className="text-sm text-muted-foreground">No classes defined yet</p>
                      </div>
                    ) : activePanelTab === 'statistics' ? (
                      <Suspense
                        fallback={
                          <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                            Loading charts…
                          </div>
                        }
                      >
                        <AnnotationStatisticsCharts
                          classes={annotationStatistics.stats}
                          total={annotationStatistics.total}
                          hasUnsavedChanges={hasUnsavedChanges}
                          unsavedAnnotationCount={annotations.length}
                        />
                      </Suspense>
                    ) : null}
                  </div>
                </ScrollArea>
              </TabsContent>
            </Tabs>
          </div>

          {/* Side panels are no longer resizable — toggle only. */}
        </div>

        {/* Floating expand button when sidebar is collapsed */}
        {rightCollapsed && (
          <div className="absolute right-2 top-1/2 -translate-y-1/2 z-50">
              <Button
                size="sm"
                onClick={() => {
                  setRightCollapsed(false);
                  setTimeout(() => { try { window.dispatchEvent(new Event('annotation-panel-resize-end')); } catch (err) {} }, 20);
                }}
                aria-label="Expand right panel"
                className="bg-primary text-primary-foreground hover:bg-primary/90 shadow-lg rounded-full p-1"
              >
                <ChevronLeft className="w-4 h-4 rotate-180" />
              </Button>
          </div>
        )}
      </div>

      {/* Apply on all images: full-screen overlay so user cannot click elsewhere; cancel stays active */}
      {isApplyingAllImages && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60"
          aria-modal="true"
          role="dialog"
          aria-label="Apply SAM 3 on all images in progress"
        >
          <div className="bg-gray-800 border border-gray-600 rounded-lg shadow-xl px-6 py-4 flex flex-col items-center gap-4 min-w-[280px]">
            <Loader2 className="w-8 h-8 animate-spin text-white" />
            {applyAllProgress && (
              <p className="text-sm text-white">
                Applying {applyAllProgress.current} / {applyAllProgress.total} images
              </p>
            )}
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                applyAllCancelledRef.current = true;
              }}
            >
              <X className="w-4 h-4 mr-2" />
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Save Annotation File Dialog */}
      <Dialog open={showSaveDialog} onOpenChange={setShowSaveDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Save Annotation File</DialogTitle>
            <DialogDescription>
              Enter a name for your annotation file. All annotations from all images will be saved.
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="annotation-name">Annotation File Name</Label>
              <Input
                id="annotation-name"
                placeholder="e.g., my_segmentation_annotations"
                value={saveAnnotationName}
                onChange={(e) => setSaveAnnotationName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && saveAnnotationName.trim()) {
                    handleSaveAnnotationFile();
                  }
                }}
                autoFocus
              />
              <p className="text-xs text-muted-foreground">
                .json extension will be added automatically if not provided
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowSaveDialog(false);
                setSaveAnnotationName('');
                navigateAfterSaveRef.current = false;
                pendingNavigationRef.current = null;
              }}
              disabled={isSavingAnnotation}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSaveAnnotationFile}
              disabled={!saveAnnotationName.trim() || isSavingAnnotation}
            >
              {isSavingAnnotation ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Save className="w-4 h-4 mr-2" />
                  Save
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Leave confirmation dialog */}
      <AlertDialog open={showLeaveDialog} onOpenChange={setShowLeaveDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unsaved Changes</AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved annotation changes. Would you like to save before leaving?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => {
              setShowLeaveDialog(false);
              pendingNavigationRef.current = null;
            }}>
              Cancel
            </AlertDialogCancel>
            <Button variant="destructive" onClick={() => handleLeaveConfirm(false)}>
              Discard
            </Button>
            <AlertDialogAction onClick={() => handleLeaveConfirm(true)}>
              <Save className="w-4 h-4 mr-2" />
              Save & Leave
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete All Annotations Confirmation Dialog */}
      <AlertDialog open={showDeleteAllDialog} onOpenChange={setShowDeleteAllDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete All Annotations?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete all {annotations.length} annotation{annotations.length !== 1 ? 's' : ''} for image "{currentImageName}"?
              <br />
              <span className="text-destructive font-medium">This action cannot be undone.</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              Cancel
            </AlertDialogCancel>
            <Button variant="destructive" onClick={deleteCurrentImageAnnotations}>
              Delete All
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Single Annotation Confirmation Dialog */}
      <AlertDialog
        open={showDeleteAnnotationDialog}
        onOpenChange={(open) => {
          setShowDeleteAnnotationDialog(open);
          if (!open) setPendingDeleteAnnotationId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Annotation?</AlertDialogTitle>
            <AlertDialogDescription>
              This will delete the selected annotation from image "{currentImageName}".
              <br />
              <span className="text-destructive font-medium">This action cannot be undone.</span>
            </AlertDialogDescription>
          </AlertDialogHeader>

          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={skipDeleteAnnotationConfirm}
              onChange={(e) => setSkipDeleteAnnotationConfirm(e.target.checked)}
            />
            Don't ask again
          </label>

          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                setShowDeleteAnnotationDialog(false);
                setPendingDeleteAnnotationId(null);
              }}
            >
              Cancel
            </AlertDialogCancel>
            <Button variant="destructive" onClick={confirmDeleteAnnotation}>
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={showDeleteClassDialog}
        onOpenChange={(open) => {
          setShowDeleteClassDialog(open);
          if (!open) setPendingDeleteClassId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Class?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDeleteClassId && (() => {
                const pendingClass = classes.find((annotationClass) => annotationClass.id === pendingDeleteClassId);
                if (!pendingClass) return 'This will remove the selected class from this session.';
                const annotationCount = globalStats[pendingClass.name] ?? 0;
                const imageCount = classImageMap[pendingClass.name]?.size ?? 0;
                return annotationCount > 0
                  ? `This will delete class "${pendingClass.name}" and remove ${annotationCount} annotation(s) across ${imageCount} image(s) in the current session.`
                  : `This will delete class "${pendingClass.name}" from the current session.`;
              })()}
              <br />
              <span className="text-destructive font-medium">This action cannot be undone.</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                setShowDeleteClassDialog(false);
                setPendingDeleteClassId(null);
              }}
            >
              Cancel
            </AlertDialogCancel>
            <Button variant="destructive" onClick={confirmDeleteClass}>
              Delete Class
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </div>
  );
};

export default ImageAnnotation;
