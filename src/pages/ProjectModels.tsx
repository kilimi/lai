import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, Link, useOutletContext, useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useApi } from '@/hooks/use-api';
import { useToast } from '@/hooks/use-toast';
import { TrainModelModal } from '@/components/TrainModelModal';
import { TrainingDetailsModal } from '@/components/TrainingDetailsModal';
import { DownloadModelModal } from '@/components/DownloadModelModal';
import { TestTrainingInferenceModal } from '@/components/TestTrainingInferenceModal';
import { ImportModelModal } from '@/components/ImportModelModal';
import { AlertCircle, Search, SlidersHorizontal, Brain, Trash2, Pencil, Download, TestTube, RotateCw, Upload } from "lucide-react";
import { TrainingCard } from "@/components/TrainingCard";
import { Project, DatasetGroup } from '@/types';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { buildApiUrl } from "@/config/api";

interface OutletContext {
  project: Project | null;
  loading: boolean;
}

// Helper functions
const getModelFamily = (modelName: string) => {
  if (!modelName) return '-';
  const lower = modelName.toLowerCase();
  if (lower.includes('yolo26')) return 'YOLO26';
  if (lower.includes('yolo11')) return 'YOLO11';
  if (modelName.includes('yolo') || modelName.includes('YOLO')) return 'YOLO';
  if (modelName.includes('rtdetr') || modelName.includes('RT-DETR')) return 'RT-DETR';
  return modelName;
};

const getModelSize = (modelName: string) => {
  if (!modelName) return '-';
  const lower = modelName.toLowerCase();
  
  // YOLO sizes (nano, small, medium, large, x-large)
  if (lower.includes('yolo')) {
    // Match patterns like: yolo11n, yolov8s, yolo11n-seg, yolov8m-cls, etc.
    const match = modelName.match(/yolo(?:v?\d+)?([nsmxl])(?:-|\.)/i);
    if (match) {
      const size = match[1].toLowerCase();
      const sizeMap: Record<string, string> = {
        'n': 'Nano',
        's': 'Small',
        'm': 'Medium',
        'l': 'Large',
        'x': 'X-Large'
      };
      return sizeMap[size] || size.toUpperCase();
    }
  }
  
  // RT-DETR sizes
  if (lower.includes('rtdetr') || lower.includes('rt-detr')) {
    if (lower.includes('r18')) return 'ResNet-18';
    if (lower.includes('r34')) return 'ResNet-34';
    if (lower.includes('r50')) return 'ResNet-50';
    if (lower.includes('r101')) return 'ResNet-101';
    if (lower.includes('l')) return 'Large';
    if (lower.includes('x')) return 'X-Large';
  }
  
  return '-';
};

