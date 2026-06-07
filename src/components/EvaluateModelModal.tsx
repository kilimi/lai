import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Brain, Database, ChevronDown, ChevronUp, X, ArrowLeft, ArrowRight, Check, Sliders } from "lucide-react";
import React, { useState, useEffect, useMemo, useCallback } from "react";
import { toast } from "sonner";
import { useApi } from "@/hooks/use-api";
import { Dataset, DatasetGroup, ImageCollection } from "@/types";
import {
  DatasetEvalPicker,
  type DatasetSelection,
  type PickerDataset,
  type PickerGroup,
} from "@/components/DatasetEvalPicker";
import { getApiBaseUrl } from "@/config/api";
import { mapAnnotationFileForTrainingPicker } from "@/utils/annotations";

interface AnnotationClass {
  className: string;
  count: number;
  color: string;
}

interface DatasetEvalConfig {
  datasetId: number;
  datasetName: string;
  annotationFileId: string | null;
  annotationFileName: string | null;
  collectionId: string | null;
}

interface EvaluateModelModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trainingTasks: any[];
  /** When true, datasets / models are still loading after the dialog opened */
  resourcesLoading?: boolean;
  projectId: string;
  datasets?: Dataset[];
  datasetGroups?: DatasetGroup[];
  onEvaluate: (params: {
    taskId: number;
    datasetId: number;
    annotationFileId: string | null;
    imageSize: number;
    checkpoint: 'best' | 'last';
    confThreshold: number;
    iouThreshold: number;
    nmsIouThreshold: number;
    evaluationName: string;
    useGrid: boolean;
    gridSize: number;
    gridOverlap: number;
    ignoredClasses: string[];
    collectionId: string | null;
  }) => Promise<void>;
  onEvaluateMultiple?: (params: {
    taskId: number;
    datasets: DatasetEvalConfig[];
    imageSize: number;
    checkpoint: 'best' | 'last';
    confThreshold: number;
    iouThreshold: number;
    nmsIouThreshold: number;
    evaluationName: string;
    useGrid: boolean;
    gridSize: number;
    gridOverlap: number;
    ignoredClasses: string[];
  }) => Promise<void>;
}

