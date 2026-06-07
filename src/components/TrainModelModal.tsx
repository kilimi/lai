import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { Brain, Database, Settings, Trash2, Plus, Image, FileText, Wand2, Check, ChevronDown, ChevronRight, Info, AlertCircle, ArrowLeft, ArrowRight, Sliders } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Dataset, DatasetGroup } from "@/types";
import {
  DatasetEvalPicker,
  type DatasetSelection as PickerDatasetSelection,
  type PickerDataset,
  type PickerGroup,
} from "@/components/DatasetEvalPicker";
import { YoloSettingsDialog } from "./YoloSettingsDialog";
import { RFDETRSettingsDialog } from "./RFDETRSettingsDialog";
import { MMYOLOSettingsDialog } from "./MMYOLOSettingsDialog";
import { TrainingStartedDialog } from "./TrainingStartedDialog";
import { resolveBackendMediaUrl } from "@/config/api";
import { useApi } from '@/hooks/use-api';
import { useToast } from "@/hooks/use-toast";
import { toast as sonnerToast } from 'sonner';
import { buildYoloModelSize, parseYoloPresetFromModelType, rtdetrVariantFromStored } from '@/utils/trainingCloneSettings';
import {
  filterAnnotationFilesForTrainingTask,
  mapAnnotationFileForTrainingPicker,
} from '@/utils/annotations';
import type { PickerAnnotationFile } from '@/components/DatasetEvalPicker';

function mapApiAnnotationToPickerFile(ann: any): PickerAnnotationFile {
  const mapped = mapAnnotationFileForTrainingPicker({
    id: ann.id || ann.name,
    name: ann.name,
    type: ann.type || ann.annotation_type || ann.format || ann.file_type || ann.kind,
    created_at: ann.created_at || ann.updated_at,
  });
  return {
    id: mapped.id,
    name: mapped.name,
    classes: [],
    taskType: mapped.taskType,
    annotationType: mapped.annotationType,
    modifiedAt: mapped.modifiedAt,
    annotationCount: ann.annotation_count,
  };
}

interface TrainModelModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  datasets?: Dataset[];
  datasetGroups?: DatasetGroup[];
  /** When true, datasets/groups are still loading after the dialog opened */
  resourcesLoading?: boolean;
  projectId: string;
  /** When set with `open`, load this task's saved training settings into the form (does not start training). */
  cloneFromTaskId?: number | null;
  /** Default task to preselect when the modal opens. */
  defaultTask?: TrainTask;
}

interface DatasetSelection {
  id: string;
  dataset: Dataset;
  imageCollection: string;
  // annotation stores the annotation file id (string) when selected
  annotation: string;
  imageCollections: string[];
  annotations: Array<{ id: string; name: string; type?: string }>;
  loadingCollections: boolean;
  loadingAnnotations: boolean;
  fromGroup?: boolean;
  groupName?: string;
  // percentage split for train/val/test (sum to 100)
  split?: {
    train: number;
    val: number;
    test: number;
  };
}

interface ModelConfig {
  type: 'yolo' | 'rf-detr' | 'mmyolo';
  settings: any;
}

type TrainTask = 'detect' | 'segment' | 'oriented' | 'classify';
type DeployTarget = 'general' | 'edge-drone';

const TASK_LABELS: Record<TrainTask, string> = {
  detect: 'Detection (boxes)',
  segment: 'Segmentation (masks)',
  oriented: 'Oriented boxes (rotated)',
  classify: 'Classification',
};

const DEPLOY_LABELS: Record<DeployTarget, string> = {
  general: 'General purpose',
  'edge-drone': 'DJI Drone',
};

/** Per-architecture sizes — aligned with install/foundation_models and AutoAnnotateModal. */
const YOLO_TRAIN_SIZES: Record<string, string[]> = {
  yolo8: ['n', 's', 'm', 'l', 'x'],
  yolo11: ['n', 's', 'm', 'l', 'x'],
  yolo26: ['n', 's', 'm', 'l', 'x'],
};

const YOLO_VERSION_LABEL: Record<string, string> = {
  yolo8: 'YOLOv8',
  yolov8: 'YOLOv8',
  yolo11: 'YOLOv11',
  yolo26: 'YOLO26',
};

function normalizeYoloVersion(version: string): string {
  const v = (version || '').toLowerCase();
  if (v === 'yolo8') return 'yolov8';
  if (v === 'yolo_nas' || v === 'yolonas') return 'yolo11';
  return version;
}

const MMYOLO_SIZES = ['tiny', 's', 'm', 'l', 'x'] as const;

const LABEL_FOR_SIZE: Record<string, string> = {
  n: 'Nano',
  tiny: 'Tiny',
  s: 'Small',
  m: 'Medium',
  l: 'Large',
  x: 'X-Large',
};

/** Which families support which task. */
const FAMILY_SUPPORTS: Record<'yolo' | 'rf-detr' | 'mmyolo', TrainTask[]> = {
  yolo: ['detect', 'segment', 'classify'],
  'rf-detr': ['detect'],
  mmyolo: ['detect', 'segment', 'oriented'],
};

/** Pick the recommended family for (task, deploy). */
function recommendedFamily(task: TrainTask, deploy: DeployTarget): 'yolo' | 'rf-detr' | 'mmyolo' {
  if (deploy === 'edge-drone') return 'mmyolo';
  if (task === 'oriented') return 'mmyolo';
  if (task === 'classify') return 'yolo';
  return 'yolo';
}

/** MMYOLO architectures available per task (backend-validated set). */
const MMYOLO_ARCHS_BY_TASK: Record<TrainTask, { id: string; label: string }[]> = {
  detect: [
    { id: 'yolov8', label: 'YOLOv8 (DJI-compatible)' },
    { id: 'rtmdet', label: 'RTMDet' },
    { id: 'rtmdet-ins', label: 'RTMDet-Ins' },
    { id: 'rtmdet-r', label: 'RTMDet-Rotated' },
  ],
  segment: [
    { id: 'yolov8', label: 'YOLOv8' },
    { id: 'rtmdet-ins', label: 'RTMDet-Ins' },
    { id: 'rtmdet', label: 'RTMDet' },
    { id: 'rtmdet-r', label: 'RTMDet-Rotated' },
  ],
  oriented: [
    { id: 'rtmdet-r', label: 'RTMDet-Rotated' },
    { id: 'rtmdet', label: 'RTMDet' },
    { id: 'rtmdet-ins', label: 'RTMDet-Ins' },
  ],
  classify: [],
};

function mmyoloArchsForTask(task: TrainTask) {
  return MMYOLO_ARCHS_BY_TASK[task] ?? [];
}

/** Default MMYOLO architecture id for a task + optional deploy target. */
function defaultMmyoloArchForTask(task: TrainTask, deploy?: DeployTarget): string {
  if (deploy === 'edge-drone') return 'yolov8';
  const opts = mmyoloArchsForTask(task);
  return opts[0]?.id ?? 'rtmdet';
}

function mmyoloArchLabel(id: string, task?: TrainTask): string {
  if (task) {
    const taskHit = MMYOLO_ARCHS_BY_TASK[task]?.find(a => a.id === id);
    if (taskHit) return taskHit.label;
  }
  for (const list of Object.values(MMYOLO_ARCHS_BY_TASK)) {
    const hit = list.find(a => a.id === id);
    if (hit) return hit.label;
  }
  return id;
}