export default function ProjectModels() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { project } = useOutletContext<OutletContext>();
  const { isConnected } = useApi();
  const { toast } = useToast();
  
  const [trainingTasks, setTrainingTasks] = useState<any[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(true);
  const [modelsSearchQuery, setModelsSearchQuery] = useState("");
  const [modelsSortOrder, setModelsSortOrder] = useState<"newest" | "oldest" | "name" | "accuracy" | "performance">("newest");
  const [showTrainModelModal, setShowTrainModelModal] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);
  const [selectedTaskError, setSelectedTaskError] = useState<{ name: string; error: string; id: number } | null>(null);
  const [deletingFailedTasks, setDeletingFailedTasks] = useState(false);
  const [statusFilter, setStatusFilter] = useState<"all" | "running" | "completed" | "failed">("all");
  const [renamingTask, setRenamingTask] = useState<{ id: number; name: string } | null>(null);
  const [newTaskName, setNewTaskName] = useState('');
  const [datasets, setDatasets] = useState<any[]>([]);
  const [datasetGroups, setDatasetGroups] = useState<DatasetGroup[]>([]);
  const [modalResourcesLoading, setModalResourcesLoading] = useState(false);
  const [downloadModel, setDownloadModel] = useState<{ id: number; name: string } | null>(null);
  const [testInference, setTestInference] = useState<{ id: number; name: string } | null>(null);
  const [trainModalCloneTaskId, setTrainModalCloneTaskId] = useState<number | null>(null);
  const [pendingDeleteTask, setPendingDeleteTask] = useState<any | null>(null);
  const [pendingStopTask, setPendingStopTask] = useState<any | null>(null);
  const [showDeleteFailedConfirm, setShowDeleteFailedConfirm] = useState(false);
  const [showDeleteAllConfirm, setShowDeleteAllConfirm] = useState(false);
  const [deletingAllTasks, setDeletingAllTasks] = useState(false);
  const [showImportModelModal, setShowImportModelModal] = useState(false);

  const trainingTasksRef = useRef<any[]>([]);
  trainingTasksRef.current = trainingTasks;

  /** Only training tasks, small metadata (no huge eval payloads mixed in). */
  const fetchTrainingTasks = useCallback(async () => {
    if (!id) return;

    setLoadingTasks(true);
    try {
      const response = await fetch(
        buildApiUrl("/tasks/", {
          project_id: id,
          task_type: "yolo_training,training,mmyolo_training",
          metadata_mode: "list",
          limit: "200",
        })
      );
      if (response.ok) {
        const data = await response.json();
        setTrainingTasks(Array.isArray(data) ? data : []);
      } else {
        setTrainingTasks([]);
      }
    } catch (error) {
      console.error('Error fetching training tasks:', error);
      setTrainingTasks([]);
    } finally {
      setLoadingTasks(false);
    }
  }, [id]);

  const loadTrainModalResources = useCallback(async () => {
    if (!id) return;
    setModalResourcesLoading(true);
    try {
      const [dsRes, dgRes] = await Promise.all([
        fetch(buildApiUrl(`/projects/${id}/datasets/list`)),
        fetch(buildApiUrl(`/projects/${id}/dataset-groups/`)),
      ]);
      if (dsRes.ok) {
        const result = await dsRes.json();
        if (result.success && result.data) setDatasets(result.data);
      }
      if (dgRes.ok) {
        const result = await dgRes.json();
        if (result.success) setDatasetGroups(result.data);
      }
    } catch (error) {
      console.error('Error loading train modal data:', error);
    } finally {
      setModalResourcesLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (!id) return;
    fetchTrainingTasks();

    const interval = setInterval(() => {
      if (
        trainingTasksRef.current.some(
          (t) => t.status === 'running' || t.status === 'pending'
        )
      ) {
        fetchTrainingTasks();
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [id, fetchTrainingTasks]);

  // Support deep-linking directly into Training Details modal from
  // task-related navigation (e.g. Active Tasks "Go to").
  useEffect(() => {
    const taskIdParam = searchParams.get('taskId');
    if (!taskIdParam) return;
    const parsed = parseInt(taskIdParam, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      setSelectedTaskId(parsed);
    }
  }, [searchParams]);

  useEffect(() => {
    if (!showTrainModelModal || !id) return;
    loadTrainModalResources();
  }, [showTrainModelModal, id, loadTrainModalResources]);

  const handleDeleteFailedTasks = async () => {
    const failedTasks = trainingTasks.filter(t => t.status === 'failed');
    if (failedTasks.length === 0) return;

    setDeletingFailedTasks(true);
    try {
      for (const task of failedTasks) {
        await fetch(buildApiUrl(`/tasks/${task.id}`), { method: 'DELETE' });
      }
      toast({
        title: "Tasks Deleted",
        description: `${failedTasks.length} failed task(s) have been deleted.`
      });
      fetchTrainingTasks();
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to delete some tasks",
        variant: "destructive"
      });
    } finally {
      setDeletingFailedTasks(false);
      setShowDeleteFailedConfirm(false);
    }
  };

  const handleDeleteAllTasks = async () => {
    if (trainingTasks.length === 0) return;

    setDeletingAllTasks(true);
    try {
      for (const task of trainingTasks) {
        const response = await fetch(buildApiUrl(`/tasks/${task.id}`), { method: 'DELETE' });
        if (!response.ok) {
          throw new Error(`Failed to delete task ${task.id}`);
        }
      }
      toast({
        title: "All Models Deleted",
        description: `${trainingTasks.length} training task(s) have been deleted.`,
      });
      setSelectedTaskId(null);
      fetchTrainingTasks();
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to delete some tasks",
        variant: "destructive",
      });
    } finally {
      setDeletingAllTasks(false);
      setShowDeleteAllConfirm(false);
    }
  };

  // Filter tasks based on search
  const filteredTasks = trainingTasks.filter(task => {
    if (!modelsSearchQuery) return true;
    const query = modelsSearchQuery.toLowerCase();
    return task.name.toLowerCase().includes(query);
  });

  const statusFilteredTasks = filteredTasks.filter(t => {
    if (statusFilter === "all") return true;
    if (statusFilter === "running") return t.status === "running" || t.status === "pending";
    return t.status === statusFilter;
  });

  // Sort tasks
  const sortedTasks = [...statusFilteredTasks].sort((a, b) => {
    switch (modelsSortOrder) {
      case "newest":
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      case "oldest":
        return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      case "name":
        return a.name.localeCompare(b.name);
      default:
        return 0;
    }
  });

  const failedTasksCount = trainingTasks.filter(t => t.status === 'failed').length;
  const runningTasksCount = trainingTasks.filter(
    (t) => t.status === 'running' || t.status === 'pending'
  ).length;

  const statusCounts = {
    all: trainingTasks.length,
    running: trainingTasks.filter(t => t.status === "running" || t.status === "pending").length,
    completed: trainingTasks.filter(t => t.status === "completed").length,
    failed: failedTasksCount,
  };

  // Action handlers (extracted so cards can call them)
  const handleRerunTask = async (task: any) => {
    try {
      const response = await fetch(buildApiUrl(`/training/${task.id}/rerun`), { method: 'POST' });
      if (response.ok) {
        const data = await response.json();
        toast({ title: "Training Rerun Started", description: `New training task "${data.task.name}" has been created and started.` });
        fetchTrainingTasks();
      } else {
        const errorData = await response.json();
        throw new Error(errorData.detail || 'Failed to rerun training task');
      }
    } catch (error) {
      toast({ title: "Error", description: error instanceof Error ? error.message : "Failed to rerun training task", variant: "destructive" });
    }
  };

  const performDeleteTask = async (task: any) => {
    try {
      const response = await fetch(buildApiUrl(`/tasks/${task.id}`), { method: 'DELETE' });
      if (response.ok) {
        toast({ title: "Task Deleted", description: `Training task "${task.name}" has been deleted.` });
        fetchTrainingTasks();
      } else {
        const data = await response.json();
        throw new Error(data.detail || 'Failed to delete task');
      }
    } catch (error) {
      toast({ title: "Error", description: error instanceof Error ? error.message : "Failed to delete training task", variant: "destructive" });
    } finally {
      setPendingDeleteTask(null);
    }
  };

  const handleDeleteTask = (task: any) => {
    setPendingDeleteTask(task);
  };

  const performStopTask = async (task: any) => {
    try {
      const response = await fetch(buildApiUrl(`/tasks/${task.id}/cancel`), { method: 'PATCH' });
      if (response.ok) {
        toast({ title: "Training Stopped", description: `Task "${task.name}" has been cancelled.` });
        fetchTrainingTasks();
      } else {
        throw new Error('Failed to cancel task');
      }
    } catch {
      toast({ title: "Error", description: "Failed to stop training task", variant: "destructive" });
    } finally {
      setPendingStopTask(null);
    }
  };

  const handleStopTask = (task: any) => {
    setPendingStopTask(task);
  };

  const handlePauseTask = async (task: any) => {
    try {
      const response = await fetch(buildApiUrl(`/tasks/${task.id}/pause`), { method: 'PATCH' });
      if (response.ok) {
        toast({ title: "Training Paused", description: `Task "${task.name}" will pause at the next epoch boundary and save a checkpoint.` });
        fetchTrainingTasks();
      } else {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.detail || 'Failed to pause task');
      }
    } catch (error) {
      toast({ title: "Error", description: error instanceof Error ? error.message : "Failed to pause training task", variant: "destructive" });
    }
  };

  const handleResumeTask = async (task: any) => {
    try {
      const response = await fetch(buildApiUrl(`/tasks/${task.id}/resume`), { method: 'PATCH' });
      if (response.ok) {
        const data = await response.json();
        toast({ title: "Training Resumed", description: `New training task #${data.new_task_id} started from saved checkpoint.` });
        fetchTrainingTasks();
      } else {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.detail || 'Failed to resume task');
      }
    } catch (error) {
      toast({ title: "Error", description: error instanceof Error ? error.message : "Failed to resume training task", variant: "destructive" });
    }
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-center gap-2">
        <Brain className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold">Train Model</h1>
        <Badge variant="secondary" className="ml-2">
          {trainingTasks.length} training tasks
        </Badge>
      </div>
      
      {/* Search and Filter Controls */}
      <div className="flex flex-col sm:flex-row gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
          <Input
            placeholder="Search training tasks by name, type or performance..."
            className="pl-9"
            value={modelsSearchQuery}
            onChange={(e) => setModelsSearchQuery(e.target.value)}
          />
        </div>
        
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="text-muted-foreground h-4 w-4" />
          <Select value={modelsSortOrder} onValueChange={(value) => setModelsSortOrder(value as any)}>
            <SelectTrigger className="min-w-[180px]">
              <SelectValue placeholder="Sort by" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">Newest first</SelectItem>
              <SelectItem value="oldest">Oldest first</SelectItem>
              <SelectItem value="name">Name (A-Z)</SelectItem>
              <SelectItem value="accuracy">Best accuracy</SelectItem>
              <SelectItem value="performance">Best performance</SelectItem>
            </SelectContent>
          </Select>
          
          <Button
            variant="outline"
            size="sm"
            className="whitespace-nowrap ml-2"
            onClick={() => setShowImportModelModal(true)}
          >
            <Upload className="w-4 h-4 mr-2" />
            Import Model
          </Button>

          <Button 
            variant="default" 
            size="sm" 
            className="whitespace-nowrap ml-2"
            onClick={() => {
              setTrainModalCloneTaskId(null);
              setShowTrainModelModal(true);
            }}
          >
            <Brain className="w-4 h-4 mr-2" />
            Train Model
          </Button>
          
          {trainingTasks.length > 0 && (
            <Button
              variant="destructive"
              size="sm"
              className="whitespace-nowrap ml-2"
              onClick={() => setShowDeleteAllConfirm(true)}
              disabled={deletingAllTasks || deletingFailedTasks}
            >
              <Trash2 className="w-4 h-4 mr-2" />
              {deletingAllTasks ? 'Deleting...' : `Delete All (${trainingTasks.length})`}
            </Button>
          )}

          {failedTasksCount > 0 && (
            <Button 
              variant="outline" 
              size="sm" 
              className="whitespace-nowrap ml-2 text-destructive hover:text-destructive"
              onClick={() => setShowDeleteFailedConfirm(true)}
              disabled={deletingFailedTasks || deletingAllTasks}
            >
              <Trash2 className="w-4 h-4 mr-2" />
              {deletingFailedTasks ? 'Deleting...' : `Delete Failed (${failedTasksCount})`}
            </Button>
          )}
        </div>
      </div>

      {/* Status filter chips */}
      <div className="flex items-center gap-2 flex-wrap">
        {([
          { key: "all", label: "All" },
          { key: "running", label: "Running" },
          { key: "completed", label: "Completed" },
          { key: "failed", label: "Failed" },
        ] as const).map(({ key, label }) => {
          const active = statusFilter === key;
          const count = statusCounts[key];
          return (
            <button
              key={key}
              onClick={() => setStatusFilter(key)}
              className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm border transition-colors ${
                active
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-muted/40 text-muted-foreground border-border hover:bg-muted"
              }`}
            >
              <span>{label}</span>
              <span className={`text-xs tabular-nums ${active ? "opacity-90" : "opacity-70"}`}>
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Content */}
      {loadingTasks && trainingTasks.length === 0 ? (
        <div className="text-center py-16">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto"></div>
          <p className="text-muted-foreground mt-4">Loading training tasks...</p>
        </div>
      ) : isConnected === false ? (
        <div className="text-center py-16">
          <AlertCircle className="w-12 h-12 mx-auto mb-4 text-destructive" />
          <h3 className="text-lg font-medium mb-2">API Connection Error</h3>
          <p className="text-muted-foreground mb-6">
            Unable to connect to the backend server. Please check your API settings.
          </p>
          <div className="flex gap-3 justify-center">
            <Button variant="outline" onClick={() => window.location.reload()}>
              Retry
            </Button>
            <Button variant="outline" asChild>
              <Link to="/settings">Check Settings</Link>
            </Button>
          </div>
        </div>
      ) : sortedTasks.length > 0 ? (
        <div className="space-y-3">
          {sortedTasks.map((task) => {
            const metadata = task.task_metadata || {};
            const modelName = metadata.model_config?.model || metadata.model_variant || metadata.model_type || '';
            const family = getModelFamily(modelName);
            const familyShort = family.includes('YOLO') ? 'YOLO' : family.includes('DETR') ? 'RT-DETR' : family;
            const size = getModelSize(modelName);
            return (
              <TrainingCard
                key={task.id}
                task={task}
                modelFamily={familyShort}
                modelSize={size}
                onOpen={() => setSelectedTaskId(task.id)}
                onRename={() => {
                  setRenamingTask({ id: task.id, name: task.name });
                  setNewTaskName(task.name);
                }}
                onDuplicateSettings={() => {
                  setTrainModalCloneTaskId(task.id);
                  setShowTrainModelModal(true);
                }}
                onRerun={() => handleRerunTask(task)}
                onDelete={() => handleDeleteTask(task)}
                onTestInference={() => setTestInference({ id: task.id, name: task.name })}
                onDownload={() => setDownloadModel({ id: task.id, name: task.name })}
                onStop={() => handleStopTask(task)}
                onPause={() => handlePauseTask(task)}
                onResume={() => handleResumeTask(task)}
                onShowError={() => setSelectedTaskError({ name: task.name, error: task.error_message || 'Unknown error', id: task.id })}
              />
            );
          })}
        </div>
      ) : (
        <div className="text-center py-16">
          <Brain className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
          <h3 className="text-lg font-medium mb-2">No training tasks found</h3>
          <p className="text-muted-foreground mb-6">
            This project doesn't have any training tasks yet. Train your first model to get started.
          </p>
          <Button
            variant="outline"
            onClick={() => {
              setTrainModalCloneTaskId(null);
              setShowTrainModelModal(true);
            }}
          >
            <Brain className="w-4 h-4 mr-2" />
            Train Model
          </Button>
        </div>
      )}
      
      {/* Modals */}
      <TrainModelModal
        open={showTrainModelModal}
        onOpenChange={(open) => {
          setShowTrainModelModal(open);
          if (!open) {
            setTrainModalCloneTaskId(null);
            setTimeout(() => fetchTrainingTasks(), 1000);
          }
        }}
        datasets={datasets}
        datasetGroups={datasetGroups}
        resourcesLoading={modalResourcesLoading}
        projectId={id || ''}
        cloneFromTaskId={trainModalCloneTaskId}
      />

      <ImportModelModal
        open={showImportModelModal}
        onOpenChange={setShowImportModelModal}
        projectId={id || ''}
        onImported={() => fetchTrainingTasks()}
      />

      {/* Error Details Modal */}
      <Dialog open={!!selectedTaskError} onOpenChange={() => setSelectedTaskError(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertCircle className="w-5 h-5 text-red-500" />
              Training Failed - Task #{selectedTaskError?.id}
            </DialogTitle>
            <DialogDescription>
              {selectedTaskError?.name}
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4">
            <div className="bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-lg p-4">
              <h4 className="text-sm font-medium text-red-800 dark:text-red-200 mb-2">Error Details:</h4>
              <pre className="text-sm text-red-700 dark:text-red-300 whitespace-pre-wrap font-mono">
                {selectedTaskError?.error}
              </pre>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Rename Task Modal */}
      <Dialog open={!!renamingTask} onOpenChange={() => setRenamingTask(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="w-5 h-5" />
              Rename Training Task
            </DialogTitle>
            <DialogDescription>
              Task #{renamingTask?.id}
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-4">
            <div>
              <Label htmlFor="taskName">Task Name</Label>
              <Input
                id="taskName"
                value={newTaskName}
                onChange={(e) => setNewTaskName(e.target.value)}
                placeholder="Enter new task name"
                className="mt-2"
              />
            </div>
            <div className="flex gap-2 justify-end">
              <Button
                variant="outline"
                onClick={() => setRenamingTask(null)}
              >
                Cancel
              </Button>
              <Button
                onClick={async () => {
                  if (!renamingTask || !newTaskName.trim()) return;
                  
                  try {
                    const response = await fetch(buildApiUrl(`/tasks/${renamingTask.id}`), {
                      method: 'PATCH',
                      headers: {
                        'Content-Type': 'application/json',
                      },
                      body: JSON.stringify({
                        name: newTaskName.trim()
                      })
                    });
                    
                    if (response.ok) {
                      toast({
                        title: "Task Renamed",
                        description: `Task renamed to "${newTaskName.trim()}"`
                      });
                      setRenamingTask(null);
                      fetchTrainingTasks();
                    } else {
                      throw new Error('Failed to rename task');
                    }
                  } catch (error) {
                    toast({
                      title: "Error",
                      description: "Failed to rename task",
                      variant: "destructive"
                    });
                  }
                }}
                disabled={!newTaskName.trim() || newTaskName.trim() === renamingTask?.name}
              >
                Rename
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Training Details Modal */}
      {selectedTaskId && (
        <TrainingDetailsModal
          open={true}
          onOpenChange={(open) => {
            if (!open) {
              setSelectedTaskId(null);
              const nextParams = new URLSearchParams(searchParams);
              nextParams.delete('taskId');
              setSearchParams(nextParams, { replace: true });
            }
          }}
          taskId={selectedTaskId}
        />
      )}

      {/* Download Model Modal */}
      {downloadModel && (
        <DownloadModelModal
          open={true}
          onOpenChange={(open) => !open && setDownloadModel(null)}
          taskId={downloadModel.id}
          taskName={downloadModel.name}
        />
      )}

      {/* Test Inference Modal */}
      {testInference && (
        <TestTrainingInferenceModal
          open={true}
          onOpenChange={(open) => !open && setTestInference(null)}
          taskId={testInference.id}
          taskName={testInference.name}
        />
      )}

      {/* Delete training task confirm */}
      <ConfirmDeleteDialog
        open={!!pendingDeleteTask}
        onOpenChange={(o) => !o && setPendingDeleteTask(null)}
        entity="trained model"
        itemName={pendingDeleteTask?.name}
        consequences={["All model files and checkpoints for this task will be removed."]}
        confirmLabel="Delete model"
        onConfirm={() => pendingDeleteTask && performDeleteTask(pendingDeleteTask)}
      />

      {/* Stop training confirm (reuses the same dialog) */}
      <ConfirmDeleteDialog
        open={!!pendingStopTask}
        onOpenChange={(o) => !o && setPendingStopTask(null)}
        title="Stop training?"
        description={<>Stop training task <span className="font-semibold text-foreground">"{pendingStopTask?.name}"</span>? Progress made so far will be preserved as a checkpoint.</>}
        confirmLabel="Stop training"
        cancelLabel="Keep running"
        onConfirm={() => pendingStopTask && performStopTask(pendingStopTask)}
      />

      {/* Delete all failed training tasks confirm */}
      <ConfirmDeleteDialog
        open={showDeleteFailedConfirm}
        onOpenChange={setShowDeleteFailedConfirm}
        title="Delete all failed training tasks?"
        description={<>This will permanently delete <span className="font-semibold text-foreground">{failedTasksCount}</span> failed training task{failedTasksCount !== 1 ? 's' : ''} and their files.</>}
        confirmLabel={`Delete ${failedTasksCount} task${failedTasksCount !== 1 ? 's' : ''}`}
        isLoading={deletingFailedTasks}
        onConfirm={handleDeleteFailedTasks}
      />

      {/* Delete all training tasks confirm */}
      <ConfirmDeleteDialog
        open={showDeleteAllConfirm}
        onOpenChange={setShowDeleteAllConfirm}
        title="Delete all trained models?"
        description={
          <>
            This will permanently delete all{" "}
            <span className="font-semibold text-foreground">{trainingTasks.length}</span>{" "}
            training task{trainingTasks.length !== 1 ? "s" : ""} in this project, including
            checkpoints and model files.
            {runningTasksCount > 0 && (
              <>
                {" "}
                <span className="font-semibold text-foreground">{runningTasksCount}</span>{" "}
                running task{runningTasksCount !== 1 ? "s" : ""} will be cancelled first.
              </>
            )}
          </>
        }
        consequences={[
          "All trained model weights and training artifacts will be removed.",
          "This action cannot be undone.",
        ]}
        confirmLabel={`Delete all ${trainingTasks.length} model${trainingTasks.length !== 1 ? "s" : ""}`}
        isLoading={deletingAllTasks}
        onConfirm={handleDeleteAllTasks}
      />
    </div>
  );
}