export function EvaluateModelModal({
  open,
  onOpenChange,
  trainingTasks,
  resourcesLoading = false,
  projectId,
  datasets = [],
  datasetGroups = [],
  onEvaluate,
  onEvaluateMultiple
}: EvaluateModelModalProps) {
  const { api } = useApi();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [evaluationName, setEvaluationName] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [selectedCheckpoint, setSelectedCheckpoint] = useState<'best' | 'last'>('best');
  const [confThreshold, setConfThreshold] = useState(0.25);
  const [iouThreshold, setIouThreshold] = useState(0.45);
  const [nmsIouThreshold, setNmsIouThreshold] = useState(0.45);
  const [useGrid, setUseGrid] = useState(false);
  const [gridSize, setGridSize] = useState(640);
  const [gridOverlap, setGridOverlap] = useState(0.2);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Per-annotation-file class lists (populated lazily; powers compatibility badges)
  const [fileClassesMap, setFileClassesMap] = useState<Map<string, string[]>>(new Map());
  
  // Multi-dataset selection state
  const [selectedDatasets, setSelectedDatasets] = useState<DatasetEvalConfig[]>([]);
  
  // Track which datasets came from groups
  const [datasetGroupInfo, setDatasetGroupInfo] = useState<Record<number, { groupName: string; groupId: number }>>({});
  
  // Ignored classes state
  const [annotationClasses, setAnnotationClasses] = useState<AnnotationClass[]>([]);
  const [modelClasses, setModelClasses] = useState<string[]>([]);
  const [loadingClasses, setLoadingClasses] = useState(false);
  const [loadingModelClasses, setLoadingModelClasses] = useState(false);
  const [ignoredClasses, setIgnoredClasses] = useState<string[]>([]);
  const [showIgnoredClasses, setShowIgnoredClasses] = useState(false);

  // Local enriched datasets with annotation files
  const [enrichedDatasets, setEnrichedDatasets] = useState<Map<number, Dataset>>(new Map());
  const [datasetCollections, setDatasetCollections] = useState<Map<number, ImageCollection[]>>(new Map());
  const [collectionAnnotationCounts, setCollectionAnnotationCounts] = useState<Map<number, Record<string, number>>>(new Map());

  const fetchCollectionCountsForSelection = async (datasetId: number, annotationFileId: string | null) => {
    if (!annotationFileId) {
      setCollectionAnnotationCounts(prev => {
        const next = new Map(prev);
        next.set(datasetId, {});
        return next;
      });
      return;
    }
    try {
      const response = await api.getAnnotationCollectionCounts(datasetId, annotationFileId);
      if (response.success && response.data) {
        const countsByCollection = (response.data || []).reduce((acc: Record<string, number>, row: any) => {
          acc[String(row.collection_id)] = Number(row.annotation_count || 0);
          return acc;
        }, {});
        setCollectionAnnotationCounts(prev => {
          const next = new Map(prev);
          next.set(datasetId, countsByCollection);
          return next;
        });
      }
    } catch (error) {
      console.error('Error fetching annotation counts per collection:', error);
    }
  };

  // Lazy-fetch enrichment for a single dataset (annotation file list + collections)
  const enrichDataset = useCallback(async (dataset: Dataset) => {
    let annotationFiles: any[] = dataset.annotation_files || [];
    let imageCollections: ImageCollection[] = [];
    try {
      if (annotationFiles.length === 0) {
        const response = await fetch(`${getApiBaseUrl()}/datasets/${dataset.id}/annotation-files/list`);
        if (response.ok) {
          const result = await response.json();
          if (result.success && result.data) annotationFiles = result.data;
        }
      }
      const collectionsResponse = await api.getImageCollections(dataset.id);
      if (collectionsResponse.success && collectionsResponse.data) {
        imageCollections = collectionsResponse.data;
      }
    } catch (e) {
      console.error('Error enriching dataset:', e);
    }
    setEnrichedDatasets(prev => new Map(prev).set(dataset.id, { ...dataset, annotation_files: annotationFiles }));
    setDatasetCollections(prev => new Map(prev).set(dataset.id, imageCollections));
    return { annotationFiles, imageCollections };
  }, [api]);

  // Fetch model classes when model is selected
  useEffect(() => {
    if (!selectedModel) {
      setModelClasses([]);
      setIgnoredClasses([]);
      return;
    }
    setLoadingModelClasses(true);
    try {
      const task = trainingTasks.find(t => t.id.toString() === selectedModel);
      if (task?.task_metadata?.class_names) {
        setModelClasses(task.task_metadata.class_names);
      }
    } catch (error) {
      console.error('[EvaluateModelModal] Error fetching model classes:', error);
    } finally {
      setLoadingModelClasses(false);
    }
  }, [selectedModel, trainingTasks]);

  // Fetch annotation classes from the first selected dataset with ground truth
  useEffect(() => {
    const datasetWithGT = selectedDatasets.find(d => d.annotationFileId);
    if (!datasetWithGT) {
      setAnnotationClasses([]);
      return;
    }
    const fetchClasses = async () => {
      setLoadingClasses(true);
      try {
        const response = await fetch(`${getApiBaseUrl()}/datasets/${datasetWithGT.datasetId}/annotations/${datasetWithGT.annotationFileId}/classes`);
        if (response.ok) {
          const data = await response.json();
          if (data.success && data.data?.classes) {
            setAnnotationClasses(data.data.classes);
          }
        }
      } catch (error) {
        console.error('[EvaluateModelModal] Error fetching annotation classes:', error);
      } finally {
        setLoadingClasses(false);
      }
    };
    fetchClasses();
  }, [selectedDatasets]);

  const toggleIgnoredClass = (className: string) => {
    setIgnoredClasses(prev =>
      prev.includes(className) ? prev.filter(c => c !== className) : [...prev, className]
    );
  };

  // Lazy-load class lists for compatibility badges
  const loadFileClasses = useCallback(async (datasetId: number, fileId: string) => {
    if (fileClassesMap.has(fileId)) return;
    try {
      const response = await fetch(`${getApiBaseUrl()}/datasets/${datasetId}/annotations/${fileId}/classes`);
      if (response.ok) {
        const data = await response.json();
        const classes = (data?.data?.classes || []).map((c: any) => c.className || c.name || c).filter(Boolean);
        setFileClassesMap(prev => new Map(prev).set(fileId, classes));
      }
    } catch (e) {
      console.error('Error loading file classes:', e);
    }
  }, [fileClassesMap]);

  // Preload annotation files + collections for every dataset when the modal opens.
  useEffect(() => {
    if (!open || datasets.length === 0) return;
    datasets.forEach((dataset) => {
      void enrichDataset(dataset);
    });
  }, [open, datasets, enrichDataset]);

  // Build picker datasets from props + enriched data
  const pickerDatasets: PickerDataset[] = useMemo(() => {
    return datasets.map(d => {
      const enriched = enrichedDatasets.get(d.id) || d;
      const files = (enriched.annotation_files || []).map((f: any) => {
        const mapped = mapAnnotationFileForTrainingPicker({
          id: f.id,
          name: f.file_name || f.name,
          type: f.type || f.annotation_type,
          created_at: f.created_at,
        });
        return {
          id: mapped.id,
          name: mapped.name,
          classes: fileClassesMap.get(String(f.id)) || [],
          taskType: mapped.taskType,
          annotationType: mapped.annotationType,
          modifiedAt: mapped.modifiedAt,
          annotationCount: f.annotation_count,
        };
      });
      const collections = (datasetCollections.get(d.id) || []).map((c: any) => ({
        id: String(c.id),
        name: c.name,
        isDefault: !!c.is_default,
        imageCount: c.image_count,
      }));
      return {
        id: d.id,
        name: d.name,
        imageCount: d.image_count || 0,
        annotationFileCount:
          typeof d.annotation_file_count === "number"
            ? d.annotation_file_count
            : files.length,
        thumbnailUrl: d.thumbnailUrl || d.logo_url,
        annotationFiles: files,
        collections,
        tags: d.tags,
      };
    });
  }, [datasets, enrichedDatasets, datasetCollections, fileClassesMap]);

  const pickerGroups: PickerGroup[] = useMemo(
    () => datasetGroups.map(g => ({
      id: g.id,
      name: g.name,
      datasetIds: (g.datasets || []).map(d => d.id),
    })),
    [datasetGroups]
  );

  const pickerValue: DatasetSelection[] = useMemo(
    () => selectedDatasets.map(s => ({
      datasetId: s.datasetId,
      annotationFileId: s.annotationFileId,
      collectionId: s.collectionId,
    })),
    [selectedDatasets]
  );

  // Determine model task type from selected training task
  const modelTaskType = useMemo(() => {
    const task = trainingTasks.find(t => t.id.toString() === selectedModel);
    const tt = task?.task_metadata?.task_type || task?.task_type || '';
    if (typeof tt === 'string') {
      if (tt.includes('segment')) return 'segmentation' as const;
      if (tt.includes('classif')) return 'classification' as const;
      return 'detection' as const;
    }
    return undefined;
  }, [selectedModel, trainingTasks]);

  const selectedModelImageSize = useMemo(() => {
    const task = trainingTasks.find((t) => t.id.toString() === selectedModel);
    const md = task?.task_metadata || {};
    const tp = md.training_params || md.training_config || {};
    const raw =
      tp.image_size ??
      tp.imgsz ??
      md.image_size ??
      md.imgsz;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 640;
  }, [selectedModel, trainingTasks]);

  const evaluationCandidateTasks = useMemo(
    () => trainingTasks.filter((task) => {
      if (task.status !== 'completed') return false;
      if (task.task_type === 'yolo_training') return true;
      return !!(task.task_metadata?.best_model || task.task_metadata?.last_model);
    }),
    [trainingTasks]
  );

  // Picker change handler — reconciles add/remove/update with selectedDatasets state
  const handlePickerChange = useCallback(async (next: DatasetSelection[]) => {
    const prevIds = new Set(selectedDatasets.map(s => s.datasetId));
    const nextIds = new Set(next.map(s => s.datasetId));

    // Removed
    selectedDatasets.forEach(s => {
      if (!nextIds.has(s.datasetId)) {
        setDatasetGroupInfo(prev => {
          const n = { ...prev };
          delete n[s.datasetId];
          return n;
        });
      }
    });

    // Build the new selectedDatasets list with names looked up
    const newConfigs: DatasetEvalConfig[] = next.map(sel => {
      const ds = enrichedDatasets.get(sel.datasetId) || datasets.find(d => d.id === sel.datasetId);
      const file = ds?.annotation_files?.find((f: any) => String(f.id) === sel.annotationFileId);
      return {
        datasetId: sel.datasetId,
        datasetName: ds?.name || `Dataset ${sel.datasetId}`,
        annotationFileId: sel.annotationFileId,
        annotationFileName: file ? (file.file_name || file.name) : null,
        collectionId: sel.collectionId,
      };
    });
    setSelectedDatasets(newConfigs);

    // Enrich any newly added datasets, then load classes & counts and apply defaults
    for (const sel of next) {
      if (!prevIds.has(sel.datasetId)) {
        const dataset = datasets.find(d => d.id === sel.datasetId);
        if (dataset) {
          const { annotationFiles } = await enrichDataset(dataset);
          annotationFiles.forEach((f: any) => void loadFileClasses(sel.datasetId, String(f.id)));

          // Apply defaults: first annotation file (if exists) and first/default collection
          const colsResp = await api.getImageCollections(sel.datasetId).catch(() => null);
          const cols = (colsResp && (colsResp as any).success && (colsResp as any).data) || [];
          setDatasetCollections(prev => {
            const n = new Map(prev);
            n.set(sel.datasetId, cols as any[]);
            return n;
          });
          const defaultFileId = sel.annotationFileId
            ?? (annotationFiles.length > 0 ? String(annotationFiles[0].id) : null);
          const defaultColl = (cols as any[]).find((c: any) => c.is_default) || (cols as any[])[0];
          const defaultCollId = sel.collectionId ?? (defaultColl ? String(defaultColl.id) : null);

          if (defaultFileId !== sel.annotationFileId || defaultCollId !== sel.collectionId) {
            const file = annotationFiles.find((f: any) => String(f.id) === defaultFileId);
            setSelectedDatasets(prev => prev.map(s =>
              s.datasetId === sel.datasetId
                ? {
                    ...s,
                    annotationFileId: defaultFileId,
                    annotationFileName: file ? (file.file_name || file.name) : s.annotationFileName,
                    collectionId: defaultCollId,
                  }
                : s
            ));
          }
          if (defaultFileId) void fetchCollectionCountsForSelection(sel.datasetId, defaultFileId);
          continue;
        }
      }
      if (sel.annotationFileId) void fetchCollectionCountsForSelection(sel.datasetId, sel.annotationFileId);
    }
  }, [selectedDatasets, enrichedDatasets, datasets, enrichDataset, loadFileClasses]);


  const handleSubmit = async () => {
    if (!selectedModel || selectedDatasets.length === 0) return;

    setIsSubmitting(true);
    try {
      if (onEvaluateMultiple && selectedDatasets.length > 1) {
        await onEvaluateMultiple({
          taskId: parseInt(selectedModel),
          datasets: selectedDatasets,
          imageSize: selectedModelImageSize,
          checkpoint: selectedCheckpoint,
          confThreshold,
          iouThreshold,
          nmsIouThreshold,
          evaluationName: evaluationName.trim(),
          useGrid,
          gridSize,
          gridOverlap,
          ignoredClasses: ignoredClasses
        });
      } else if (selectedDatasets.length === 1) {
        // Fallback to single dataset evaluation
        await onEvaluate({
          taskId: parseInt(selectedModel),
          datasetId: selectedDatasets[0].datasetId,
          annotationFileId: selectedDatasets[0].annotationFileId,
          imageSize: selectedModelImageSize,
          checkpoint: selectedCheckpoint,
          confThreshold,
          iouThreshold,
          nmsIouThreshold,
          evaluationName: evaluationName.trim(),
          useGrid,
          gridSize,
          gridOverlap,
          ignoredClasses: ignoredClasses,
          collectionId: selectedDatasets[0].collectionId,
        });
      }
      
      // Reset form
      setEvaluationName('');
      setSelectedModel('');
      setSelectedDatasets([]);
      setDatasetCollections(new Map());
      setCollectionAnnotationCounts(new Map());
      setConfThreshold(0.25);
      setIouThreshold(0.45);
      setNmsIouThreshold(0.45);
      setUseGrid(false);
      setGridSize(640);
      setGridOverlap(0.2);
      setIgnoredClasses([]);
      setAnnotationClasses([]);
      setShowIgnoredClasses(false);
      setStep(1);
      
      onOpenChange(false);
    } finally {
      setIsSubmitting(false);
    }
  };

  const canLeaveStep1 =
    selectedDatasets.length > 0 &&
    !selectedDatasets.some((d) => !d.collectionId);
  const canLeaveStep2 = !!selectedModel;

  const goNext = () => {
    if (step === 1) {
      if (selectedDatasets.length === 0) {
        toast.error('Select at least one dataset to evaluate.');
        return;
      }
      const missing = selectedDatasets.find((d) => !d.collectionId);
      if (missing) {
        toast.error(`Select an image collection for "${missing.datasetName}".`);
        return;
      }
    }
    if (step === 2 && !selectedModel) {
      toast.error('Select a trained model.');
      return;
    }
    setStep(((step + 1) as 1 | 2 | 3));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Brain className="h-5 w-5" />
            New Model Evaluation
          </DialogTitle>
          <DialogDescription>
            Step {step} of 3 — {step === 1 ? 'pick datasets to evaluate on' : step === 2 ? 'choose model & checkpoint' : 'thresholds & confirm'}
          </DialogDescription>
        </DialogHeader>

        {/* Stepper */}
        <div className="flex items-center justify-center gap-1 pb-1">
          {([
            { n: 1, label: 'Datasets', icon: <Database className="w-3.5 h-3.5" /> },
            { n: 2, label: 'Model', icon: <Brain className="w-3.5 h-3.5" /> },
            { n: 3, label: 'Settings', icon: <Sliders className="w-3.5 h-3.5" /> },
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
                  onClick={() => canJump && setStep(s.n)}
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

        <div className="space-y-6 mt-2">
          {/* Step 1: Datasets */}
          {step === 1 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label className="flex items-center gap-2">
                  <Database className="w-4 h-4" />
                  Datasets to Evaluate
                  {selectedDatasets.length > 0 && (
                    <Badge variant="default" className="bg-primary">
                      {selectedDatasets.length} selected
                    </Badge>
                  )}
                </Label>
                {selectedDatasets.length > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {selectedDatasets.filter((s) => s.annotationFileId).length} with ground truth
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Pick one or more datasets. Any ground-truth file works (boxes, masks, classification) — or choose none for predictions-only.
              </p>

              {datasets.length === 0 && datasetGroups.length === 0 ? (
                <Card className="p-6 text-center border-dashed">
                  <Database className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
                  <p className="text-muted-foreground">No datasets available</p>
                </Card>
              ) : (
                <DatasetEvalPicker
                  datasets={pickerDatasets}
                  groups={pickerGroups}
                  modelClasses={modelClasses}
                  modelTaskType={modelTaskType}
                  pickerMode="evaluate"
                  value={pickerValue}
                  onChange={handlePickerChange}
                />
              )}
            </div>
          )}

          {/* Step 2: Model */}
          {step === 2 && (
            <div className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Model Selection</CardTitle>
                  <CardDescription>Pick the trained model and checkpoint to evaluate.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="model-select">Trained Model</Label>
                    <Select
                      value={selectedModel}
                      onValueChange={setSelectedModel}
                      disabled={resourcesLoading}
                    >
                      <SelectTrigger id="model-select">
                        <SelectValue
                          placeholder={
                            resourcesLoading ? 'Loading models…' : 'Select a trained model'
                          }
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {evaluationCandidateTasks.map(task => (
                          <SelectItem key={task.id} value={task.id.toString()}>
                            {task.name} (ID: {task.id})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="checkpoint-select">Checkpoint</Label>
                    <Select value={selectedCheckpoint} onValueChange={(v) => setSelectedCheckpoint(v as 'best' | 'last')}>
                      <SelectTrigger id="checkpoint-select">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="best">Best Model</SelectItem>
                        <SelectItem value="last">Last Epoch</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </CardContent>
              </Card>

              {selectedModel && modelClasses.length > 0 && (
                <Card>
                  <CardHeader className="pb-3">
                    <button
                      type="button"
                      onClick={() => setShowIgnoredClasses(!showIgnoredClasses)}
                      className="flex items-center gap-2 text-sm font-medium hover:text-foreground transition-colors"
                    >
                      {showIgnoredClasses ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                      <span>Ignore Classes (Predictions & Metrics)</span>
                      {ignoredClasses.length > 0 && (
                        <Badge variant="secondary" className="ml-1">
                          {ignoredClasses.length} ignored
                        </Badge>
                      )}
                    </button>
                  </CardHeader>
                  {showIgnoredClasses && (
                    <CardContent className="space-y-2">
                      <p className="text-xs text-muted-foreground">
                        Predictions of selected classes will not be saved, and they will be excluded from metrics calculations.
                      </p>
                      {loadingModelClasses ? (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-primary" />
                          Loading classes...
                        </div>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {modelClasses.map((className) => {
                            const isIgnored = ignoredClasses.includes(className);
                            return (
                              <button
                                key={className}
                                type="button"
                                onClick={() => toggleIgnoredClass(className)}
                                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-colors border ${
                                  isIgnored
                                    ? 'bg-destructive/10 text-destructive border-destructive/40'
                                    : 'bg-muted text-foreground border-border hover:bg-muted/70'
                                }`}
                              >
                                {className}
                                {isIgnored && <X className="w-3 h-3" />}
                              </button>
                            );
                          })}
                        </div>
                      )}
                      {ignoredClasses.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setIgnoredClasses([])}
                          className="text-xs text-muted-foreground hover:text-foreground underline"
                        >
                          Clear all ignored classes
                        </button>
                      )}
                    </CardContent>
                  )}
                </Card>
              )}
            </div>
          )}

          {/* Step 3: Settings & confirm */}
          {step === 3 && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="eval-name">Evaluation Name (Optional)</Label>
                <Input
                  id="eval-name"
                  value={evaluationName}
                  onChange={(e) => setEvaluationName(e.target.value)}
                  placeholder="e.g., Test Set Evaluation"
                />
              </div>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Detection Thresholds</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="conf-threshold">Confidence Threshold: {confThreshold.toFixed(2)}</Label>
                    <Input
                      id="conf-threshold"
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={confThreshold}
                      onChange={(e) => setConfThreshold(parseFloat(e.target.value))}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="iou-threshold">IoU Threshold: {iouThreshold.toFixed(2)}</Label>
                    <Input
                      id="iou-threshold"
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={iouThreshold}
                      onChange={(e) => setIouThreshold(parseFloat(e.target.value))}
                    />
                    <p className="text-xs text-muted-foreground">
                      IoU threshold for matching predictions to ground truth
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="nms-iou-threshold">NMS IoU Threshold: {nmsIouThreshold.toFixed(2)}</Label>
                    <Input
                      id="nms-iou-threshold"
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={nmsIouThreshold}
                      onChange={(e) => setNmsIouThreshold(parseFloat(e.target.value))}
                    />
                    <p className="text-xs text-muted-foreground">
                      IoU threshold for Non-Maximum Suppression (removes overlapping predictions)
                    </p>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Grid Inference</CardTitle>
                  <CardDescription>
                    Split images into overlapping tiles for better detection of small objects
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id="use-grid"
                      checked={useGrid}
                      onChange={(e) => setUseGrid(e.target.checked)}
                      className="rounded"
                    />
                    <Label htmlFor="use-grid">Enable Grid Inference</Label>
                  </div>

                  {useGrid && (
                    <>
                      <div className="space-y-2">
                        <Label htmlFor="grid-size">Grid Tile Size: {gridSize}px</Label>
                        <Input
                          id="grid-size"
                          type="range"
                          min="320"
                          max="1280"
                          step="32"
                          value={gridSize}
                          onChange={(e) => setGridSize(parseInt(e.target.value))}
                        />
                        <p className="text-xs text-muted-foreground">
                          Each image will be divided into {gridSize}×{gridSize} tiles
                        </p>
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="grid-overlap">Grid Overlap: {(gridOverlap * 100).toFixed(0)}%</Label>
                        <Input
                          id="grid-overlap"
                          type="range"
                          min="0"
                          max="0.5"
                          step="0.05"
                          value={gridOverlap}
                          onChange={(e) => setGridOverlap(parseFloat(e.target.value))}
                        />
                        <p className="text-xs text-muted-foreground">
                          Overlap helps detect objects at tile boundaries
                        </p>
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>

              {/* Summary */}
              <Card className="bg-muted/30">
                <CardContent className="pt-4 space-y-1 text-sm">
                  <div className="flex items-center justify-between text-muted-foreground">
                    <span>Datasets</span>
                    <span className="text-foreground tabular-nums">{selectedDatasets.length}</span>
                  </div>
                  <div className="flex items-center justify-between text-muted-foreground">
                    <span>Model</span>
                    <span className="text-foreground truncate max-w-[60%]">
                      {trainingTasks.find((t) => t.id.toString() === selectedModel)?.name || '—'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-muted-foreground">
                    <span>Checkpoint</span>
                    <span className="text-foreground">{selectedCheckpoint}</span>
                  </div>
                  <div className="flex items-center justify-between text-muted-foreground">
                    <span>Image size</span>
                    <span className="text-foreground tabular-nums">{selectedModelImageSize}px</span>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {/* Wizard Footer */}
          <div className="flex items-center justify-between gap-3 pt-4 border-t">
            <div className="text-xs text-muted-foreground">
              {step === 1 && (selectedDatasets.length === 0
                ? 'Pick at least one dataset to continue.'
                : `${selectedDatasets.length} dataset(s) selected.`)}
              {step === 2 && (!selectedModel
                ? 'Pick a trained model to continue.'
                : 'Model selected.')}
              {step === 3 && `${selectedDatasets.length} dataset(s) · ${trainingTasks.find((t) => t.id.toString() === selectedModel)?.name || 'model'}`}
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => (step === 1 ? onOpenChange(false) : setStep((step - 1) as 1 | 2 | 3))}
                disabled={isSubmitting}
              >
                {step === 1 ? 'Cancel' : (<><ArrowLeft className="w-4 h-4 mr-1" />Back</>)}
              </Button>
              {step < 3 ? (
                <Button type="button" onClick={goNext} disabled={isSubmitting || resourcesLoading}>
                  Next<ArrowRight className="w-4 h-4 ml-1" />
                </Button>
              ) : (
                <Button
                  onClick={handleSubmit}
                  disabled={
                    isSubmitting ||
                    resourcesLoading ||
                    !selectedModel ||
                    selectedDatasets.length === 0 ||
                    selectedDatasets.some((d) => !d.collectionId)
                  }
                >
                  {isSubmitting ? (
                    <>
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2" />
                      Starting...
                    </>
                  ) : (
                    <>
                      <Brain className="w-4 h-4 mr-2" />
                      Start Evaluation
                    </>
                  )}
                </Button>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
