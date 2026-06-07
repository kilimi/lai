import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Brain, Activity, Download, Eye, ChevronDown, Database, AlertCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { type CmSample } from "@/components/ConfusionMatrixCellModal";
import { ThresholdExplorer, type RawPrediction, type RawGTBox } from "@/components/ThresholdExplorer";
import { getApiBaseUrl } from "@/config/api";
import { formatDuration } from "@/utils/formatDuration";
import { StatusBadge } from "@/components/StatusBadge";
import {
  attachmentFilenameFromContentDisposition,
  evaluationCocoJsonDownloadName,
  evaluationCocoZipDownloadName,
} from "@/lib/evaluationTableDisplay";
import {
  drawPredictionSnapshotCrop,
  getPredictionBboxXyxy,
} from "@/utils/evaluationPredictionDisplay";

interface EvaluationDetailsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taskId: number;
  onSaved?: () => void;
}

interface TaskDetails {
  id: number;
  name: string;
  status: string;
  progress: number;
  created_at: string;
  completed_at?: string;
  error_message?: string;
  task_metadata?: {
    training_task_name?: string;
    dataset_name?: string;
    checkpoint?: string;
    conf_threshold?: number;
    iou_threshold?: number;
    has_ground_truth?: boolean;
    use_grid?: boolean;
    grid_size?: number;
    grid_overlap?: number;
    is_multi_dataset?: boolean;
    dataset_count?: number;
    dataset_names?: string[];
    child_task_ids?: number[];
    results?: {
      precision: number;
      recall: number;
      f1_score: number;
      map50: number;
      map50_95: number;
      confusion_matrix: number[][];
      class_names: string[];
      confusion_matrix_samples?: Record<string, CmSample[]>;
      project_id?: number;
      dataset_id?: number;
      predictions_count: number;
      has_ground_truth?: boolean;
      avg_confidence?: number;
      predictions_per_image?: number;
      class_prediction_counts?: Record<string, number>;
      images_processed: number;
      inference_time_ms: number;
      all_ground_truth?: RawGTBox[];
      image_id_to_filename?: Record<string, string>;
      predictions?: RawPrediction[];
      conf_threshold?: number;
      iou_threshold?: number;
      per_class_conf?: Record<string, number>;
      artifacts?: { blobs?: string; format_version?: number };
    };
  };
}

interface EvalBlobPayload {
  predictions: RawPrediction[];
  all_ground_truth: RawGTBox[];
  confusion_matrix_samples?: Record<string, CmSample[]>;
}

export function PredictionSnapshotCard({
  imageUrls,
  fileName,
  className,
  conf,
  bbox,
}: {
  imageUrls: string[];
  fileName: string;
  className: string;
  conf: number;
  bbox: [number, number, number, number] | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const label = `${className} · ${(conf * 100).toFixed(1)}%`;
  const [srcIndex, setSrcIndex] = useState(0);
  const [imageLoaded, setImageLoaded] = useState(false);
  const activeSrc = imageUrls[Math.min(srcIndex, Math.max(0, imageUrls.length - 1))] || "";

  useEffect(() => {
    setSrcIndex(0);
    setImageLoaded(false);
  }, [imageUrls, fileName]);

  const redraw = useCallback(() => {
    const img = imgRef.current;
    const canvas = canvasRef.current;
    const box = containerRef.current;
    if (!img || !canvas || !box || !bbox) return;
    
    // Validate image dimensions
    if (!img.naturalWidth || !img.naturalHeight || img.naturalWidth === 0 || img.naturalHeight === 0) return;
    
    // Validate container dimensions
    const cw = box.clientWidth;
    const ch = box.clientHeight;
    if (!cw || !ch || cw <= 0 || ch <= 0) return;
    
    try {
      drawPredictionSnapshotCrop(canvas, img, bbox, label, cw, ch);
    } catch (err) {
      // Silent catch for canvas errors during rapid resize/unmount
      console.warn("Error drawing prediction snapshot:", err);
    }
  }, [bbox, label]);

  const redrawRef = useRef(redraw);
  redrawRef.current = redraw;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const img = imgRef.current;
      if (img && img.naturalWidth > 0) redrawRef.current();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    redraw();
  }, [activeSrc, bbox, redraw]);

  return (
    <div className="border border-border rounded overflow-hidden bg-muted/30">
      <div ref={containerRef} className="relative w-full h-44 bg-black">
        <img
          ref={imgRef}
          src={activeSrc}
          alt={fileName}
          className={`absolute inset-0 w-full h-full object-contain ${bbox && imageLoaded ? "opacity-0" : ""}`}
          loading="lazy"
          onLoad={() => {
            setImageLoaded(true);
            redraw();
          }}
          onError={() => {
            setImageLoaded(false);
            setSrcIndex((prev) => (prev + 1 < imageUrls.length ? prev + 1 : prev));
          }}
        />
        <canvas
          ref={canvasRef}
          className={`absolute inset-0 pointer-events-none ${bbox ? "" : "hidden"}`}
          aria-hidden
        />
      </div>
      <div className="p-2 border-t border-border">
        <div className="text-xs text-foreground/80 truncate" title={fileName}>
          {fileName}
        </div>
        <div className="text-xs text-muted-foreground">
          {bbox ? `Crop around top detection · ${label}` : "Bounding box unavailable for crop"}
        </div>
      </div>
    </div>
  );
}