export function TrainModelModal({ open, onOpenChange, datasets = [], datasetGroups = [], resourcesLoading = false, projectId, cloneFromTaskId = null, defaultTask }: TrainModelModalProps) {
  const { api } = useApi();
  const { toast } = useToast();
  const [selectedDatasets, setSelectedDatasets] = useState<DatasetSelection[]>([]);
  const [selectedModel, setSelectedModel] = useState<ModelConfig['type'] | null>(null);
  const [selectedTask, setSelectedTask] = useState<TrainTask>(defaultTask || 'detect');
  const requiredAnnotationTaskType: 'detection' | 'segmentation' | 'classification' | 'oriented' =
    selectedTask === 'segment' ? 'segmentation'
    : selectedTask === 'classify' ? 'classification'
    : selectedTask === 'oriented' ? 'oriented'
    : 'detection';
  const [deployTarget, setDeployTarget] = useState<DeployTarget>('general');
  const [modelSettings, setModelSettings] = useState<any>({});

  const [showYoloSettings, setShowYoloSettings] = useState(false);
  const [showRFDETRSettings, setShowRFDETRSettings] = useState(false);
  const [showMMYOLOSettings, setShowMMYOLOSettings] = useState(false);
  const [isTraining, setIsTraining] = useState(false);
  const [showClassDialog, setShowClassDialog] = useState(false);
  const [classStats, setClassStats] = useState<any | null>(null);
  const [customName, setCustomName] = useState('');
  const [step, setStep] = useState<1 | 2 | 3>(1);

  // Class conflict checker state (Step 1, multi-dataset)
  const [conflictLoading, setConflictLoading] = useState(false);
  const [conflictReport, setConflictReport] = useState<null | {
    perDataset: Array<{ datasetId: number; datasetName: string; classes: string[] }>;
    shared: string[];
    onlyIn: Record<string, string[]>;
  }>(null);

  // Invalidate the conflict report whenever the selected datasets or their annotations change.
  useEffect(() => { setConflictReport(null); }, [JSON.stringify(selectedDatasets.map(s => `${s.dataset.id}:${s.annotation}`))]);
  
  // Track mount state and active fetch operations
  const isMountedRef = useRef(true);
  const activeFetchesRef = useRef<Map<string, AbortController>>(new Map());
  
  // Unique ID counter for generating collision-free IDs
  const idCounterRef = useRef(0);
  const [datasetAnnotationFiles, setDatasetAnnotationFiles] = useState<
    Map<number, PickerAnnotationFile[]>
  >(new Map());

  // Preload annotation file metadata (with types) for all datasets when training opens.
  useEffect(() => {
    if (!open || !api || datasets.length === 0) return;
    datasets.forEach((dataset) => {
      void (async () => {
        try {
          const response = await api.getAnnotations(dataset.id);
          if (!response.success || !response.data) return;
          const files = response.data.map(mapApiAnnotationToPickerFile);
          setDatasetAnnotationFiles((prev) => new Map(prev).set(dataset.id, files));
        } catch (error) {
          console.error(`Error preloading annotations for dataset ${dataset.id}:`, error);
        }
      })();
    });
  }, [open, datasets, api]);

  // Training started dialog state
  const [showTrainingStarted, setShowTrainingStarted] = useState(false);
  const [trainingInfo, setTrainingInfo] = useState<{
    taskId: string;
    modelName: string;
    datasetsCount: number;
    epochs: number;
    weightsDownloadNotice?: string;
  }>({
    taskId: '',
    modelName: '',
    datasetsCount: 0,
    epochs: 0
  });

  const [modelsCatalog, setModelsCatalog] = useState<Array<{ id: string; display_name: string }>>([]);

  useEffect(() => {
    if (!open) return;
    api.getModelsCatalog().then((res) => {
      const data = res.data || res;
      const backends = (data as { backends?: Array<{ id: string; display_name: string }> }).backends;
      if (backends?.length) {
        setModelsCatalog(backends.map((b) => ({ id: b.id, display_name: b.display_name })));
      }
    }).catch(() => {
      /* catalog is optional; UI still uses local model family presets */
    });
  }, [open, api]);

  const yoloVersion = normalizeYoloVersion(modelSettings.version || 'yolo11');
  const allowedYoloSizes = YOLO_TRAIN_SIZES[yoloVersion] || YOLO_TRAIN_SIZES.yolo11;
  useEffect(() => {
    const normalizedVersion = normalizeYoloVersion(modelSettings.version || 'yolo11');
    const allowed = YOLO_TRAIN_SIZES[normalizedVersion] || YOLO_TRAIN_SIZES.yolo11;
    const sz = modelSettings.size || 'n';
    if (!allowed.includes(sz)) {
      setModelSettings((prev: any) => ({ ...prev, size: allowed[0] }));
    }
  }, [modelSettings.version, modelSettings.size]);

  // Reset model selection & settings when the user changes deploy target or task
  const configResetInitRef = useRef(false);
  useEffect(() => {
    if (!configResetInitRef.current) {
      configResetInitRef.current = true;
      return;
    }
    setSelectedModel(null);
    setModelSettings({});
    setShowYoloSettings(false);
    setShowRFDETRSettings(false);
    setShowMMYOLOSettings(false);
  }, [deployTarget, selectedTask]);

  // Drop incompatible ground-truth files when the training task changes.
  useEffect(() => {
    setSelectedDatasets((prev) =>
      prev.map((sel) => {
        const compatible = filterAnnotationFilesForTrainingTask(
          sel.annotations.map((a) =>
            mapAnnotationFileForTrainingPicker({
              id: a.id,
              name: a.name,
              type: a.type,
              created_at: (a as { created_at?: string }).created_at,
            }),
          ),
          requiredAnnotationTaskType,
        );
        const nextAnnotations = compatible.map((a) => ({
          id: a.id,
          name: a.name,
          type: a.annotationType,
          created_at: a.modifiedAt ?? null,
        }));
        const annotationStillValid = compatible.some((a) => a.id === sel.annotation);
        return {
          ...sel,
          annotations: nextAnnotations,
          annotation: annotationStillValid
            ? sel.annotation
            : compatible[0]?.id ?? '',
        };
      }),
    );
  }, [requiredAnnotationTaskType]);

  // DJI mode policy: only MMYOLO YOLOv8 Detection is allowed in GUI.
  useEffect(() => {
    if (deployTarget !== 'edge-drone') return;
    setSelectedModel('mmyolo');
    setSelectedTask('detect');
    setModelSettings((prev: any) => ({
      ...prev,
      mmyoloArch: 'yolov8',
      mmyoloSize: prev.mmyoloSize || 's',
    }));
  }, [deployTarget]);


  // Dataset settings
  const [removeImagesWithoutAnnotations, setRemoveImagesWithoutAnnotations] = useState(true);

  // Weights & Biases settings
  const [saveToWandb, setSaveToWandb] = useState(false);
  const [showWandbSettings, setShowWandbSettings] = useState(false);
  const [wandbSettings, setWandbSettings] = useState({
    apiKey: '',
    project: '',
    entity: ''
  });
  const [djiPatchUploading, setDjiPatchUploading] = useState(false);
  const [djiPatch, setDjiPatch] = useState<null | {
    name: string;
    path: string;
    uploadedAt?: string;
  }>(null);

  // Fetch image collections for a specific dataset selection
  const fetchDataForSelection = async (selectionId: string, datasetId: number) => {
    if (!api || !isMountedRef.current) return;
    
    // Cancel any existing fetch for this selection
    const existingController = activeFetchesRef.current.get(selectionId);
    if (existingController) {
      existingController.abort();
    }
    
    // Create new abort controller for this fetch
    const abortController = new AbortController();
    activeFetchesRef.current.set(selectionId, abortController);
    
    // Update loading state for this selection
    if (isMountedRef.current) {
      setSelectedDatasets(prev => prev.map(sel => 
        sel.id === selectionId 
          ? { ...sel, loadingCollections: true, loadingAnnotations: true }
          : sel
      ));
    }
    
    try {
      // Fetch image collections
      const collectionsResponse = await api.getImageCollections(datasetId);
      
      // Check if fetch was aborted or component unmounted
      if (abortController.signal.aborted || !isMountedRef.current) return;
      
      const collections = collectionsResponse.success && collectionsResponse.data 
        ? collectionsResponse.data.map((col: any) => col.name)
        : [];
      
      // Fetch annotations
      const annotationsResponse = await api.getAnnotations(datasetId);
      
      // Check again if fetch was aborted or component unmounted
      if (abortController.signal.aborted || !isMountedRef.current) return;
      
      const annotations = annotationsResponse.success && annotationsResponse.data
        ? annotationsResponse.data.map((ann: any) => {
            const mapped = mapApiAnnotationToPickerFile(ann);
            return {
              id: mapped.id,
              name: mapped.name,
              created_at: mapped.modifiedAt || null,
              type: mapped.annotationType,
            };
          })
        : [];

      if (isMountedRef.current && annotationsResponse.data) {
        setDatasetAnnotationFiles((prev) =>
          new Map(prev).set(datasetId, annotationsResponse.data!.map(mapApiAnnotationToPickerFile)),
        );
      }

      const compatibleForTask = filterAnnotationFilesForTrainingTask(
        annotations.map((a) => ({
          id: a.id,
          name: a.name,
          type: a.type,
          annotationType: a.type,
        })),
        requiredAnnotationTaskType,
      );

      // Update the selection with fetched data and auto-select best defaults
      if (isMountedRef.current) {
        setSelectedDatasets(prev => prev.map(sel => {
          if (sel.id === selectionId) {
            const updatedSel = {
              ...sel,
              imageCollections: collections,
              annotations,
              loadingCollections: false,
              loadingAnnotations: false,
            };

            const isImageCollectionValid =
              updatedSel.imageCollection && collections.includes(updatedSel.imageCollection);
            if (!isImageCollectionValid && collections.length > 0) {
              updatedSel.imageCollection = collections[0];
            }

            const isAnnotationValid =
              updatedSel.annotation &&
              compatibleForTask.some((a) => a.id === updatedSel.annotation);
            if (!isAnnotationValid && compatibleForTask.length > 0) {
              const sorted = [...compatibleForTask].sort((a, b) => {
                const aDate = annotations.find((x) => x.id === a.id)?.created_at;
                const bDate = annotations.find((x) => x.id === b.id)?.created_at;
                if (!aDate && !bDate) return 0;
                if (!aDate) return 1;
                if (!bDate) return -1;
                return new Date(bDate).getTime() - new Date(aDate).getTime();
              });
              updatedSel.annotation = sorted[0].id;
            } else if (updatedSel.annotation && !isAnnotationValid) {
              updatedSel.annotation = '';
            }

            return updatedSel;
          }
          return sel;
        }));
      }
    } catch (error) {
      // Don't update state if aborted or unmounted
      if (abortController.signal.aborted || !isMountedRef.current) return;
      
      console.error('Error fetching data for selection:', error);
      if (isMountedRef.current) {
        setSelectedDatasets(prev => prev.map(sel => 
          sel.id === selectionId 
            ? { 
                ...sel, 
                imageCollections: [],
                annotations: [],
                loadingCollections: false,
                loadingAnnotations: false
              }
            : sel
        ));
      }
    } finally {
      // Clean up the abort controller
      activeFetchesRef.current.delete(selectionId);
    }
  };

  const addDatasetSelection = () => {
    if (datasets.length === 0) return;
    
    // Generate collision-free unique ID
    idCounterRef.current += 1;
    const uniqueId = `dataset-${Date.now()}-${idCounterRef.current}-${Math.random().toString(36).slice(2, 11)}`;
    
    const newSelection: DatasetSelection = {
      id: uniqueId,
      dataset: datasets[0],
  imageCollection: '',
  annotation: '',
      imageCollections: [],
      annotations: [],
      loadingCollections: false,
      loadingAnnotations: false,
  split: { train: 80, val: 20, test: 0 },
    };
    
    setSelectedDatasets([...selectedDatasets, newSelection]);
    
    // Fetch data for the newly selected dataset
    fetchDataForSelection(newSelection.id, datasets[0].id);
  };

  const addDatasetGroupSelection = (group: DatasetGroup) => {
    if (!group.datasets || group.datasets.length === 0) return;
    
    // Create selections for all datasets in the group with unique IDs
    const timestamp = Date.now();
    const newSelections: DatasetSelection[] = group.datasets.map((dataset, index) => {
      idCounterRef.current += 1;
      return {
        id: `group-${timestamp}-${idCounterRef.current}-${index}-${Math.random().toString(36).slice(2, 11)}`,
        dataset: dataset,
    imageCollection: '',
    annotation: '',
        imageCollections: [],
        annotations: [],
        loadingCollections: false,
        loadingAnnotations: false,
        fromGroup: true,
        groupName: group.name,
    split: { train: 80, val: 20, test: 0 },
      };
    });
    
    setSelectedDatasets([...selectedDatasets, ...newSelections]);
    
    // Fetch data for all newly selected datasets with rate limiting (250ms delay between fetches)
    newSelections.forEach((selection, index) => {
      setTimeout(() => {
        if (isMountedRef.current) {
          fetchDataForSelection(selection.id, selection.dataset.id);
        }
      }, index * 250);
    });
  };

  const removeDatasetSelection = (id: string) => {
    setSelectedDatasets(selectedDatasets.filter(sel => sel.id !== id));
  };

  const updateDatasetSelection = (id: string, field: keyof Omit<DatasetSelection, 'id' | 'imageCollections' | 'annotations' | 'loadingCollections' | 'loadingAnnotations'>, value: any) => {
    setSelectedDatasets(selectedDatasets.map(sel => {
      if (sel.id === id) {
        const updated = { ...sel, [field]: value };
        
        // If dataset changed, fetch new collections and annotations
        if (field === 'dataset' && value) {
          fetchDataForSelection(id, value.id);
        }
        
        return updated;
      }
      return sel;
    }));
  };

  // ── Picker integration ────────────────────────────────────────────────────
  const pickerDatasets: PickerDataset[] = useMemo(() => {
    return datasets.map(d => {
      const cachedFiles = datasetAnnotationFiles.get(d.id) ?? [];
      const sel = selectedDatasets.find(s => s.dataset.id === d.id);
      const annotationFiles: PickerAnnotationFile[] =
        cachedFiles.length > 0
          ? cachedFiles
          : (d.annotation_files || []).map((f) =>
              mapApiAnnotationToPickerFile({
                id: f.id,
                name: f.name || f.file_name,
                type: f.type,
                created_at: f.created_at,
                annotation_count: f.annotation_count,
              }),
            );
      const collections = sel
        ? sel.imageCollections.map(c => ({ id: c, name: c }))
        : [];
      return {
        id: d.id,
        name: d.name,
        description: d.description || undefined,
        imageCount: d.image_count ?? 0,
        annotationFileCount: d.annotation_file_count ?? annotationFiles.length,
        thumbnailUrl: resolveBackendMediaUrl(d.thumbnailUrl) ?? d.thumbnailUrl,
        annotationFiles,
        collections,
        tags: d.tags,
      };
    });
  }, [datasets, selectedDatasets, datasetAnnotationFiles]);

  const pickerGroups: PickerGroup[] = useMemo(
    () => datasetGroups.map(g => ({
      id: g.id,
      name: g.name,
      datasetIds: (g.datasets || []).map(d => d.id),
    })),
    [datasetGroups]
  );

  const pickerValue: PickerDatasetSelection[] = useMemo(
    () => selectedDatasets.map(s => ({
      datasetId: s.dataset.id,
      annotationFileId: s.annotation || null,
      collectionId: s.imageCollection || null,
    })),
    [selectedDatasets]
  );

  const handlePickerChange = (next: PickerDatasetSelection[]) => {
    const prevById = new Map(selectedDatasets.map(s => [s.dataset.id, s]));
    const nextById = new Map(next.map(s => [s.datasetId, s]));

    // Build new selectedDatasets list
    const updated: DatasetSelection[] = [];
    next.forEach(n => {
      const existing = prevById.get(n.datasetId);
      if (existing) {
        updated.push({
          ...existing,
          annotation: n.annotationFileId ?? '',
          imageCollection: n.collectionId ?? '',
        });
      } else {
        const dataset = datasets.find(d => d.id === n.datasetId);
        if (!dataset) return;
        idCounterRef.current += 1;
        const newSel: DatasetSelection = {
          id: `dataset-${Date.now()}-${idCounterRef.current}-${Math.random().toString(36).slice(2, 9)}`,
          dataset,
          imageCollection: n.collectionId ?? '',
          annotation: n.annotationFileId ?? '',
          imageCollections: [],
          annotations: [],
          loadingCollections: false,
          loadingAnnotations: false,
          split: { train: 80, val: 20, test: 0 },
        };
        updated.push(newSel);
        // Lazy-load collections + annotations
        setTimeout(() => {
          if (isMountedRef.current) fetchDataForSelection(newSel.id, dataset.id);
        }, 0);
      }
    });

    // Cleanup abort controllers for removed selections
    selectedDatasets.forEach(s => {
      if (!nextById.has(s.dataset.id)) {
        const ctrl = activeFetchesRef.current.get(s.id);
        if (ctrl) ctrl.abort();
        activeFetchesRef.current.delete(s.id);
      }
    });

    setSelectedDatasets(updated);
  };

  const handleModelSettingsUpdate = (settings: any) => {
    if (deployTarget === 'edge-drone') {
      setModelSettings({ ...settings, mmyoloArch: 'yolov8' });
      return;
    }
    setModelSettings(settings);
  };

  // ── Step 1 helpers: live training summary + class conflict checker ────────
  const trainingSummary = useMemo(() => {
    let totalImages = 0;
    let train = 0;
    let val = 0;
    let test = 0;
    selectedDatasets.forEach(sel => {
      const n = sel.dataset.image_count ?? 0;
      totalImages += n;
      const s = sel.split || { train: 80, val: 20, test: 0 };
      train += Math.round(n * s.train / 100);
      val += Math.round(n * s.val / 100);
      test += Math.round(n * s.test / 100);
    });
    const warnings: string[] = [];
    if (selectedDatasets.length === 0) warnings.push('No datasets selected yet.');
    if (selectedDatasets.some(s => !s.imageCollection)) warnings.push('Image collection missing on at least one dataset.');
    if (selectedDatasets.some(s => !s.annotation)) warnings.push('Annotation file missing on at least one dataset.');
    if (val === 0 && selectedDatasets.length > 0) warnings.push('Validation split is 0% — training cannot evaluate.');
    return { totalImages: Math.round(totalImages), train, val, test, warnings };
  }, [selectedDatasets]);

  // Count total unique classes across all selected datasets
  const [totalClassCount, setTotalClassCount] = useState<number | null>(null);
  const [classCountLoading, setClassCountLoading] = useState(false);

  const countTotalClasses = async () => {
    if (!api || selectedDatasets.length === 0) return;
    setClassCountLoading(true);
    try {
      const allClasses = new Set<string>();
      for (const sel of selectedDatasets) {
        if (!sel.annotation) continue;
        try {
          const res = await api.getAnnotationClasses(sel.dataset.id, sel.annotation);
          const stats = (res && (res as any).success) ? (res as any).data : null;
          const classes: string[] = stats && stats.classes
            ? Object.keys(stats.classes)
            : Array.isArray(stats?.class_names) ? stats.class_names : [];
          classes.forEach(c => allClasses.add(c));
        } catch (e) {
          console.error('Error fetching classes', e);
        }
      }
      setTotalClassCount(allClasses.size);
    } finally {
      setClassCountLoading(false);
    }
  };

  // Auto-count classes when datasets change
  useEffect(() => {
    if (selectedDatasets.length > 0 && deployTarget === 'edge-drone') {
      countTotalClasses();
    } else {
      setTotalClassCount(null);
    }
  }, [JSON.stringify(selectedDatasets.map(s => `${s.dataset.id}:${s.annotation}`)), deployTarget]);

  const runClassConflictCheck = async () => {
    if (!api) return;
    setConflictLoading(true);
    try {
      const perDataset: Array<{ datasetId: number; datasetName: string; classes: string[] }> = [];
      for (const sel of selectedDatasets) {
        if (!sel.annotation) continue;
        try {
          const res = await api.getAnnotationClasses(sel.dataset.id, sel.annotation);
          const stats = (res && (res as any).success) ? (res as any).data : null;
          const classes: string[] = stats && stats.classes
            ? Object.keys(stats.classes)
            : Array.isArray(stats?.class_names) ? stats.class_names : [];
          perDataset.push({ datasetId: sel.dataset.id, datasetName: sel.dataset.name, classes });
        } catch (e) {
          perDataset.push({ datasetId: sel.dataset.id, datasetName: sel.dataset.name, classes: [] });
        }
      }
      if (perDataset.length === 0) {
        setConflictReport({ perDataset: [], shared: [], onlyIn: {} });
        return;
      }
      const allClasses = new Set<string>();
      perDataset.forEach(p => p.classes.forEach(c => allClasses.add(c)));
      const shared: string[] = [];
      const onlyIn: Record<string, string[]> = {};
      allClasses.forEach(c => {
        const present = perDataset.filter(p => p.classes.includes(c));
        if (present.length === perDataset.length) {
          shared.push(c);
        } else {
          present.forEach(p => {
            if (!onlyIn[p.datasetName]) onlyIn[p.datasetName] = [];
            onlyIn[p.datasetName].push(c);
          });
        }
      });
      setConflictReport({ perDataset, shared: shared.sort(), onlyIn });
    } finally {
      setConflictLoading(false);
    }
  };


  const getTrainBlockReasons = (): string[] => {
    const reasons: string[] = [];

    if (resourcesLoading) {
      reasons.push('Resources are still loading…');
      return reasons;
    }

    if (selectedDatasets.length === 0) {
      reasons.push('Select at least one dataset.');
    } else {
      const missingCollection = selectedDatasets.filter(sel => !sel.imageCollection || sel.imageCollection.trim() === '');
      const missingAnnotation = selectedDatasets.filter(sel => !sel.annotation || sel.annotation.trim() === '');
      if (missingCollection.length > 0) {
        reasons.push(`Image collection not selected for: ${missingCollection.map(s => s.dataset.name).join(', ')}`);
      }
      if (missingAnnotation.length > 0) {
        reasons.push(`Annotation not selected for: ${missingAnnotation.map(s => s.dataset.name).join(', ')}`);
      }
    }

    if (!selectedModel) {
      reasons.push('Select a model family.');
    }

    if (deployTarget === 'edge-drone') {
      if (selectedModel !== 'mmyolo') {
        reasons.push('DJI Drone mode supports only MMYOLO YOLOv8 Detection in this GUI flow.');
      }
      if (modelSettings.mmyoloArch && modelSettings.mmyoloArch !== 'yolov8') {
        reasons.push('DJI Drone mode requires the YOLOv8 architecture.');
      }
      if (modelSettings.mmyoloSize && modelSettings.mmyoloSize !== 's') {
        reasons.push('DJI Drone mode requires YOLOv8-S (Small size) model.');
      }
      if (selectedTask !== 'detect') {
        reasons.push('DJI Drone mode requires the Detection task.');
      }
      if (!djiPatch?.path) {
        reasons.push('Upload DJI AI Inside patch (.patch) for MMYOLO edge-drone training.');
      }
      if (totalClassCount !== null && totalClassCount > 10) {
        reasons.push(`DJI Drone models support maximum 10 classes, but your dataset has ${totalClassCount} classes. Reduce the number of classes.`);
      }
    }


    if (saveToWandb) {
      if (!wandbSettings.apiKey) reasons.push('Weights & Biases API key is required.');
      if (!wandbSettings.project) reasons.push('Weights & Biases project name is required.');
    }

    return reasons;
  };

  const handleDJIPatchUpload = async (file: File | null) => {
    if (!file || !api) return;
    if (!file.name.toLowerCase().endsWith('.patch')) {
      sonnerToast.error('Please upload a .patch file from DJI AI Inside portal.');
      return;
    }
    setDjiPatchUploading(true);
    try {
      console.log('Uploading DJI patch:', file.name, 'size:', file.size);
      const res = await api.uploadMMYOLODJIPatch(file);
      console.log('Upload response:', res);

      const payload = (res as any)?.data ?? (res as any);
      if (!res.success || !payload?.patch_name || !payload?.patch_path) {
        const errorMsg = res.error || 'Failed to upload DJI patch';
        console.error('Upload failed:', errorMsg);
        throw new Error(errorMsg);
      }
      setDjiPatch({
        name: payload.patch_name,
        path: payload.patch_path,
        uploadedAt: payload.uploaded_at,
      });
      sonnerToast.success(`DJI patch uploaded: ${payload.patch_name}`);
    } catch (err) {
      console.error('DJI patch upload error:', err);
      const errorMessage = err instanceof Error ? err.message : 'Failed to upload DJI patch';
      sonnerToast.error(`Upload failed: ${errorMessage}`);
    } finally {
      setDjiPatchUploading(false);
    }
  };

  const canTrain = () => getTrainBlockReasons().length === 0;

  const handleTrain = async () => {
    if (!canTrain() || !api) return;
    
    setIsTraining(true);
    
    try {
      // Prepare dataset configurations
      const datasetConfigs = selectedDatasets.map(sel => ({
        dataset_id: sel.dataset.id,
        annotation_file_id: sel.annotation,
        image_collection: sel.imageCollection || undefined,
        split: sel.split || { train: 80, val: 20, test: 0 },
      }));

      let response;
      let modelName = '';

      if (selectedModel === 'yolo') {
        // Always derive model_type from the active task selection in this modal.
        // Do not let previously cloned/stored task values force a detect model
        // when user is currently training segmentation.
        const ver = normalizeYoloVersion(modelSettings.version || 'yolo11');
        const sz = modelSettings.size || 'n';
        const selectedTaskKind =
          selectedTask === 'classify'
            ? 'classification'
            : selectedTask === 'segment'
            ? 'segmentation'
            : 'detection';
        // If user entered from a generic detect flow but cloned settings carry
        // a specific task (e.g. segmentation), preserve the cloned task.
        const clonedTaskKind = modelSettings.task;
        const task =
          selectedTaskKind === 'detection' &&
          (clonedTaskKind === 'segmentation' || clonedTaskKind === 'classification')
            ? clonedTaskKind
            : selectedTaskKind;
        const modelType = buildYoloModelSize(ver, sz, task);
        // Prepare YOLO training request
        const trainingRequest = {
          project_id: parseInt(projectId),
          dataset_configs: datasetConfigs,
          model_type: modelType,
          epochs: modelSettings.epochs || 100,
          batch_size: modelSettings.batchSize || 16,
          image_size: modelSettings.imageSize || 640,
          device: modelSettings.device || '0',
          patience: modelSettings.patience || 50,
          optimizer: modelSettings.optimizer || 'auto',
          learning_rate: modelSettings.learningRate || 0.01,
          momentum: modelSettings.momentum || 0.937,
          weight_decay: modelSettings.weightDecay || 0.0005,
          save_period: modelSettings.savePeriod !== undefined ? modelSettings.savePeriod : -1,
          augmentations: modelSettings.augmentations || {},
          remove_images_without_annotations: removeImagesWithoutAnnotations,
          use_wandb: saveToWandb,
          wandb_project: saveToWandb ? wandbSettings.project : undefined,
          wandb_entity: saveToWandb ? wandbSettings.entity : undefined,
          task_name: customName.trim() || `YOLO Training - ${new Date().toLocaleString()}`
        };

        response = await api.startTraining({
          framework_id: 'ultralytics.yolo',
          project_id: parseInt(projectId),
          dataset_configs: datasetConfigs,
          task_name: trainingRequest.task_name,
          params: trainingRequest,
        });
        modelName = trainingRequest.model_type;
      } else if (selectedModel === 'rf-detr') {
        // Prepare RT-DETR training request
        const modelType = modelSettings.variant || 'rtdetrv2-s';
        const trainingRequest = {
          project_id: parseInt(projectId),
          dataset_configs: datasetConfigs,
          model_type: modelType.endsWith('.pt') ? modelType : `${modelType}.pt`,
          epochs: modelSettings.epochs || 100,
          batch_size: modelSettings.batchSize || 16,
          image_size: modelSettings.imageSize || 640,
          device: modelSettings.device || '0',
          patience: modelSettings.patience || 50,
          optimizer: modelSettings.optimizer || 'AdamW',
          learning_rate: modelSettings.learningRate || 0.0001,
          weight_decay: modelSettings.weightDecay || 0.0001,
          save_period: modelSettings.savePeriod !== undefined ? modelSettings.savePeriod : -1,
          use_wandb: saveToWandb,
          wandb_project: saveToWandb ? wandbSettings.project : undefined,
          wandb_entity: saveToWandb ? wandbSettings.entity : undefined,
          task_name: customName.trim() || `RT-DETR Training - ${new Date().toLocaleString()}`
        };

        response = await api.startTraining({
          framework_id: 'ultralytics.rtdetr',
          project_id: parseInt(projectId),
          dataset_configs: datasetConfigs,
          task_name: trainingRequest.task_name,
          params: trainingRequest,
        });
        modelName = trainingRequest.model_type;
      } else if (selectedModel === 'mmyolo') {
        const arch = modelSettings.mmyoloArch || defaultMmyoloArchForTask(selectedTask as TrainTask, deployTarget);
        const size = modelSettings.mmyoloSize || 's';
        const mmyoloTask =
          arch === 'rtmdet-ins' ? 'segment' :
          arch === 'rtmdet-r'   ? 'oriented' : 'detect';
        const trainingRequest = {
          project_id: parseInt(projectId),
          dataset_configs: datasetConfigs,
          arch,
          size,
          task: mmyoloTask,
          epochs: modelSettings.epochs || 300,
          batch_size: modelSettings.batchSize || 16,
          image_size: modelSettings.imageSize || 640,
          device: modelSettings.device || '0',
          optimizer: modelSettings.optimizer || 'AdamW',
          learning_rate: modelSettings.learningRate || 0.004,
          weight_decay: modelSettings.weightDecay || 0.05,
          save_period: modelSettings.savePeriod !== undefined ? modelSettings.savePeriod : -1,
          remove_images_without_annotations: removeImagesWithoutAnnotations,
          dji_patch_path: deployTarget === 'edge-drone' ? djiPatch?.path : undefined,
          dji_use_widen_factor_025: deployTarget === 'edge-drone' ? (modelSettings.djiWidenFactor025 === true) : undefined,
          use_wandb: saveToWandb,
          wandb_project: saveToWandb ? wandbSettings.project : undefined,
          wandb_entity: saveToWandb ? wandbSettings.entity : undefined,
          task_name: customName.trim() || `MMYOLO ${arch.toUpperCase()} ${size.toUpperCase()} - ${new Date().toLocaleString()}`
        };
        response = await api.startTraining({
          framework_id: 'mmyolo',
          project_id: parseInt(projectId),
          dataset_configs: datasetConfigs,
          task_name: trainingRequest.task_name,
          params: trainingRequest,
        });
        modelName = `${arch}-${size}`;
      }

      // Handle both wrapped and unwrapped responses
      const responseData = response.data || response;
      
      if (response.success && (responseData.task_id || responseData.success)) {
        const taskId = responseData.task_id;

        const downloadNotice =
          responseData.weights_download_expected && responseData.weights_download_notice
            ? responseData.weights_download_notice
            : undefined;

        // Show training started dialog
        setTrainingInfo({
          taskId: taskId || 'unknown',
          modelName: modelName,
          datasetsCount: selectedDatasets.length,
          epochs: modelSettings.epochs || 100,
          weightsDownloadNotice: downloadNotice
        });

        sonnerToast.success("Training Started", {
          description: `Task "${modelName}" is now running on the GPU service.`,
          duration: 6000,
        });

        if (downloadNotice) {
          sonnerToast.info("Model weights will be downloaded", {
            description: downloadNotice,
            duration: 6000,
          });
        }
        
        onOpenChange(false);
        setShowTrainingStarted(true);
        
        // Reset form
        setSelectedDatasets([]);
        setSelectedModel(null);
        setModelSettings({});
      } else {
        const errorMsg = response.error || JSON.stringify(response) || 'Unknown error';
        toast({
          title: "Training Failed",
          description: errorMsg,
          variant: "destructive",
        });
      }
    } catch (error) {
      console.error('Error starting training:', error);
      toast({
        title: "Error Starting Training",
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: "destructive",
      });
    } finally {
      setIsTraining(false);
    }
  };

  const resetForm = () => {
    setSelectedDatasets([]);
    setSelectedModel(null);
    setModelSettings({});
    setSaveToWandb(false);
    setWandbSettings({
      apiKey: '',
      project: '',
      entity: ''
    });
    setCustomName('');
    setRemoveImagesWithoutAnnotations(true);
    setDjiPatch(null);
    setStep(1);
  };

  // Wizard step validity — step 1 = Model, step 2 = Datasets
  const canLeaveStep1 = !!selectedModel;
  const canLeaveStep2 = selectedDatasets.length > 0
    && !selectedDatasets.some(s => !s.imageCollection || !s.annotation);

  const goNext = () => {
    if (step === 1 && !selectedModel) {
      sonnerToast.error('Select a model architecture.');
      return;
    }
    if (step === 2) {
      if (selectedDatasets.length === 0) {
        sonnerToast.error('Select at least one dataset.');
        return;
      }
      const missing = selectedDatasets.find(s => !s.imageCollection || !s.annotation);
      if (missing) {
        sonnerToast.error(`Pick image collection and annotation for "${missing.dataset.name}".`);
        return;
      }
    }
    setStep(((step + 1) as 1 | 2 | 3));
  };


  const fetchDataForSelectionRef = useRef(fetchDataForSelection);
  fetchDataForSelectionRef.current = fetchDataForSelection;

  const lastSuccessfulCloneKeyRef = useRef<string | null>(null);

  // If clone hydration provides model settings but selectedModel is temporarily cleared
  // by other state transitions, re-select the cloned family until user changes it.
  useEffect(() => {
    if (!open || cloneFromTaskId == null) return;
    if (selectedModel) return;

    if (modelSettings.variant) {
      setSelectedModel('rf-detr');
      return;
    }

    if (modelSettings.version || modelSettings.size || modelSettings.modelSize) {
      setSelectedModel('yolo');
    }
  }, [
    open,
    cloneFromTaskId,
    selectedModel,
    modelSettings.variant,
    modelSettings.version,
    modelSettings.size,
    modelSettings.modelSize,
  ]);

  useEffect(() => {
    isMountedRef.current = true;
    
    if (!open) {
      resetForm();
      lastSuccessfulCloneKeyRef.current = null;
      // Cancel all active fetches
      activeFetchesRef.current.forEach(controller => controller.abort());
      activeFetchesRef.current.clear();
    } else {
      setSelectedTask(defaultTask || 'detect');
    }
    
    return () => {
      isMountedRef.current = false;
      // Cancel all active fetches on unmount
      activeFetchesRef.current.forEach(controller => controller.abort());
      activeFetchesRef.current.clear();
    };
  }, [open]);

  useEffect(() => {
    if (!open || cloneFromTaskId == null || resourcesLoading) return;
    if (datasets.length === 0) return;

    const key = `task-${cloneFromTaskId}`;
    if (lastSuccessfulCloneKeyRef.current === key) return;

    let cancelled = false;

    const run = async () => {
      if (!api) return;
      try {
        const res = await api.getTask(cloneFromTaskId);
        if (!res.success || !res.data) {
          throw new Error(res.error || 'Failed to load task');
        }
        const task = res.data;
        const md = task.task_metadata || {};
        const rawCfgs = md.dataset_configs;
        if (!Array.isArray(rawCfgs) || rawCfgs.length === 0) {
          if (!cancelled) {
            toast({
              title: 'Could not copy settings',
              description: 'This training task has no saved dataset configuration in metadata.',
              variant: 'destructive',
            });
            lastSuccessfulCloneKeyRef.current = key;
          }
          return;
        }

        type CfgRow = {
          dataset_id?: number | string;
          annotation_file_id?: number | string;
          image_collection?: string;
          split?: { train: number; val: number; test: number };
        };

        const newSelections: DatasetSelection[] = [];
        for (const row of rawCfgs as CfgRow[]) {
          const dsId = Number(row.dataset_id);
          const annRaw = row.annotation_file_id;
          if (!Number.isFinite(dsId) || annRaw === undefined || annRaw === null) continue;

          const dataset = datasets.find((d) => String(d.id) === String(dsId));
          if (!dataset) continue;

          newSelections.push({
            id: `clone-${cloneFromTaskId}-${dsId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            dataset,
            imageCollection: row.image_collection || '',
            annotation: String(annRaw),
            imageCollections: [],
            annotations: [],
            loadingCollections: false,
            loadingAnnotations: false,
            split: row.split || { train: 80, val: 20, test: 0 },
          });
        }

        if (newSelections.length === 0) {
          if (!cancelled) {
            toast({
              title: 'Could not copy settings',
              description:
                'None of the saved datasets from this task are available in this project anymore.',
              variant: 'destructive',
            });
            lastSuccessfulCloneKeyRef.current = key;
          }
          return;
        }

        const tp = md.training_params || {};
        const rawModel =
          (typeof md.model_variant === 'string' ? md.model_variant : null) ||
          (typeof md.model_type === 'string' ? md.model_type : '') ||
          (md.model_config && typeof md.model_config === 'object' ? (md.model_config as { model?: string }).model : '') ||
          '';

        const isRf =
          String(md.model_type || '').toLowerCase() === 'rtdetr' || /rtdetr/i.test(String(rawModel));

        const epochs = tp.epochs ?? md.epochs ?? 100;
        const batchSize = tp.batch_size ?? 16;
        const imageSize = tp.image_size ?? tp.imgsz ?? md.image_size ?? 640;
        const device = tp.device ?? '0';
        const patience = tp.patience ?? 50;
        const savePeriod = tp.save_period ?? -1;

        if (!cancelled) {
          setSelectedDatasets(newSelections);
          newSelections.forEach((sel) => fetchDataForSelectionRef.current(sel.id, sel.dataset.id));

          const removeUnannotated =
            md.remove_images_without_annotations !== undefined &&
            md.remove_images_without_annotations !== null
              ? Boolean(md.remove_images_without_annotations)
              : true;
          setRemoveImagesWithoutAnnotations(removeUnannotated);

          if (isRf) {
            const variant = rtdetrVariantFromStored(String(rawModel));
            setSelectedModel('rf-detr');
            setModelSettings({
              variant,
              epochs,
              batchSize,
              imageSize,
              device,
              patience,
              optimizer: tp.optimizer ?? 'AdamW',
              learningRate: tp.lr0 ?? tp.learning_rate ?? 0.0001,
              weightDecay: tp.weight_decay ?? 0.0001,
              savePeriod,
            });
          } else {
            const preset = parseYoloPresetFromModelType(String(rawModel));
            let taskKind: 'detection' | 'segmentation' | 'classification' =
              preset?.task ?? 'segmentation';
            const mcTask = md.model_config && typeof md.model_config === 'object' ? (md.model_config as { task?: string }).task : '';
            const tLower = String(mcTask || '').toLowerCase();
            if (tLower.includes('seg')) taskKind = 'segmentation';
            else if (tLower.includes('cls') || tLower.includes('classif')) taskKind = 'classification';
            else if (tLower.includes('detect') || tLower === 'detection' || tLower === 'detect') taskKind = 'detection';

            const yoloPreset = preset ?? {
              version: 'yolo11',
              size: 'n',
              task: taskKind,
              modelSize: 'yolo11n-seg.pt',
            };

            const augmentationsClone =
              md.model_config && typeof md.model_config === 'object'
                ? (md.model_config as { augmentations?: Record<string, unknown> }).augmentations || {}
                : {};

            setSelectedModel('yolo');
            setModelSettings({
              version: yoloPreset.version,
              size: yoloPreset.size,
              task: taskKind,
              modelSize: yoloPreset.modelSize,
              epochs,
              batchSize,
              imageSize,
              device,
              patience,
              optimizer: tp.optimizer ?? 'auto',
              learningRate: tp.lr0 ?? tp.learning_rate ?? 0.01,
              momentum: tp.momentum ?? 0.937,
              weightDecay: tp.weight_decay ?? 0.0005,
              savePeriod,
              augmentations: augmentationsClone,
            });
          }

          toast({
            title: 'Training form filled',
            description: 'Review settings and press Train Model when ready.',
          });
          lastSuccessfulCloneKeyRef.current = key;
        }
      } catch (e) {
        if (!cancelled) {
          toast({
            title: 'Could not load task settings',
            description: e instanceof Error ? e.message : 'Unknown error',
            variant: 'destructive',
          });
          lastSuccessfulCloneKeyRef.current = key;
        }
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [open, cloneFromTaskId, resourcesLoading, datasets, toast]);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-4xl max-h-[80vh] overflow-y-auto bg-background z-50">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Brain className="h-5 w-5" />
              Train Model
            </DialogTitle>
            <DialogDescription>
              Step {step} of 3 — {step === 1 ? 'choose model architecture & settings' : step === 2 ? 'pick datasets & splits' : 'name, options & confirm'}
            </DialogDescription>
          </DialogHeader>

          {/* Stepper */}
          <div className="flex items-center justify-center gap-1 pb-1">
            {([
              { n: 1, label: 'Model', icon: <Brain className="w-3.5 h-3.5" /> },
              { n: 2, label: 'Datasets', icon: <Database className="w-3.5 h-3.5" /> },
              { n: 3, label: 'Options', icon: <Sliders className="w-3.5 h-3.5" /> },

            ] as const).map((s, i) => {
              const canJump =
                s.n < step ||
                (s.n === 2 && canLeaveStep1) ||
                (s.n === 3 && canLeaveStep1 && canLeaveStep2);
              return (
                <React.Fragment key={s.n}>
                  <button
                    type="button"
                    disabled={!canJump && s.n !== step}
                    onClick={() => canJump && setStep(s.n as 1 | 2 | 3)}
                    className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                      step === s.n
                        ? 'bg-primary text-primary-foreground'
                        : step > s.n
                        ? 'bg-muted text-foreground hover:bg-muted/80'
                        : 'bg-muted/40 text-muted-foreground'
                    } ${!canJump && s.n !== step ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                  >
                    {step > s.n ? <Check className="w-3.5 h-3.5" /> : s.icon}
                    {s.label}
                  </button>
                  {i < 2 && <div className={`h-px w-8 ${step > s.n ? 'bg-primary' : 'bg-border'}`} />}
                </React.Fragment>
              );
            })}
          </div>

          <div className="space-y-6 py-4">
            {step === 2 && (

            <div className="space-y-4">
              {/* Dataset Selection */}
              <div className="flex items-center justify-between">
                <Label className="text-base font-medium">Dataset Configuration</Label>
                {selectedDatasets.length > 0 && (
                  <Badge variant="secondary" className="text-xs">
                    {selectedDatasets.length} selected
                  </Badge>
                )}
              </div>

              {/* Task is chosen in the Model step; show a compact read-only chip here */}
              <div className="rounded-lg border border-border bg-muted/30 p-2 flex items-center justify-between flex-wrap gap-2">
                <div className="text-[11px] text-muted-foreground">
                  Showing datasets compatible with <span className="font-medium text-foreground">{TASK_LABELS[selectedTask].toLowerCase()}</span>.
                </div>
                <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setStep(1)}>
                  Change task
                </Button>
              </div>


              {resourcesLoading ? (
                <Card className="p-6 text-center border-dashed">
                  <p className="text-muted-foreground text-sm">Loading datasets…</p>
                </Card>
              ) : datasets.length === 0 && datasetGroups.length === 0 ? (
                <Card className="p-6 text-center border-dashed">
                  <Database className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
                  <p className="text-muted-foreground">No datasets available</p>
                </Card>
              ) : (
                <DatasetEvalPicker
                  datasets={pickerDatasets}
                  groups={pickerGroups}
                  modelClasses={[]}
                  requiredTaskType={requiredAnnotationTaskType}
                  value={pickerValue}
                  onChange={handlePickerChange}
                  renderExpandedExtra={(pickerSel) => {
                    const selection = selectedDatasets.find(s => s.dataset.id === pickerSel.datasetId);
                    if (!selection) return null;
                    const train = selection.split?.train ?? 80;
                    const val = selection.split?.val ?? 20;
                    const test = selection.split?.test ?? 0;
                    return (

                      <div className="space-y-2 pt-1 border-t border-border/40">
                        <div className="flex items-center justify-between">
                          <label className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                            Train / Val / Test split
                          </label>
                          <div className="flex items-center gap-3 text-xs font-medium">
                            <span className="flex items-center gap-1">
                              <span className="inline-block h-2 w-2 rounded-sm bg-green-500" />
                              {train}%
                            </span>
                            <span className="flex items-center gap-1">
                              <span className="inline-block h-2 w-2 rounded-sm bg-yellow-400" />
                              {val}%
                            </span>
                            <span className="flex items-center gap-1">
                              <span className="inline-block h-2 w-2 rounded-sm bg-blue-500" />
                              {test}%
                            </span>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-5 w-5"
                              onClick={async () => {
                                if (!selection.annotation) return;
                                try {
                                  const res = await api?.getAnnotationClasses(selection.dataset.id, selection.annotation);
                                  if (res && res.success) {
                                    setClassStats(res.data);
                                    setShowClassDialog(true);
                                  }
                                } catch (e) {
                                  console.error('Error fetching class stats', e);
                                }
                              }}
                              aria-label="Show class stats"
                              title="View class statistics"
                            >
                              <Info className="h-3 w-3" />
                            </Button>
                          </div>
                        </div>
                        <div className="w-full h-2.5 rounded-full overflow-hidden bg-muted flex">
                          <div style={{ width: `${train}%` }} className="h-full bg-green-500 transition-all" />
                          <div style={{ width: `${val}%` }} className="h-full bg-yellow-400 transition-all" />
                          <div style={{ width: `${test}%` }} className="h-full bg-blue-500 transition-all" />
                        </div>

                        {/* Quick presets */}
                        <div className="flex flex-wrap gap-1">
                          {[
                            { label: '80/20', t: 80, v: 20, te: 0 },
                            { label: '70/20/10', t: 70, v: 20, te: 10 },
                            { label: '70/15/15', t: 70, v: 15, te: 15 },
                            { label: '60/20/20', t: 60, v: 20, te: 20 },
                            { label: '90/10', t: 90, v: 10, te: 0 },
                          ].map(p => {
                            const active = train === p.t && val === p.v && test === p.te;
                            return (
                              <button
                                key={p.label}
                                type="button"
                                onClick={() => updateDatasetSelection(selection.id, 'split', { train: p.t, val: p.v, test: p.te })}
                                className={`px-2 py-0.5 text-[10px] rounded border transition-colors ${active ? 'bg-primary text-primary-foreground border-primary' : 'bg-background hover:bg-muted border-border'}`}
                              >
                                {p.label}
                              </button>
                            );
                          })}
                        </div>

                        {/* Numeric inputs — direct, predictable */}
                        <div className="grid grid-cols-3 gap-2">
                          {([
                            { key: 'train', label: 'Train', value: train, color: 'bg-green-500' },
                            { key: 'val', label: 'Val', value: val, color: 'bg-yellow-400' },
                            { key: 'test', label: 'Test', value: test, color: 'bg-blue-500' },
                          ] as const).map(field => (
                            <div key={field.key} className="space-y-0.5">
                              <div className="flex items-center gap-1">
                                <span className={`inline-block h-2 w-2 rounded-sm ${field.color}`} />
                                <label className="text-[10px] text-muted-foreground uppercase tracking-wide">{field.label}</label>
                              </div>
                              <div className="flex items-center">
                                <Input
                                  type="number"
                                  min={0}
                                  max={100}
                                  value={field.value}
                                  onChange={(e) => {
                                    const n = Math.max(0, Math.min(100, Number(e.target.value) || 0));
                                    let t = train, v = val, te = test;
                                    if (field.key === 'train') {
                                      t = n;
                                      const rem = 100 - t;
                                      const oldRest = val + test;
                                      if (oldRest > 0) {
                                        v = Math.round((val / oldRest) * rem);
                                        te = rem - v;
                                      } else { v = rem; te = 0; }
                                    } else if (field.key === 'val') {
                                      v = Math.min(n, 100 - test);
                                      t = 100 - v - test;
                                    } else {
                                      te = Math.min(n, 100 - val);
                                      t = 100 - val - te;
                                    }
                                    updateDatasetSelection(selection.id, 'split', { train: Math.max(0, t), val: Math.max(0, v), test: Math.max(0, te) });
                                  }}
                                  className="h-7 text-xs px-2"
                                />
                                <span className="text-[10px] text-muted-foreground ml-1">%</span>
                              </div>
                            </div>
                          ))}
                        </div>
                        <p className="text-[10px] text-muted-foreground">Use a preset for speed, or type exact percentages. Total auto-balances to 100%.</p>

                      </div>
                    );
                  }}
                />
              )}

              {/* Live Training Summary */}
              {selectedDatasets.length > 0 && (
                <Card className="bg-muted/30 border-dashed">
                  <CardContent className="p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <Sliders className="h-3.5 w-3.5 text-primary" />
                      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Training set summary
                      </span>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
                      <div className="rounded-md bg-background px-2 py-1.5">
                        <div className="text-[10px] uppercase text-muted-foreground tracking-wide">Datasets</div>
                        <div className="font-semibold">{selectedDatasets.length}</div>
                      </div>
                      <div className="rounded-md bg-background px-2 py-1.5">
                        <div className="text-[10px] uppercase text-muted-foreground tracking-wide">Images</div>
                        <div className="font-semibold">{trainingSummary.totalImages.toLocaleString()}</div>
                      </div>
                      <div className="rounded-md bg-background px-2 py-1.5 flex flex-col">
                        <div className="text-[10px] uppercase text-muted-foreground tracking-wide">Train · Val · Test</div>
                        <div className="font-semibold text-xs flex gap-2">
                          <span className="text-green-600 dark:text-green-400">{trainingSummary.train.toLocaleString()}</span>
                          <span className="text-yellow-600 dark:text-yellow-400">{trainingSummary.val.toLocaleString()}</span>
                          <span className="text-blue-600 dark:text-blue-400">{trainingSummary.test.toLocaleString()}</span>
                        </div>
                      </div>
                      <div className="rounded-md bg-background px-2 py-1.5">
                        <div className="text-[10px] uppercase text-muted-foreground tracking-wide">Task</div>
                        <div className="font-semibold text-xs">{TASK_LABELS[selectedTask]}</div>
                      </div>
                    </div>
                    {trainingSummary.warnings.length > 0 && (
                      <ul className="space-y-0.5">
                        {trainingSummary.warnings.map((w, i) => (
                          <li key={i} className="flex items-start gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
                            <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" />
                            <span>{w}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </CardContent>
                </Card>
              )}

              {/* DJI Class Count Warning */}
              {deployTarget === 'edge-drone' && selectedDatasets.length > 0 && (
                <Card className={totalClassCount !== null && totalClassCount > 10 ? "border-red-500/50 bg-red-500/5" : "border-amber-500/30 bg-amber-500/10"}>
                  <CardContent className="p-3 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <AlertCircle className={`h-4 w-4 ${totalClassCount !== null && totalClassCount > 10 ? 'text-red-600' : 'text-amber-600'}`} />
                        <span className="text-sm font-semibold uppercase tracking-wide text-foreground">
                          DJI Class Limit Check
                        </span>
                      </div>
                      {totalClassCount !== null && (
                        <Badge variant={totalClassCount > 10 ? "destructive" : "secondary"} className="text-xs">
                          {totalClassCount} / 10 classes
                        </Badge>
                      )}
                    </div>
                    <p className={`text-xs ${totalClassCount !== null && totalClassCount > 10 ? 'text-red-700 dark:text-red-300' : 'text-amber-700 dark:text-amber-300'}`}>
                      {classCountLoading ? (
                        'Counting classes...'
                      ) : totalClassCount === null ? (
                        'Checking class count for DJI compatibility...'
                      ) : totalClassCount > 10 ? (
                        `⚠️ ERROR: Your dataset has ${totalClassCount} classes, but DJI drone models support a maximum of 10 classes. Please reduce the number of classes before training.`
                      ) : (
                        `✓ Your dataset has ${totalClassCount} ${totalClassCount === 1 ? 'class' : 'classes'}, which is within the DJI limit of 10 classes.`
                      )}
                    </p>
                    {totalClassCount !== null && totalClassCount > 10 && (
                      <div className="text-xs text-muted-foreground space-y-1">
                        <p className="font-medium">Options to fix this:</p>
                        <ul className="list-disc list-inside space-y-0.5 pl-2">
                          <li>Merge similar classes into broader categories</li>
                          <li>Split your dataset into multiple models, each with ≤10 classes</li>
                          <li>Remove less important classes from your annotation files</li>
                        </ul>
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}

              {/* Class conflict checker */}
              {selectedDatasets.length >= 2 && (
                <Card className="border-border/60">
                  <CardContent className="p-3 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <FileText className="h-3.5 w-3.5 text-primary" />
                        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          Class conflicts
                        </span>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        disabled={conflictLoading || selectedDatasets.some(s => !s.annotation)}
                        onClick={runClassConflictCheck}
                      >
                        {conflictLoading ? 'Checking…' : conflictReport ? 'Re-check' : 'Check class names'}
                      </Button>
                    </div>
                    {!conflictReport && (
                      <p className="text-[11px] text-muted-foreground">
                        Detect class names that exist in some — but not all — selected datasets so you can rename or merge them before training.
                      </p>
                    )}
                    {conflictReport && (
                      <div className="space-y-2 text-xs">
                        {conflictReport.shared.length > 0 && (
                          <div>
                            <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium mb-1">
                              Shared by all ({conflictReport.shared.length})
                            </div>
                            <div className="flex flex-wrap gap-1">
                              {conflictReport.shared.map(c => (
                                <span key={c} className="inline-flex items-center rounded-full bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30 px-2 py-0 text-[11px]">
                                  {c}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                        {Object.keys(conflictReport.onlyIn).length === 0 ? (
                          <div className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
                            <Check className="h-3 w-3" />
                            No conflicts — all classes are shared across selected datasets.
                          </div>
                        ) : (
                          <div className="space-y-1.5">
                            <div className="text-[10px] uppercase tracking-wide text-amber-600 dark:text-amber-400 font-medium">
                              ⚠ Classes only in some datasets
                            </div>
                            {Object.entries(conflictReport.onlyIn).map(([ds, cls]) => (
                              <div key={ds} className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5">
                                <div className="text-[11px] font-semibold mb-1">{ds}</div>
                                <div className="flex flex-wrap gap-1">
                                  {cls.map(c => (
                                    <span key={c} className="inline-flex items-center rounded-full bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/30 px-2 py-0 text-[11px]">
                                      {c}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            ))}
                            <p className="text-[10px] text-muted-foreground">
                              Tip: rename matching concepts to the same label in each dataset's annotation file before training, or training will treat them as separate classes.
                            </p>
                          </div>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}
            </div>
            )}


            {step === 1 && (() => {
              const recommended = recommendedFamily(selectedTask, deployTarget);
              const familyCards: Array<{
                id: 'yolo' | 'rf-detr' | 'mmyolo';
                title: string;
                subtitle: string;
                badges: string[];
                onPick: () => void;
              }> = [
                {
                  id: 'yolo',
                  title: 'Ultralytics YOLO',
                  subtitle: 'YOLOv8 / YOLO11 / YOLO26 — fastest to train, easy ONNX export.',
                  badges: [],
                  onPick: () => {
                    setSelectedModel('yolo');
                    if (!modelSettings.epochs) setModelSettings((prev: any) => ({ ...prev, epochs: 100, batchSize: 16, imageSize: 640, device: '0', patience: 50, optimizer: 'auto', learningRate: 0.01, momentum: 0.937, weightDecay: 0.0005, savePeriod: -1, version: deployTarget === 'edge-drone' ? 'yolo8' : 'yolo11', size: 'n', task: selectedTask === 'classify' ? 'classification' : selectedTask === 'segment' ? 'segmentation' : 'detection' }));
                  },
                },
                {
                  id: 'rf-detr',
                  title: 'Ultralytics RT-DETR',
                  subtitle: 'Real-time detection transformer — best accuracy on small objects, server GPUs.',
                  badges: [],
                  onPick: () => {
                    setSelectedModel('rf-detr');
                    if (!modelSettings.variant) setModelSettings((prev: any) => ({ ...prev, variant: 'rtdetr-l', imageSize: 640, epochs: 100, batchSize: 16 }));
                  },
                },
                {
                  id: 'mmyolo',
                  title: 'MMYOLO (OpenMMLab)',
                  subtitle: 'YOLOv8, RTMDet, RTMDet-Ins, RTMDet-Rotated — only family with oriented boxes; great speed/accuracy for edge devices and drones.',
                  badges: [],
                  onPick: () => {
                    setSelectedModel('mmyolo');
                    setModelSettings((prev: any) => ({
                      ...prev,
                      mmyoloArch: prev.mmyoloArch || defaultMmyoloArchForTask(selectedTask, deployTarget),
                      ...(prev.mmyoloSize ? {} : { mmyoloSize: 's', epochs: 300, batchSize: 16, imageSize: 640, optimizer: 'AdamW', learningRate: 0.004, weightDecay: 0.05 }),
                    }));
                  },
                },
              ];

              const available = familyCards
                .filter(f => FAMILY_SUPPORTS[f.id].includes(selectedTask))
                .filter(f => deployTarget !== 'edge-drone' || f.id === 'mmyolo');

              // Auto-pick recommended if current selection isn't valid for task
              if (selectedModel && !available.find(a => a.id === selectedModel)) {
                // user must reselect
              }

              return (
                <div className="space-y-5">
                  {/* Step 1: Task */}
                  <div className="space-y-2">
                    <Label className="text-base font-medium">What are you training?</Label>
                    <div className="flex flex-wrap gap-2">
                      {(Object.keys(TASK_LABELS) as TrainTask[])
                        .filter(t => deployTarget !== 'edge-drone' || t === 'detect')
                        .map(t => (
                          <button
                            key={t}
                            type="button"
                            onClick={() => setSelectedTask(t)}
                            className={`px-3 py-1.5 rounded-full text-xs border transition-colors ${selectedTask === t ? 'bg-primary text-primary-foreground border-primary' : 'bg-background hover:border-primary/50'}`}
                          >
                            {TASK_LABELS[t]}
                          </button>
                        ))}
                    </div>
                  </div>

                  {/* Deploy target */}
                  <div className="space-y-2">
                    <Label className="text-base font-medium">Where will it run?</Label>
                    <div className="flex flex-wrap gap-2">
                      {(['general', 'edge-drone'] as DeployTarget[]).map(d => (
                        <button
                          key={d}
                          type="button"
                          onClick={() => {
                            setDeployTarget(d);
                            // Preselect the default MMYOLO architecture for deploy target.
                            if (d === 'edge-drone') {
                              setModelSettings((prev: any) => ({
                                ...prev,
                                mmyoloArch: prev.mmyoloArch || defaultMmyoloArchForTask(selectedTask, 'edge-drone'),
                              }));
                            }
                          }}
                          className={`px-3 py-1.5 rounded-full text-xs border transition-colors ${deployTarget === d ? 'bg-primary text-primary-foreground border-primary' : 'bg-background hover:border-primary/50'}`}
                        >
                          {DEPLOY_LABELS[d]}
                        </button>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground flex items-start gap-1.5 pt-1">
                      <Info className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                      {deployTarget === 'edge-drone'
                        ? 'For DJI Matrice 4E, this GUI enforces MMYOLO YOLOv8 with the Detection task.'
                        : 'Standard PyTorch weights for desktop, server, or cloud inference.'}
                    </p>
                  </div>

                  {/* Step 3: Family cards (filtered + recommended) */}
                  <div className="space-y-2">
                    <Label className="text-base font-medium">Pick a model family</Label>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                      {available.map(f => {
                        const isSelected = selectedModel === f.id;
                        const isRecommended = recommended === f.id;
                        return (
                          <Card
                            key={f.id}
                            className={`cursor-pointer transition-all relative ${isSelected ? 'ring-2 ring-primary' : 'hover:border-primary/50'} ${isRecommended ? 'border-primary/60' : ''}`}
                            onClick={f.onPick}
                          >
                            {isRecommended && (
                              <Badge className="absolute -top-2 left-3 bg-primary text-primary-foreground text-[10px] px-2 py-0.5">
                                Recommended
                              </Badge>
                            )}
                            <CardContent className="p-4">
                              <div className="flex items-center justify-between mb-1">
                                <h4 className="font-medium text-sm">{f.title}</h4>
                                {isSelected && <Check className="h-4 w-4 text-primary" />}
                              </div>
                              <p className="text-xs text-muted-foreground mb-2.5">{f.subtitle}</p>
                              <div className="flex flex-wrap gap-1">
                                {f.badges.map(b => (
                                  <Badge key={b} variant="secondary" className="text-[10px] px-1.5 py-0">{b}</Badge>
                                ))}
                              </div>
                            </CardContent>
                          </Card>
                        );
                      })}
                    </div>
                    {available.length < 3 && (
                      <p className="text-xs text-muted-foreground">
                        Some families are hidden because they don't support <span className="font-medium">{TASK_LABELS[selectedTask].toLowerCase()}</span>.
                      </p>
                    )}
                  </div>

                  {/* Existing inline config cards below */}
                  <div className="space-y-4">


              {/* Inline Model Settings */}
              {selectedModel === 'yolo' && (
                <Card className="border-primary/30">
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-sm flex items-center gap-2">
                        <Settings className="h-4 w-4" /> YOLO Configuration
                      </CardTitle>
                      <Button size="sm" variant="outline" onClick={() => setShowYoloSettings(true)}>
                        <Settings className="h-3 w-3 mr-1" /> All Settings
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      <div className="space-y-1">
                        <Label className="text-xs">Version</Label>
                        {deployTarget === 'edge-drone' ? (
                          <div className="h-8 text-xs bg-muted border rounded-md px-3 flex items-center text-muted-foreground">
                            YOLOv8
                          </div>
                        ) : (
                          <Select value={modelSettings.version || 'yolo11'} onValueChange={(v) => setModelSettings((prev: any) => ({ ...prev, version: v }))}>
                            <SelectTrigger className="h-8 text-xs bg-background"><SelectValue /></SelectTrigger>
                            <SelectContent className="bg-background border shadow-md z-[70]">
                              <SelectItem value="yolo8">YOLOv8</SelectItem>
                              <SelectItem value="yolo11">YOLOv11</SelectItem>
                              <SelectItem value="yolo26">YOLO26</SelectItem>
                            </SelectContent>
                          </Select>
                        )}
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Size</Label>
                        <Select value={modelSettings.size || 'n'} onValueChange={(v) => setModelSettings((prev: any) => ({ ...prev, size: v }))}>
                          <SelectTrigger className="h-8 text-xs bg-background"><SelectValue /></SelectTrigger>
                          <SelectContent className="bg-background border shadow-md z-[70]">
                            {allowedYoloSizes.map((sz) => (
                              <SelectItem key={sz} value={sz}>
                                {LABEL_FOR_SIZE[sz] ?? sz}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Task</Label>
                        <Select value={modelSettings.task || (selectedTask === 'classify' ? 'classification' : selectedTask === 'segment' ? 'segmentation' : 'detection')} onValueChange={(v) => setModelSettings((prev: any) => ({ ...prev, task: v }))}>
                          <SelectTrigger className="h-8 text-xs bg-background"><SelectValue /></SelectTrigger>
                          <SelectContent className="bg-background border shadow-md z-[70]">
                            <SelectItem value="detection">Detection</SelectItem>
                            <SelectItem value="segmentation">Segmentation</SelectItem>
                            <SelectItem value="classification">Classification</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Epochs</Label>
                        <Input type="number" className="h-8 text-xs bg-background" value={modelSettings.epochs || 100} onChange={(e) => setModelSettings((prev: any) => ({ ...prev, epochs: Number(e.target.value) }))} min={1} />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      <div className="space-y-1">
                        <Label className="text-xs">Batch Size</Label>
                        <Input type="number" className="h-8 text-xs bg-background" value={modelSettings.batchSize || 16} onChange={(e) => setModelSettings((prev: any) => ({ ...prev, batchSize: Number(e.target.value) }))} min={1} />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Image Size</Label>
                        <Input type="number" className="h-8 text-xs bg-background" value={modelSettings.imageSize || 640} onChange={(e) => setModelSettings((prev: any) => ({ ...prev, imageSize: Number(e.target.value) }))} min={32} step={32} />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Learning Rate</Label>
                        <Input type="number" className="h-8 text-xs bg-background" value={modelSettings.learningRate || 0.01} onChange={(e) => setModelSettings((prev: any) => ({ ...prev, learningRate: Number(e.target.value) }))} step={0.001} min={0.0001} />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Patience</Label>
                        <Input type="number" className="h-8 text-xs bg-background" value={modelSettings.patience || 50} onChange={(e) => setModelSettings((prev: any) => ({ ...prev, patience: Number(e.target.value) }))} min={1} />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}

              {selectedModel === 'rf-detr' && (
                <Card className="border-primary/30">
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-sm flex items-center gap-2">
                        <Settings className="h-4 w-4" /> Ultralytics RT-DETR Configuration
                      </CardTitle>
                      <Button size="sm" variant="outline" onClick={() => setShowRFDETRSettings(true)}>
                        <Settings className="h-3 w-3 mr-1" /> All Settings
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      <div className="space-y-1">
                        <Label className="text-xs">Variant</Label>
                        <Select value={modelSettings.variant || 'rtdetr-l'} onValueChange={(v) => setModelSettings((prev: any) => ({ ...prev, variant: v }))}>
                          <SelectTrigger className="h-8 text-xs bg-background"><SelectValue /></SelectTrigger>
                          <SelectContent className="bg-background border shadow-md z-[70]">
                            <SelectItem value="rtdetr-l">RT-DETR-L</SelectItem>
                            <SelectItem value="rtdetr-x">RT-DETR-X</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Epochs</Label>
                        <Input type="number" className="h-8 text-xs bg-background" value={modelSettings.epochs || 100} onChange={(e) => setModelSettings((prev: any) => ({ ...prev, epochs: Number(e.target.value) }))} min={1} />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Batch Size</Label>
                        <Input type="number" className="h-8 text-xs bg-background" value={modelSettings.batchSize || 16} onChange={(e) => setModelSettings((prev: any) => ({ ...prev, batchSize: Number(e.target.value) }))} min={1} />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Image Size</Label>
                        <Input type="number" className="h-8 text-xs bg-background" value={modelSettings.imageSize || 640} onChange={(e) => setModelSettings((prev: any) => ({ ...prev, imageSize: Number(e.target.value) }))} min={32} step={32} />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}

              {selectedModel === 'mmyolo' && (() => {
                const archOptions = mmyoloArchsForTask(selectedTask);
                const currentArch = modelSettings.mmyoloArch && archOptions.some(a => a.id === modelSettings.mmyoloArch)
                  ? modelSettings.mmyoloArch
                  : defaultMmyoloArchForTask(selectedTask, deployTarget);
                return (
                  <Card className="border-primary/30">
                    <CardHeader className="pb-2">
                      <div className="flex items-center justify-between">
                        <CardTitle className="text-sm flex items-center gap-2">
                          <Settings className="h-4 w-4" /> MMYOLO Configuration
                          <Badge variant="outline" className="text-[10px]">{mmyoloArchLabel(currentArch, selectedTask)}</Badge>
                        </CardTitle>
                        <Button size="sm" variant="outline" onClick={() => setShowMMYOLOSettings(true)}>
                          <Settings className="h-3 w-3 mr-1" /> All Settings
                        </Button>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <p className="text-xs text-muted-foreground flex items-start gap-1.5">
                        <Info className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                        {'Choose the MMYOLO architecture you want to train. Advanced mmcv configs are generated server-side.'}
                      </p>

                      {deployTarget === 'edge-drone' && (
                        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 space-y-2">
                          <p className="text-xs text-amber-900 dark:text-amber-300 flex items-start gap-1.5">
                            <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                            DJI AI Inside requires a private MMYOLO patch from the DJI developer portal. Upload that .patch file here before starting training.
                          </p>
                          <div className="space-y-1">
                            <Label className="text-xs">DJI Patch File (.patch)</Label>
                            <Input
                              type="file"
                              accept=".patch,text/plain"
                              className="h-8 text-xs bg-background"
                              disabled={djiPatchUploading}
                              onChange={(e) => {
                                const file = e.target.files?.[0] || null;
                                handleDJIPatchUpload(file);
                                e.currentTarget.value = '';
                              }}
                            />
                          </div>
                          <p className="text-[11px] text-muted-foreground">
                            {djiPatch
                              ? `Uploaded: ${djiPatch.name}`
                              : 'No patch uploaded yet.'}
                          </p>
                        </div>
                      )}

                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        <div className="space-y-1">
                          <Label className="text-xs">Architecture</Label>
                          {archOptions.length > 1 ? (
                            <Select
                              value={currentArch}
                              onValueChange={(v) => setModelSettings((prev: any) => ({ ...prev, mmyoloArch: v }))}
                            >
                              <SelectTrigger className="h-8 text-xs bg-background"><SelectValue /></SelectTrigger>
                              <SelectContent className="bg-background border shadow-md z-[70]">
                                {archOptions.map(a => (
                                  <SelectItem key={a.id} value={a.id}>{a.label}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : (
                            <div className="h-8 text-xs bg-muted border rounded-md px-3 flex items-center text-muted-foreground">
                              {mmyoloArchLabel(currentArch, selectedTask)}
                            </div>
                          )}
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Size</Label>
                          {deployTarget === 'edge-drone' ? (
                            <div className="h-8 text-xs bg-muted border rounded-md px-3 flex items-center text-muted-foreground">
                              Small (DJI Required)
                            </div>
                          ) : (
                            <Select value={modelSettings.mmyoloSize || 's'} onValueChange={(v) => setModelSettings((prev: any) => ({ ...prev, mmyoloSize: v }))}>
                              <SelectTrigger className="h-8 text-xs bg-background"><SelectValue /></SelectTrigger>
                              <SelectContent className="bg-background border shadow-md z-[70]">
                                {MMYOLO_SIZES.map(sz => (
                                  <SelectItem key={sz} value={sz}>{LABEL_FOR_SIZE[sz] ?? sz}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          )}
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Epochs</Label>
                          <Input type="number" className="h-8 text-xs bg-background" value={modelSettings.epochs || 300} onChange={(e) => setModelSettings((prev: any) => ({ ...prev, epochs: Number(e.target.value) }))} min={1} />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Batch Size</Label>
                          <Input type="number" className="h-8 text-xs bg-background" value={modelSettings.batchSize || 16} onChange={(e) => setModelSettings((prev: any) => ({ ...prev, batchSize: Number(e.target.value) }))} min={1} />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Image Size</Label>
                          <Input type="number" className="h-8 text-xs bg-background" value={modelSettings.imageSize || 640} onChange={(e) => setModelSettings((prev: any) => ({ ...prev, imageSize: Number(e.target.value) }))} min={32} step={32} />
                        </div>
                      </div>

                    </CardContent>
                  </Card>
                );
              })()}
                  </div>
                </div>
              );
            })()}


            {step === 3 && (
            <div className="space-y-6">
              {/* Custom Training Name */}
              <div className="space-y-2">
                <Label htmlFor="training-name" className="text-base font-medium">Training Name (Optional)</Label>
                <Input
                  id="training-name"
                  type="text"
                  placeholder="e.g., My Custom YOLO Training"
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  className="bg-background"
                />
                <p className="text-xs text-muted-foreground">
                  Leave empty to use default name: "[Model] Training - [Date/Time]"
                </p>
              </div>

              {/* Dataset Options */}
              <div className="space-y-4">
                <Label className="text-base font-medium">Dataset Options</Label>
              
              <div className="flex items-center justify-between p-4 border rounded-lg">
                <div className="flex items-center space-x-3">
                  <Checkbox
                    id="remove-images-checkbox"
                    checked={removeImagesWithoutAnnotations}
                    onCheckedChange={(checked) => setRemoveImagesWithoutAnnotations(checked as boolean)}
                  />
                  <div className="flex-1">
                    <Label htmlFor="remove-images-checkbox" className="text-sm font-medium cursor-pointer">
                      Remove images without annotations
                    </Label>
                    <p className="text-xs text-muted-foreground mt-1">
                      Images that have no annotations will be excluded from the training dataset
                    </p>
                  </div>
                </div>
              </div>
            </div>

            <Separator />

            {/* Weights & Biases Integration */}
            <div className="space-y-4">
              <Label className="text-base font-medium">Experiment Tracking</Label>
              
              <div className="flex items-center justify-between p-4 border rounded-lg">
                <div className="flex items-center space-x-3">
                  <Checkbox
                    id="wandb-checkbox"
                    checked={saveToWandb}
                    onCheckedChange={(checked) => setSaveToWandb(checked as boolean)}
                  />
                  <div className="flex items-center space-x-2">
                    <Wand2 className="h-4 w-4 text-purple-600" />
                    <Label htmlFor="wandb-checkbox" className="text-sm font-medium">
                      Save to Weights & Biases
                    </Label>
                  </div>
                </div>
                
                <Button
                  size="icon"
                  variant="ghost"
                  className={`h-8 w-8 ${saveToWandb && wandbSettings.apiKey && wandbSettings.project ? 'text-green-600' : ''}`}
                  onClick={() => setShowWandbSettings(true)}
                  disabled={!saveToWandb}
                >
                  {saveToWandb && wandbSettings.apiKey && wandbSettings.project ? (
                    <Check className="h-4 w-4" />
                  ) : (
                    <Settings className="h-4 w-4" />
                  )}
                </Button>
              </div>
              
              {saveToWandb && (
                <div className="text-sm text-muted-foreground">
                  <p>Training metrics and model artifacts will be logged to Weights & Biases.</p>
                  {(!wandbSettings.apiKey || !wandbSettings.project) && (
                    <p className="text-orange-600 mt-1">
                      ⚠️ {wandbSettings.apiKey ? 'Project name' : 'API key and project name'} required in settings
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* Training Summary / Review Panel */}
            {canTrain() && (
              <>
                <Separator />
                <div className="space-y-3">
                  <Label className="text-base font-medium flex items-center gap-2">
                    <Check className="h-4 w-4 text-primary" />
                    Training Summary
                  </Label>
                  <Card className="bg-muted/50 border-primary/20">
                    <CardContent className="p-4">
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-3 text-sm">
                        <div>
                          <span className="text-muted-foreground text-xs">Model</span>
                          <p className="font-medium">
                            {selectedModel === 'yolo' && `${YOLO_VERSION_LABEL[modelSettings.version || 'yolo11'] ?? modelSettings.version} · ${(modelSettings.size || 'n').toUpperCase()}`}
                            {selectedModel === 'rf-detr' && `Ultralytics RT-DETR ${(modelSettings.variant || 'rtdetr-l').toUpperCase()}`}
                            {selectedModel === 'mmyolo' && `${mmyoloArchLabel(modelSettings.mmyoloArch || defaultMmyoloArchForTask(selectedTask, deployTarget), selectedTask)} · ${(modelSettings.mmyoloSize || 's').toUpperCase()}`}

                          </p>
                        </div>
                        {selectedModel === 'yolo' && (
                          <div>
                            <span className="text-muted-foreground text-xs">Task</span>
                            <p className="font-medium capitalize">{modelSettings.task || (selectedTask === 'classify' ? 'classification' : selectedTask === 'segment' ? 'segmentation' : 'detection')}</p>
                          </div>
                        )}
                        <div>
                          <span className="text-muted-foreground text-xs">Epochs</span>
                          <p className="font-medium">{modelSettings.epochs || 100}</p>
                        </div>
                        <div>
                          <span className="text-muted-foreground text-xs">Datasets</span>
                          <p className="font-medium">{selectedDatasets.length} dataset{selectedDatasets.length !== 1 ? 's' : ''}</p>
                        </div>
                        {(selectedModel === 'yolo' || selectedModel === 'rf-detr') && (
                          <>
                            <div>
                              <span className="text-muted-foreground text-xs">Batch Size</span>
                              <p className="font-medium">{modelSettings.batchSize || 16}</p>
                            </div>
                            <div>
                              <span className="text-muted-foreground text-xs">Image Size</span>
                              <p className="font-medium">{modelSettings.imageSize || 640}px</p>
                            </div>
                          </>
                        )}
                        <div>
                          <span className="text-muted-foreground text-xs">Learning Rate</span>
                          <p className="font-medium">{modelSettings.learningRate ?? (selectedModel === 'rf-detr' ? 0.0001 : 0.01)}</p>
                        </div>
                        {saveToWandb && (
                          <div>
                            <span className="text-muted-foreground text-xs">W&B Project</span>
                            <p className="font-medium">{wandbSettings.project}</p>
                          </div>
                        )}
                      </div>
                      <Separator className="my-3" />
                      <div className="space-y-1">
                        <span className="text-muted-foreground text-xs">Datasets</span>
                        {selectedDatasets.map((sel) => (
                          <div key={sel.id} className="flex items-center justify-between text-xs">
                            <span className="font-medium">{sel.dataset.name}</span>
                            <div className="flex items-center gap-2 text-muted-foreground">
                              <span>{sel.imageCollection}</span>
                              <span>•</span>
                              <span>{sel.split?.train ?? 80}/{sel.split?.val ?? 20}/{sel.split?.test ?? 0}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                </div>
              </>
            )}
            </div>
            )}
          </div>

          <DialogFooter>
            <div className="flex items-center justify-between gap-3 w-full pt-2 border-t">
              <div className="text-xs text-muted-foreground">
                {step === 1 && (!selectedModel
                  ? 'Pick a model architecture to continue.'
                  : `Selected: ${selectedModel === 'yolo' ? 'Ultralytics YOLO' : selectedModel === 'rf-detr' ? 'Ultralytics RT-DETR' : 'MMYOLO'}`)}
                {step === 2 && (selectedDatasets.length === 0
                  ? 'Pick at least one dataset to continue.'
                  : `${selectedDatasets.length} dataset(s) selected.`)}

                {step === 3 && (!isTraining && !canTrain()
                  ? getTrainBlockReasons()[0]
                  : `${selectedDatasets.length} dataset(s) · ${selectedModel === 'yolo' ? 'Ultralytics YOLO' : selectedModel === 'rf-detr' ? 'Ultralytics RT-DETR' : 'MMYOLO'}`)}

              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => (step === 1 ? onOpenChange(false) : setStep(((step - 1) as 1 | 2 | 3)))}
                  disabled={isTraining}
                >
                  {step === 1 ? 'Cancel' : (<><ArrowLeft className="w-4 h-4 mr-1" />Back</>)}
                </Button>
                {step < 3 ? (
                  <Button
                    type="button"
                    onClick={goNext}
                    disabled={isTraining || resourcesLoading || (step === 1 && !canLeaveStep1) || (step === 2 && !canLeaveStep2)}
                  >
                    Next<ArrowRight className="w-4 h-4 ml-1" />
                  </Button>
                ) : (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span tabIndex={0}>
                          <Button
                            onClick={handleTrain}
                            disabled={!canTrain() || isTraining || resourcesLoading}
                          >
                            <Brain className="h-4 w-4 mr-2" />
                            {isTraining ? 'Training...' : resourcesLoading ? 'Loading…' : 'Train Model'}
                          </Button>
                        </span>
                      </TooltipTrigger>
                      {!canTrain() && !isTraining && (
                        <TooltipContent side="top" className="max-w-xs">
                          <ul className="list-disc list-inside space-y-0.5 text-xs">
                            {getTrainBlockReasons().map((r, i) => <li key={i}>{r}</li>)}
                          </ul>
                        </TooltipContent>
                      )}
                    </Tooltip>
                  </TooltipProvider>
                )}
              </div>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>


      {/* Settings Dialogs */}
      <YoloSettingsDialog
        open={showYoloSettings}
        onOpenChange={setShowYoloSettings}
        onSettingsUpdate={handleModelSettingsUpdate}
        currentSettings={modelSettings}
      />

      <RFDETRSettingsDialog
        open={showRFDETRSettings}
        onOpenChange={setShowRFDETRSettings}
        onSettingsUpdate={handleModelSettingsUpdate}
        currentSettings={modelSettings}
      />

      <MMYOLOSettingsDialog
        open={showMMYOLOSettings}
        onOpenChange={setShowMMYOLOSettings}
        onSettingsUpdate={handleModelSettingsUpdate}
        currentSettings={modelSettings}
        deployTarget={deployTarget}
        djiPatchName={djiPatch?.name || null}
        djiPatchUploading={djiPatchUploading}
        onDJIPatchUpload={handleDJIPatchUpload}
      />
      {/* Class distribution dialog */}
      <Dialog open={showClassDialog} onOpenChange={setShowClassDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Class distribution</DialogTitle>
            <DialogDescription>
              Per-class counts for the selected annotation file
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2">
            {classStats ? (
              <div>
                <div className="text-sm mb-2">Total annotations: {classStats.totalAnnotations}</div>
                <div className="space-y-2">
                  {classStats.classes.map((c: any) => (
                    <div key={c.className} className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div style={{ width: 12, height: 12, backgroundColor: c.color }} className="rounded" />
                        <div className="text-sm">{c.className}</div>
                      </div>
                      <div className="text-sm text-muted-foreground">{c.count}</div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">No class statistics available</div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowClassDialog(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      
      <WandbSettingsDialog
        open={showWandbSettings}
        onOpenChange={setShowWandbSettings}
        settings={wandbSettings}
        onSettingsUpdate={setWandbSettings}
      />

      {/* Training Started Success Dialog */}
      <TrainingStartedDialog
        open={showTrainingStarted}
        onOpenChange={setShowTrainingStarted}
        taskId={trainingInfo.taskId}
        modelName={trainingInfo.modelName}
        datasetsCount={trainingInfo.datasetsCount}
        epochs={trainingInfo.epochs}
        weightsDownloadNotice={trainingInfo.weightsDownloadNotice}
      />
    </>
  );
}

// Weights & Biases Settings Dialog
interface WandbSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: {
    apiKey: string;
    project: string;
    entity: string;
  };
  onSettingsUpdate: (settings: { apiKey: string; project: string; entity: string }) => void;
}

function WandbSettingsDialog({ open, onOpenChange, settings, onSettingsUpdate }: WandbSettingsDialogProps) {
  const [localSettings, setLocalSettings] = useState(settings);

  useEffect(() => {
    setLocalSettings(settings);
  }, [settings]);

  const handleSave = () => {
    if (!localSettings.apiKey.trim() || !localSettings.project.trim()) {
      return; // Don't save if required fields are empty
    }
    onSettingsUpdate(localSettings);
    onOpenChange(false);
  };

  const handleCancel = () => {
    setLocalSettings(settings); // Reset to original
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wand2 className="h-5 w-5 text-purple-600" />
            Weights & Biases Settings
          </DialogTitle>
          <DialogDescription>
            Configure your Weights & Biases credentials for experiment tracking.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="wandb-api-key">API Key <span className="text-red-500">*</span></Label>
            <Input
              id="wandb-api-key"
              type="password"
              placeholder="Enter your W&B API key"
              value={localSettings.apiKey}
              onChange={(e) => setLocalSettings(prev => ({ ...prev, apiKey: e.target.value }))}
              className={!localSettings.apiKey.trim() ? 'border-red-300' : ''}
            />
            <p className="text-xs text-muted-foreground">
              Get your API key from <a href="https://wandb.ai/settings" target="_blank" rel="noopener noreferrer" className="text-purple-600 hover:underline">wandb.ai/settings</a>
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="wandb-project">Project Name <span className="text-red-500">*</span></Label>
            <Input
              id="wandb-project"
              placeholder="my-awesome-project"
              value={localSettings.project}
              onChange={(e) => setLocalSettings(prev => ({ ...prev, project: e.target.value }))}
              className={!localSettings.project.trim() ? 'border-red-300' : ''}
            />
            <p className="text-xs text-muted-foreground">
              The name of your W&B project for this experiment
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="wandb-entity">Entity (Optional)</Label>
            <Input
              id="wandb-entity"
              placeholder="your-username or team-name"
              value={localSettings.entity}
              onChange={(e) => setLocalSettings(prev => ({ ...prev, entity: e.target.value }))}
            />
            <p className="text-xs text-muted-foreground">
              Your W&B username or team name. Leave empty to use your default entity.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleCancel}>
            Cancel
          </Button>
          <Button 
            onClick={handleSave}
            disabled={!localSettings.apiKey.trim() || !localSettings.project.trim()}
          >
            Save Settings
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}