export function EvaluationDetailsModal({ open, onOpenChange, taskId, onSaved }: EvaluationDetailsModalProps) {
  const [task, setTask] = useState<TaskDetails | null>(null);
  const [childTasks, setChildTasks] = useState<TaskDetails[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadingAll, setDownloadingAll] = useState(false);
  const [launchingFiftyOne, setLaunchingFiftyOne] = useState(false);
  const [expandedChildId, setExpandedChildId] = useState<number | null>(null);
  const [evalBlobPayload, setEvalBlobPayload] = useState<EvalBlobPayload | null>(null);
  const [evalBlobsLoading, setEvalBlobsLoading] = useState(false);
  const [evalBlobsError, setEvalBlobsError] = useState<string | null>(null);
  const { toast } = useToast();

  const loadTaskDetails = useCallback(
    async (opts?: { silent?: boolean; signal?: AbortSignal }) => {
      const silent = opts?.silent ?? false;
      const signal = opts?.signal;
      const base = getApiBaseUrl();
      if (!silent) {
        setLoading(true);
        setError(null);
      }
      try {
        const response = await fetch(`${base}/tasks/${taskId}`, { signal });
        if (!response.ok) {
          throw new Error(`Failed to fetch evaluation details: ${response.status}`);
        }
        const data = (await response.json()) as TaskDetails;
        if (signal?.aborted) return;
        setTask(data);

        if (data.task_metadata?.is_multi_dataset && data.task_metadata?.child_task_ids?.length) {
          const ids = data.task_metadata.child_task_ids;
          const children = await Promise.all(
            ids.map((id: number) =>
              fetch(`${base}/tasks/${id}`, { signal }).then((r) => {
                if (!r.ok) throw new Error(`Child task ${id}: HTTP ${r.status}`);
                return r.json() as Promise<TaskDetails>;
              })
            )
          );
          if (signal?.aborted) return;
          setChildTasks(children);
        } else {
          setChildTasks([]);
        }
      } catch (err) {
        if (signal?.aborted || (err instanceof DOMException && err.name === "AbortError")) return;
        if (!silent) {
          console.error("Error fetching evaluation details:", err);
          setError(err instanceof Error ? err.message : "Failed to load evaluation details");
        }
      } finally {
        if (!silent && !signal?.aborted) setLoading(false);
      }
    },
    [taskId]
  );

  useEffect(() => {
    if (!open || !taskId) {
      setLoading(false);
      return;
    }
    const ac = new AbortController();
    void loadTaskDetails({ signal: ac.signal });
    return () => {
      ac.abort();
      setLoading(false);
    };
  }, [open, taskId, loadTaskDetails]);

  /** Large predictions/GT live in gzip JSON on disk; fetch after task row loads. */
  useEffect(() => {
    if (!open || !taskId || !task || task.id !== taskId || task.status !== "completed") {
      setEvalBlobPayload(null);
      setEvalBlobsLoading(false);
      setEvalBlobsError(null);
      return;
    }
    const r = task.task_metadata?.results;
    if (!r?.artifacts?.blobs || r.predictions !== undefined) {
      setEvalBlobPayload(null);
      setEvalBlobsLoading(false);
      setEvalBlobsError(null);
      return;
    }
    const ac = new AbortController();
    const base = getApiBaseUrl();
    setEvalBlobsLoading(true);
    setEvalBlobsError(null);
    fetch(`${base}/predictions/evaluation-blobs/${taskId}`, { signal: ac.signal })
      .then(async (res) => {
        if (!res.ok) {
          const t = await res.text();
          throw new Error(t || `HTTP ${res.status}`);
        }
        return res.json() as Promise<EvalBlobPayload>;
      })
      .then((data) => {
        if (ac.signal.aborted) return;
        setEvalBlobPayload({
          predictions: data.predictions ?? [],
          all_ground_truth: data.all_ground_truth ?? [],
          confusion_matrix_samples: data.confusion_matrix_samples,
        });
      })
      .catch((err) => {
        if (ac.signal.aborted) return;
        setEvalBlobPayload(null);
        setEvalBlobsError(err instanceof Error ? err.message : "Failed to load evaluation blobs");
      })
      .finally(() => {
        if (!ac.signal.aborted) setEvalBlobsLoading(false);
      });
    return () => ac.abort();
  }, [open, taskId, task?.id, task?.status, task?.task_metadata?.results?.artifacts?.blobs, task?.task_metadata?.results?.predictions]);

  const mergedResults = useMemo(() => {
    if (!task) return undefined;
    const md = task.task_metadata || {};
    const raw = md.results;
    if (!raw) return undefined;
    if (evalBlobPayload) return { ...raw, ...evalBlobPayload };
    return raw;
  }, [task, evalBlobPayload]);

  const topPredictedClasses = useMemo(() => {
    if (!mergedResults?.class_prediction_counts) return [];
    return Object.entries(mergedResults.class_prediction_counts)
      .map(([className, count]) => ({ className, count: Number(count || 0) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
  }, [mergedResults]);

  const predictionSnapshots = useMemo(() => {
    if (!mergedResults?.predictions || !mergedResults?.image_id_to_filename) return [];
    const projectId = mergedResults.project_id;
    const datasetId = mergedResults.dataset_id;
    if (!projectId || !datasetId) return [];

    const bestByImage = new Map<number, RawPrediction>();
    for (const pred of mergedResults.predictions) {
      const existing = bestByImage.get(pred.image_id);
      if (!existing || pred.conf > existing.conf) {
        bestByImage.set(pred.image_id, pred);
      }
    }

    const encodeFilePath = (name: string) =>
      String(name || "")
        .replace(/\\/g, "/")
        .split("/")
        .map((part) => encodeURIComponent(part))
        .join("/");

    return Array.from(bestByImage.values())
      .sort((a, b) => b.conf - a.conf)
      .slice(0, 6)
      .map((pred) => {
        const fileName = mergedResults.image_id_to_filename?.[String(pred.image_id)] || "";
        const className = mergedResults.class_names?.[pred.class_id] || `Class ${pred.class_id}`;
        const encodedName = encodeFilePath(fileName);
        const base = getApiBaseUrl();
        const imageUrls = [
          `${base}/predictions/evaluation-image/${taskId}/${pred.image_id}`,
          `${base}/static/projects/${projectId}/${datasetId}/images/${encodedName}`,
          `${base}/static/data/images/${datasetId}/${encodedName}`,
        ];
        const bbox = getPredictionBboxXyxy(pred);
        return {
          imageId: pred.image_id,
          fileName,
          className,
          conf: pred.conf,
          imageUrls,
          bbox,
        };
      })
      .filter((item) => !!item.fileName);
  }, [mergedResults, taskId]);

  useEffect(() => {
    if (!open || !taskId) return;

    // Check if any task is running
    const hasRunningTask = task?.status === "running" || childTasks.some((ct) => ct.status === "running");
    
    if (!hasRunningTask) return;

    const interval = setInterval(() => {
      void loadTaskDetails({ silent: true });
    }, 3000);
    return () => clearInterval(interval);
  }, [open, taskId, task?.status, childTasks, loadTaskDetails]);

  const refreshTaskMetadata = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(`${getApiBaseUrl()}/tasks/${taskId}`, { signal });
      if (!response.ok) return;
      if (signal?.aborted) return;
      const data = (await response.json()) as TaskDetails;
      if (signal?.aborted) return;
      setTask(data);
      onSaved?.();
    } catch (err) {
      if (signal?.aborted || (err instanceof DOMException && err.name === "AbortError")) return;
      /* silent */
    }
  }, [taskId, onSaved]);

  const downloadCocoResults = async (taskIdToDownload?: number) => {
    const downloadTaskId = taskIdToDownload || taskId;
    const isChild = !!taskIdToDownload;
    const sourceTask = isChild
      ? childTasks.find((ct) => ct.id === downloadTaskId)
      : task;
    const predCount = sourceTask?.task_metadata?.results?.predictions_count || 0;
    if (predCount <= 0) {
      toast({
        title: "No Predictions",
        description: "There are no predictions for this evaluation, so COCO download is unavailable.",
        variant: "destructive"
      });
      return;
    }
    
    setDownloading(true);
    try {
      const response = await fetch(`${getApiBaseUrl()}/predictions/export-coco/${downloadTaskId}`);
      
      if (!response.ok) {
        let message = 'Failed to download results';
        try {
          const errorData = await response.json();
          message = errorData.detail || errorData.message || message;
        } catch {
          const text = await response.text();
          if (text) message = text;
        }
        throw new Error(message);
      }
      
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const evalLabel = isChild ? (task?.name ?? "") : (sourceTask?.name ?? task?.name ?? "");
      const datasetLabel = sourceTask?.task_metadata?.dataset_name ?? undefined;
      const fallbackJson = evaluationCocoJsonDownloadName({
        taskId: downloadTaskId,
        evaluationName: evalLabel || sourceTask?.name || task?.name,
        datasetName: datasetLabel,
      });
      a.download =
        attachmentFilenameFromContentDisposition(response.headers.get("content-disposition")) ??
        fallbackJson;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      
      toast({
        title: "Download Complete",
        description: "COCO format results have been downloaded"
      });
    } catch (err) {
      console.error('Error downloading COCO results:', err);
      toast({
        title: "Download Failed",
        description: err instanceof Error ? err.message : "Failed to download evaluation results",
        variant: "destructive"
      });
    } finally {
      setDownloading(false);
    }
  };

  const downloadAllCocoResults = async () => {
    if (!task?.task_metadata?.is_multi_dataset) return;
    const totalPredictions = childTasks.reduce(
      (sum, ct) => sum + (ct.task_metadata?.results?.predictions_count || 0),
      0
    );
    if (totalPredictions <= 0) {
      toast({
        title: "No Predictions",
        description: "No child evaluations contain predictions yet, so ZIP export is unavailable.",
        variant: "destructive"
      });
      return;
    }
    
    setDownloadingAll(true);
    try {
      const response = await fetch(`${getApiBaseUrl()}/predictions/export-coco-all/${taskId}`);
      
      if (!response.ok) {
        let message = 'Failed to download results';
        try {
          const errorData = await response.json();
          message = errorData.detail || errorData.message || message;
        } catch {
          const text = await response.text();
          if (text) message = text;
        }
        throw new Error(message);
      }
      
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const fallbackZip = evaluationCocoZipDownloadName({
        taskId,
        evaluationName: task?.name,
      });
      a.download =
        attachmentFilenameFromContentDisposition(response.headers.get("content-disposition")) ??
        fallbackZip;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      
      toast({
        title: "Download Complete",
        description: "All COCO format results have been downloaded as a ZIP file"
      });
    } catch (err) {
      console.error('Error downloading all COCO results:', err);
      toast({
        title: "Download Failed",
        description: err instanceof Error ? err.message : "Failed to download evaluation results",
        variant: "destructive"
      });
    } finally {
      setDownloadingAll(false);
    }
  };

  const viewInFiftyOne = async () => {
    if (!task || task.status !== 'completed') return;
    const predCount = task.task_metadata?.results?.predictions_count || 0;
    if (predCount <= 0) {
      toast({
        title: "No Predictions",
        description: "There are no predictions for this evaluation, so FiftyOne cannot be opened.",
        variant: "destructive"
      });
      return;
    }

    // Open a placeholder tab from the direct click event to avoid popup blockers.
    const fiftyOneTab = window.open('', '_blank');
    if (fiftyOneTab) {
      fiftyOneTab.document.title = 'Launching FiftyOne...';
      fiftyOneTab.document.body.innerHTML = '<p style="font-family: sans-serif; padding: 16px;">Starting FiftyOne. This page will redirect automatically...</p>';
    }
    
    setLaunchingFiftyOne(true);
    toast({
      title: "Starting FiftyOne",
      description: "Please wait 10-60 seconds while FiftyOne initializes. Keep this page open.",
    });
    try {
      const response = await fetch(`${getApiBaseUrl()}/predictions/view-fiftyone/${taskId}`, {
        method: "POST",
      });
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ detail: 'Failed to launch FiftyOne' }));
        throw new Error(errorData.detail || 'Failed to launch FiftyOne');
      }
      
      const data = await response.json();
      const targetUrl = data.url || 'http://localhost:5151';
      
      toast({
        title: "FiftyOne Launched",
        description: data.message || `FiftyOne is starting. Check ${targetUrl}`
      });

      if (fiftyOneTab && !fiftyOneTab.closed) {
        fiftyOneTab.location.href = targetUrl;
      } else {
        // Fallback if popup was blocked or manually closed.
        window.open(targetUrl, '_blank');
      }
      
    } catch (err) {
      console.error('Error launching FiftyOne:', err);
      if (fiftyOneTab && !fiftyOneTab.closed) {
        fiftyOneTab.close();
      }
      toast({
        title: "Launch Failed",
        description: err instanceof Error ? err.message : "Failed to launch FiftyOne",
        variant: "destructive"
      });
    } finally {
      setLaunchingFiftyOne(false);
    }
  };

  if (loading) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-6xl max-h-[90vh] overflow-y-auto bg-background">
          <DialogTitle className="sr-only">Loading evaluation details</DialogTitle>
          <div className="flex items-center justify-center p-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  if (error || !task) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-6xl bg-background">
          <DialogTitle className="sr-only">Evaluation error</DialogTitle>
          <div className="text-center p-8 text-destructive">
            {error || 'Evaluation not found'}
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  const metadata = task.task_metadata || {};
  const results = mergedResults;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-6xl max-h-[90vh] overflow-y-auto bg-background">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <div>
              <DialogTitle className="text-xl font-semibold flex items-center gap-2">
                <Brain className="w-6 h-6 text-primary" />
                {task.name}
              </DialogTitle>
              <div className="text-sm text-muted-foreground mt-2">
                Task #{task.id} • Started {new Date(task.created_at).toLocaleString()}
                {task.completed_at && ` • Completed in ${formatDuration(task.created_at, task.completed_at)}`}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <StatusBadge status={task.status} />
              {task.status === 'completed' && results && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={viewInFiftyOne}
                    disabled={launchingFiftyOne}
                    className="ml-2"
                  >
                    {launchingFiftyOne ? (
                      <>
                        <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-current mr-2" />
                        Launching...
                      </>
                    ) : (
                      <>
                        <Eye className="w-4 h-4 mr-2" />
                        View in FiftyOne
                      </>
                    )}
                  </Button>
                </>
              )}
              {/* Download All for multi-dataset evaluations */}
              {metadata.is_multi_dataset && childTasks.some(ct => ct.status === 'completed') && (
                <Button
                  variant="default"
                  size="sm"
                  onClick={downloadAllCocoResults}
                  disabled={downloadingAll}
                  className="ml-2"
                >
                  {downloadingAll ? (
                    <>
                      <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-current mr-2" />
                      Downloading...
                    </>
                  ) : (
                    <>
                      <Database className="w-4 h-4 mr-2" />
                      Download All COCO
                    </>
                  )}
                </Button>
              )}
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-6 mt-6">
          {/* Multi-dataset indicator */}
          {metadata.is_multi_dataset && (
            <div className="bg-blue-950/50 border border-blue-800 rounded-lg p-4">
              <h3 className="text-lg font-semibold mb-2 flex items-center gap-2">
                <Database className="w-5 h-5 text-primary" />
                Multi-Dataset Evaluation
                <Badge variant="secondary">{childTasks.length} datasets</Badge>
              </h3>
              <p className="text-sm text-muted-foreground">
                This evaluation runs across multiple datasets. Click on each dataset below to see individual results.
              </p>
            </div>
          )}

          {/* Configuration Info */}
          <div className="bg-card border border-border rounded-lg p-4">
            <h3 className="text-lg font-semibold mb-3 flex items-center gap-2">
              <Activity className="w-5 h-5 text-primary" />
              Configuration
            </h3>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
              <div>
                <span className="text-muted-foreground">Training Model:</span>
                <span className="ml-2 text-foreground font-medium">{metadata.training_task_name || '-'}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Test Dataset:</span>
                <span className="ml-2 text-foreground font-medium">
                  {metadata.is_multi_dataset 
                    ? `${metadata.dataset_names?.join(', ') || 'Multiple'}` 
                    : metadata.dataset_name || '-'}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">Checkpoint:</span>
                <span className="ml-2 text-foreground font-medium">{metadata.checkpoint || 'best'}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Confidence Threshold:</span>
                <span className="ml-2 text-foreground font-medium">{metadata.conf_threshold || 0.25}</span>
              </div>
              <div>
                <span className="text-muted-foreground">IoU Threshold:</span>
                <span className="ml-2 text-foreground font-medium">{metadata.iou_threshold || 0.45}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Image Size:</span>
                <span className="ml-2 text-foreground font-medium">
                  {(() => {
                    const m: any = metadata;
                    const sz = m.image_size ?? m.imgsz ?? m.training_params?.image_size ?? m.training_params?.imgsz;
                    return sz ? `${sz}px` : '-';
                  })()}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">Ground Truth:</span>
                <span className="ml-2 text-foreground font-medium">
                  {metadata.has_ground_truth ? (
                    (metadata as any).annotation_file_name ? (
                      <span title={(metadata as any).annotation_file_name}>
                        Yes ({(metadata as any).annotation_file_name})
                      </span>
                    ) : 'Yes'
                  ) : 'No'}
                </span>
              </div>
              {metadata.use_grid && (
                <>
                  <div>
                    <span className="text-muted-foreground">Grid Inference:</span>
                    <span className="ml-2 text-foreground font-medium">Enabled</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Grid Tile Size:</span>
                    <span className="ml-2 text-foreground font-medium">{metadata.grid_size}px</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Grid Overlap:</span>
                    <span className="ml-2 text-foreground font-medium">{((metadata.grid_overlap || 0) * 100).toFixed(0)}%</span>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Error Message for Failed Evaluations */}
          {task.status === 'failed' && (
            <div className="border border-destructive/40 bg-destructive/10 rounded-lg p-4">
              <h3 className="text-lg font-semibold mb-2 flex items-center gap-2 text-destructive">
                <AlertCircle className="w-5 h-5" />
                Evaluation Failed
              </h3>
              <p className="text-sm text-destructive font-mono whitespace-pre-wrap break-words">
                {task.error_message || 'An unknown error occurred during evaluation. Please check the backend logs for more details.'}
              </p>
            </div>
          )}

          {/* Results */}
          {results && task.status === 'completed' && (
            <>
              {launchingFiftyOne && (
                <div className="rounded border border-blue-900/60 bg-blue-950/30 px-3 py-2 text-sm text-blue-200">
                  FiftyOne is starting. Please wait; first launch may take up to a minute.
                </div>
              )}
              <div className="bg-card border border-border rounded-lg p-4">
                <h3 className="text-lg font-semibold mb-3 flex items-center gap-2">
                  <Activity className="w-5 h-5 text-primary" />
                  Evaluation Statistics
                </h3>
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
                  <div className="bg-muted/30/60 border border-border rounded p-3">
                    <div className="text-xs text-muted-foreground">Images</div>
                    <div className="text-lg font-semibold text-foreground">{results.images_processed ?? 0}</div>
                  </div>
                  <div className="bg-muted/30/60 border border-border rounded p-3">
                    <div className="text-xs text-muted-foreground">Predictions</div>
                    <div className="text-lg font-semibold text-foreground">{results.predictions_count ?? 0}</div>
                  </div>
                  <div className="bg-muted/30/60 border border-border rounded p-3">
                    <div className="text-xs text-muted-foreground">Predictions / Image</div>
                    <div className="text-lg font-semibold text-foreground">
                      {Number(results.predictions_per_image ?? 0).toFixed(2)}
                    </div>
                  </div>
                  <div className="bg-muted/30/60 border border-border rounded p-3">
                    <div className="text-xs text-muted-foreground">Avg Confidence</div>
                    <div className="text-lg font-semibold text-foreground">
                      {`${(Number(results.avg_confidence ?? 0) * 100).toFixed(1)}%`}
                    </div>
                  </div>
                  <div className="bg-muted/30/60 border border-border rounded p-3">
                    <div className="text-xs text-muted-foreground">Precision</div>
                    <div className="text-lg font-semibold text-foreground">
                      {results.has_ground_truth ? `${(results.precision * 100).toFixed(1)}%` : 'N/A'}
                    </div>
                  </div>
                  <div className="bg-muted/30/60 border border-border rounded p-3">
                    <div className="text-xs text-muted-foreground">F1 Score</div>
                    <div className="text-lg font-semibold text-foreground">
                      {results.has_ground_truth ? `${(results.f1_score * 100).toFixed(1)}%` : 'N/A'}
                    </div>
                  </div>
                </div>
              </div>
              <div className="bg-card border border-border rounded-lg p-4">
                <h3 className="text-lg font-semibold mb-3">Top Predicted Classes</h3>
                {topPredictedClasses.length > 0 ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
                    {topPredictedClasses.map((item) => (
                      <div
                        key={item.className}
                        className="bg-muted/30/60 border border-border rounded p-3"
                      >
                        <div className="text-sm text-foreground truncate" title={item.className}>
                          {item.className}
                        </div>
                        <div className="text-lg font-semibold text-foreground">{item.count}</div>
                        <div className="text-xs text-muted-foreground">predictions</div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground">No predictions available yet.</div>
                )}
              </div>
              <div className="bg-card border border-border rounded-lg p-4">
                <h3 className="text-lg font-semibold mb-3">Prediction Snapshot Examples</h3>
                {predictionSnapshots.length > 0 ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {predictionSnapshots.map((snap) => (
                      <PredictionSnapshotCard
                        key={snap.imageId}
                        imageUrls={snap.imageUrls}
                        fileName={snap.fileName}
                        className={snap.className}
                        conf={snap.conf}
                        bbox={snap.bbox}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground">
                    Snapshot examples become available after prediction blobs are loaded.
                  </div>
                )}
              </div>
              {evalBlobsLoading &&
                metadata.results?.artifacts?.blobs &&
                metadata.results.predictions === undefined && (
                  <div className="text-sm text-muted-foreground py-2">
                    Loading interactive evaluation data…
                  </div>
                )}
              {evalBlobsError && (
                <div className="text-sm text-destructive py-2 rounded border border-destructive/40 px-3 bg-destructive/10">
                  {evalBlobsError}
                </div>
              )}
              {/* Threshold Explorer — adjust conf/IoU and see live metrics */}
              {results.all_ground_truth &&
                results.predictions !== undefined &&
                (results.predictions.length > 0 || results.all_ground_truth.length > 0) && (
                <ThresholdExplorer
                  predictions={results.predictions}
                  groundTruth={results.all_ground_truth}
                  classNames={results.class_names}
                  imageIdToFilename={results.image_id_to_filename ?? {}}
                  projectId={results.project_id ?? 0}
                  datasetId={results.dataset_id ?? 0}
                  initialConf={results.conf_threshold ?? metadata.conf_threshold ?? 0.25}
                  initialIou={results.iou_threshold ?? metadata.iou_threshold ?? 0.45}
                  initialPerClassConf={results.per_class_conf}
                  taskId={taskId}
                  onSaved={refreshTaskMetadata}
                  evaluationName={task.name}
                  datasetName={metadata.dataset_name}
                />
              )}
            </>
          )}

          {/* Child Tasks for Multi-Dataset Evaluations */}
          {metadata.is_multi_dataset && childTasks.length > 0 && (
            <div className="bg-card border border-border rounded-lg p-4">
              <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                <Database className="w-5 h-5 text-primary" />
                Per-Dataset Results
              </h3>
              <div className="space-y-3">
                {childTasks.map((childTask) => {
                  const childMetadata = childTask.task_metadata || {};
                  const childResults = childMetadata.results;
                  const isExpanded = expandedChildId === childTask.id;
                  
                  return (
                    <div key={childTask.id} className="border border-border rounded-lg overflow-hidden">
                      {/* Child Task Header */}
                      <button
                        onClick={() => setExpandedChildId(isExpanded ? null : childTask.id)}
                        className="w-full flex items-center justify-between p-3 hover:bg-muted/50 transition-colors"
                      >
                        <div className="flex items-center gap-3">
                          <ChevronDown className={`w-4 h-4 transition-transform ${isExpanded ? '' : '-rotate-90'}`} />
                          <span className="font-medium">{childMetadata.dataset_name || `Dataset ${childTask.id}`}</span>
                          <StatusBadge status={childTask.status} />
                        </div>
                        <div className="flex items-center gap-4 text-sm text-muted-foreground">
                          {childTask.status === 'completed' && childResults && (
                            <>
                              <span>
                                F1: {childResults.has_ground_truth ? `${(childResults.f1_score * 100).toFixed(1)}%` : 'N/A'}
                              </span>
                              <span>{childResults.images_processed} images</span>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  downloadCocoResults(childTask.id);
                                }}
                                className="h-7 px-2"
                              >
                                <Download className="w-3 h-3 mr-1" />
                                COCO
                              </Button>
                            </>
                          )}
                          {childTask.status === 'running' && (
                            <span>{childTask.progress}%</span>
                          )}
                        </div>
                      </button>
                      
                      {/* Child Task Expanded Content */}
                      {isExpanded && childTask.status === 'completed' && childResults && (
                        <div className="p-4 border-t border-border bg-muted/30">
                          {/* Metrics Grid */}
                          <div className="grid grid-cols-5 gap-3 mb-4">
                            <div className="bg-muted/50 rounded p-3 text-center">
                              <div className="text-xs text-muted-foreground mb-1">Precision</div>
                              <div className="text-lg font-semibold text-foreground">
                                {childResults.has_ground_truth ? `${(childResults.precision * 100).toFixed(1)}%` : 'N/A'}
                              </div>
                            </div>
                            <div className="bg-muted/50 rounded p-3 text-center">
                              <div className="text-xs text-muted-foreground mb-1">Recall</div>
                              <div className="text-lg font-semibold text-foreground">
                                {childResults.has_ground_truth ? `${(childResults.recall * 100).toFixed(1)}%` : 'N/A'}
                              </div>
                            </div>
                            <div className="bg-muted/50 rounded p-3 text-center">
                              <div className="text-xs text-muted-foreground mb-1">F1 Score</div>
                              <div className="text-lg font-semibold text-foreground">
                                {childResults.has_ground_truth ? `${(childResults.f1_score * 100).toFixed(1)}%` : 'N/A'}
                              </div>
                            </div>
                            <div className="bg-muted/50 rounded p-3 text-center">
                              <div className="text-xs text-muted-foreground mb-1">Predictions</div>
                              <div className="text-lg font-semibold text-foreground">
                                {childResults.predictions_count}
                              </div>
                            </div>
                            <div className="bg-muted/50 rounded p-3 text-center">
                              <div className="text-xs text-muted-foreground mb-1">Images</div>
                              <div className="text-lg font-semibold text-foreground">
                                {childResults.images_processed}
                              </div>
                            </div>
                          </div>
                          
                          {/* Inference Time */}
                          <div className="text-sm text-muted-foreground">
                            <span>Inference Time: {childResults.inference_time_ms?.toFixed(0) || 0}ms</span>
                            <span className="ml-4">
                              Avg: {childResults.images_processed > 0 
                                ? (childResults.inference_time_ms / childResults.images_processed).toFixed(1) 
                                : 0}ms/image
                            </span>
                          </div>
                        </div>
                      )}
                      
                      {/* Running Progress */}
                      {isExpanded && childTask.status === 'running' && (
                        <div className="p-4 border-t border-border bg-muted/30">
                          <div className="flex items-center gap-4">
                            <div className="flex-1">
                              <div className="w-full bg-muted rounded-full h-2">
                                <div
                                  className="bg-primary h-2 rounded-full transition-all"
                                  style={{ width: `${childTask.progress}%` }}
                                />
                              </div>
                            </div>
                            <span className="text-sm text-muted-foreground">{childTask.progress}%</span>
                          </div>
                        </div>
                      )}

                      {/* Failed Error Message */}
                      {isExpanded && childTask.status === 'failed' && (
                        <div className="p-4 border-t border-border bg-destructive/10">
                          <div className="flex items-start gap-2">
                            <AlertCircle className="w-4 h-4 text-destructive mt-0.5 flex-shrink-0" />
                            <p className="text-sm text-destructive font-mono whitespace-pre-wrap break-words">
                              {childTask.error_message || 'An unknown error occurred during evaluation.'}
                            </p>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Progress for running tasks */}
          {task.status === 'running' && (
            <div className="bg-card border border-border rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium">Progress</span>
                <span className="text-sm text-muted-foreground">{task.progress}%</span>
              </div>
              <div className="w-full bg-muted rounded-full h-2">
                <div
                  className="bg-primary h-2 rounded-full transition-all duration-300"
                  style={{ width: `${task.progress}%` }}
                />
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
