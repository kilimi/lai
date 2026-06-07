import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, Link, useOutletContext, useSearchParams, useNavigate } from 'react-router-dom';
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { useApi } from '@/hooks/use-api';
import { useToast } from '@/hooks/use-toast';
import { toast as sonnerToast } from 'sonner';
import { EvaluationDetailsModal } from '@/components/EvaluationDetailsModal';
import { EvaluateModelModal } from '@/components/EvaluateModelModal';
import { AlertCircle, Activity, Trash2, Pencil, ChevronDown, Download, Search, SlidersHorizontal, RotateCw, GitCompare, List, LayoutGrid, Grid3x3 } from "lucide-react";
import { EvaluationCard } from "@/components/EvaluationCard";
import { EvaluationComparePanel } from "@/components/EvaluationComparePanel";
import { EvaluationsMatrix } from "@/components/EvaluationsMatrix";
import { EvaluationsByModel } from "@/components/EvaluationsByModel";
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
import {
  formatEvaluationModelDisplay,
  formatMetricPct,
  getEvaluationRowMetrics,
  attachmentFilenameFromContentDisposition,
  evaluationCocoJsonDownloadName,
  evaluationCocoZipDownloadName,
} from "@/lib/evaluationTableDisplay";
import { buildApiUrl, getApiBaseUrl } from "@/config/api";

interface OutletContext {
  project: Project | null;
  loading: boolean;
}

export default function ProjectEvaluations() {
  const { id } = useParams<{ id: string }>();
  const { project } = useOutletContext<OutletContext>();
  const { isConnected } = useApi();
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  
  const [trainingTasks, setTrainingTasks] = useState<any[]>([]);
  const [evaluationTasks, setEvaluationTasks] = useState<any[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(true);
  const [showEvaluationModal, setShowEvaluationModal] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);
  const [expandedEvaluations, setExpandedEvaluations] = useState<Set<number>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [sortOrder, setSortOrder] = useState<"newest" | "oldest" | "name">("newest");
  const [renamingTask, setRenamingTask] = useState<{ id: number; name: string } | null>(null);
  const [newTaskName, setNewTaskName] = useState('');
  const [datasets, setDatasets] = useState<any[]>([]);
  const [datasetGroups, setDatasetGroups] = useState<DatasetGroup[]>([]);
  const [modalResourcesLoading, setModalResourcesLoading] = useState(false);
  const [deletingFailedTasks, setDeletingFailedTasks] = useState(false);
  const [statusFilter, setStatusFilter] = useState<"all" | "running" | "completed" | "failed">("all");
  const [compareMode, setCompareMode] = useState(false);
  const [selectedForCompare, setSelectedForCompare] = useState<Set<number>>(new Set());
  const [viewMode, setViewMode] = useState<"list" | "by-model" | "matrix">("list");
  const [pendingDeleteTask, setPendingDeleteTask] = useState<any | null>(null);
  const [showDeleteFailedConfirm, setShowDeleteFailedConfirm] = useState(false);
  const [showDeleteAllConfirm, setShowDeleteAllConfirm] = useState(false);
  const [deletingAllTasks, setDeletingAllTasks] = useState(false);

  const evaluationTasksRef = useRef<any[]>([]);
  evaluationTasksRef.current = evaluationTasks;

  /** Only evaluation tasks; metadata_mode=list keeps payloads small (no inline predictions). */
  const fetchEvaluationTasks = useCallback(async () => {
    if (!id) return;

    setLoadingTasks(true);
    try {
      const response = await fetch(
        buildApiUrl("/tasks/", {
          project_id: id,
          task_type: "model_evaluation",
          metadata_mode: "list",
          limit: "200",
        })
      );
      if (response.ok) {
        const data = await response.json();
        setEvaluationTasks(Array.isArray(data) ? data : []);
      } else {
        setEvaluationTasks([]);
      }
    } catch (error) {
      console.error('Error fetching evaluation tasks:', error);
      setEvaluationTasks([]);
    } finally {
      setLoadingTasks(false);
    }
  }, [id]);

  /** Loaded when "New Evaluation" opens — avoids blocking the evaluations table. */
  const loadModalResources = useCallback(async () => {
    if (!id) return;
    setModalResourcesLoading(true);
    try {
      const [dsRes, dgRes, trRes] = await Promise.all([
        fetch(buildApiUrl(`/projects/${id}/datasets/list`)),
        fetch(buildApiUrl(`/projects/${id}/dataset-groups/`)),
        fetch(
          buildApiUrl("/tasks/", {
            project_id: id,
            task_type: "yolo_training,training,mmyolo_training",
            status: "completed",
            metadata_mode: "list",
            limit: "150",
          })
        ),
      ]);
      if (dsRes.ok) {
        const result = await dsRes.json();
        if (result.success && result.data) setDatasets(result.data);
      }
      if (dgRes.ok) {
        const result = await dgRes.json();
        if (result.success) setDatasetGroups(result.data);
      }
      if (trRes.ok) {
        setTrainingTasks(await trRes.json());
      }
    } catch (error) {
      console.error('Error loading evaluation modal data:', error);
    } finally {
      setModalResourcesLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (!id) return;
    fetchEvaluationTasks();

    const interval = setInterval(() => {
      if (
        evaluationTasksRef.current.some(
          (t) => t.status === 'running' || t.status === 'pending'
        )
      ) {
        fetchEvaluationTasks();
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [id, fetchEvaluationTasks]);

  useEffect(() => {
    if (!showEvaluationModal || !id) return;
    loadModalResources();
  }, [showEvaluationModal, id, loadModalResources]);

  // Handle taskId from URL parameter - open evaluation details if present
  useEffect(() => {
    const taskIdParam = searchParams.get('taskId');
    if (taskIdParam && !selectedTaskId) {
      const taskId = parseInt(taskIdParam, 10);
      if (!isNaN(taskId)) {
        setSelectedTaskId(taskId);
        // Remove taskId from URL after opening modal
        const newParams = new URLSearchParams(searchParams);
        newParams.delete('taskId');
        setSearchParams(newParams, { replace: true });
      }
    }
  }, [searchParams, selectedTaskId, setSearchParams]);

  // Filter to show only parent tasks and single dataset tasks (not child tasks)
  const parentEvaluations = evaluationTasks.filter(t => !t.task_metadata?.parent_task_id);
  const formatDatasetCollectionLabel = (datasetName?: string, collectionName?: string) => {
    if (!datasetName) return '-';
    if (!collectionName) return datasetName;
    return `${datasetName} (${collectionName})`;
  };

  // Filter and sort
  const visibleEvaluations = (() => {
    let result = parentEvaluations;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter(t => t.name?.toLowerCase().includes(q));
    }
    if (statusFilter !== "all") {
      result = result.filter(t => {
        const m = t.task_metadata || {};
        if (m.is_multi_dataset) {
          const children = evaluationTasks.filter(c => (m.child_task_ids || []).includes(c.id));
          if (statusFilter === "completed") return children.length > 0 && children.every(c => c.status === "completed");
          if (statusFilter === "failed") return children.some(c => c.status === "failed");
          if (statusFilter === "running") return children.some(c => c.status === "running" || c.status === "pending");
        }
        return t.status === statusFilter;
      });
    }
    return [...result].sort((a, b) => {
      switch (sortOrder) {
        case "oldest":
          return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        case "name":
          return (a.name || "").localeCompare(b.name || "");
        case "newest":
        default:
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      }
    });
  })();

  const statusCounts = {
    all: parentEvaluations.length,
    running: parentEvaluations.filter(t => t.status === "running" || t.status === "pending").length,
    completed: parentEvaluations.filter(t => t.status === "completed").length,
    failed: parentEvaluations.filter(t => t.status === "failed").length,
  };

  const failedEvaluationsCount = evaluationTasks.filter(t => t.status === 'failed').length;
  const runningEvaluationsCount = evaluationTasks.filter(
    (t) => t.status === 'running' || t.status === 'pending'
  ).length;

  const selectedTasksForCompare = parentEvaluations.filter(t => selectedForCompare.has(t.id));

  const toggleCompareSelect = (taskId: number) => {
    setSelectedForCompare(prev => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  };

  // Action handlers (extracted from inline so cards can call them)
  const handleRename = (task: any) => {
    setRenamingTask({ id: task.id, name: task.name });
    setNewTaskName(task.name);
  };

  const performDelete = async (task: any) => {
    try {
      const response = await fetch(buildApiUrl(`/tasks/${task.id}`), { method: 'DELETE' });
      if (!response.ok) throw new Error('Failed to delete task');
      toast({ title: "Task Deleted", description: `Evaluation task "${task.name}" has been deleted.` });
      fetchEvaluationTasks();
    } catch {
      toast({ title: "Error", description: "Failed to delete evaluation task", variant: "destructive" });
    } finally {
      setPendingDeleteTask(null);
    }
  };

  const handleDelete = (task: any) => {
    setPendingDeleteTask(task);
  };

  const handleDeleteAllEvaluations = async () => {
    if (evaluationTasks.length === 0) return;

    setDeletingAllTasks(true);
    try {
      for (const task of evaluationTasks) {
        const response = await fetch(buildApiUrl(`/tasks/${task.id}`), { method: 'DELETE' });
        if (!response.ok) {
          throw new Error(`Failed to delete task ${task.id}`);
        }
      }
      toast({
        title: "All Evaluations Deleted",
        description: `${evaluationTasks.length} evaluation task(s) have been deleted.`,
      });
      setSelectedTaskId(null);
      setSelectedForCompare(new Set());
      fetchEvaluationTasks();
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

  const handleStop = async (task: any) => {
    try {
      const response = await fetch(buildApiUrl(`/tasks/${task.id}/cancel`), { method: 'PATCH' });
      if (response.ok) {
        toast({ title: "Evaluation Stopped", description: `Task "${task.name}" has been stopped.` });
        fetchEvaluationTasks();
      } else {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.detail || 'Failed to stop task');
      }
    } catch (error) {
      toast({ title: "Error", description: error instanceof Error ? error.message : "Failed to stop evaluation task", variant: "destructive" });
    }
  };

  const handleRerun = async (task: any) => {
    try {
      const response = await fetch(buildApiUrl(`/tasks/${task.id}/rerun`), { method: 'POST' });
      if (response.ok) {
        const data = await response.json();
        sonnerToast.success("Evaluation Rerun Started", {
          description: `New evaluation task "${data.task?.name || task.name}" has been created and started.`,
          duration: 6000,
        });
        fetchEvaluationTasks();
      } else {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.detail || 'Failed to rerun evaluation task');
      }
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to rerun evaluation task",
        variant: "destructive",
      });
    }
  };

  const handleDownloadCoco = async (task: any, multi = false) => {
    const m = task.task_metadata || {};
    const base = getApiBaseUrl();
    if (multi) {
      const url = `${base}/predictions/export-coco-all/${task.id}`;
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error('Failed to download');
        const blob = await r.blob();
        const u = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = u;
        const fallback = evaluationCocoZipDownloadName({
          taskId: task.id,
          evaluationName: task.name,
        });
        a.download =
          attachmentFilenameFromContentDisposition(r.headers.get('content-disposition')) ?? fallback;
        document.body.appendChild(a); a.click();
        window.URL.revokeObjectURL(u); document.body.removeChild(a);
        toast({ title: "Download Complete", description: "All COCO files downloaded" });
      } catch (e) {
        toast({ title: "Download Failed", description: e instanceof Error ? e.message : "Failed", variant: "destructive" });
      }
      return;
    }
    const predCount = m.results?.predictions_count || 0;
    if (predCount <= 0) {
      toast({ title: "No Predictions", description: "This evaluation has no predictions to export.", variant: "destructive" });
      return;
    }
    try {
      const r = await fetch(`${base}/predictions/export-coco/${task.id}`);
      if (!r.ok) throw new Error('Failed to download');
      const blob = await r.blob();
      const u = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = u;
      const fallback = evaluationCocoJsonDownloadName({
        taskId: task.id,
        evaluationName: task.name,
        datasetName: m.dataset_name,
      });
      a.download =
        attachmentFilenameFromContentDisposition(r.headers.get('content-disposition')) ?? fallback;
      document.body.appendChild(a); a.click();
      window.URL.revokeObjectURL(u); document.body.removeChild(a);
      toast({ title: "Download Complete", description: "COCO results downloaded" });
    } catch (e) {
      toast({ title: "Download Failed", description: e instanceof Error ? e.message : "Failed", variant: "destructive" });
    }
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-center gap-2">
        <Activity className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold">Model Evaluations</h1>
        <Badge variant="secondary" className="ml-2">
          {parentEvaluations.length} evaluations
        </Badge>
      </div>

      {/* Search and Filter Controls (mirrors Models page) */}
      <div className="flex flex-col sm:flex-row gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
          <Input
            placeholder="Search evaluations by name..."
            className="pl-9"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        <div className="flex items-center gap-2">
          <SlidersHorizontal className="text-muted-foreground h-4 w-4" />
          <Select value={sortOrder} onValueChange={(v) => setSortOrder(v as any)}>
            <SelectTrigger className="min-w-[180px]">
              <SelectValue placeholder="Sort by" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">Newest first</SelectItem>
              <SelectItem value="oldest">Oldest first</SelectItem>
              <SelectItem value="name">Name (A-Z)</SelectItem>
            </SelectContent>
          </Select>

          <Button
            variant="default"
            size="sm"
            className="whitespace-nowrap ml-2"
            onClick={() => setShowEvaluationModal(true)}
          >
            <Activity className="w-4 h-4 mr-2" />
            New Evaluation
          </Button>

          {evaluationTasks.length > 0 && (
            <Button
              variant="destructive"
              size="sm"
              className="whitespace-nowrap ml-2"
              disabled={deletingAllTasks || deletingFailedTasks}
              onClick={() => setShowDeleteAllConfirm(true)}
            >
              <Trash2 className="w-4 h-4 mr-2" />
              {deletingAllTasks ? 'Deleting...' : `Delete All (${evaluationTasks.length})`}
            </Button>
          )}

          {failedEvaluationsCount > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="whitespace-nowrap ml-2 text-destructive hover:text-destructive"
              disabled={deletingFailedTasks || deletingAllTasks}
              onClick={() => setShowDeleteFailedConfirm(true)}
            >
              <Trash2 className="w-4 h-4 mr-2" />
              {deletingFailedTasks ? 'Deleting...' : `Delete Failed (${failedEvaluationsCount})`}
            </Button>
          )}
        </div>
      </div>

      {/* Status filter chips + Compare toggle */}
      <div className="flex items-center justify-between flex-wrap gap-3">
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
        <div className="flex items-center gap-2">
          {/* View mode toggle */}
          <div className="inline-flex rounded-md border border-border bg-muted/30 p-0.5">
            {([
              { key: "by-model", label: "By model", Icon: LayoutGrid },
              { key: "matrix", label: "Matrix", Icon: Grid3x3 },
              { key: "list", label: "List", Icon: List },
            ] as const).map(({ key, label, Icon }) => (
              <button
                key={key}
                onClick={() => {
                  setViewMode(key);
                  if (key !== "list") {
                    setCompareMode(false);
                    setSelectedForCompare(new Set());
                  }
                }}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded transition-colors ${
                  viewMode === key
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {label}
              </button>
            ))}
          </div>
          {viewMode === "list" && (
            <Button
              variant={compareMode ? "default" : "outline"}
              size="sm"
              onClick={() => {
                setCompareMode(v => !v);
                if (compareMode) setSelectedForCompare(new Set());
              }}
            >
              <GitCompare className="w-4 h-4 mr-2" />
              {compareMode ? "Exit compare" : "Compare"}
            </Button>
          )}
        </div>
      </div>

      {/* Content */}
      {loadingTasks ? (
        <div className="text-center py-16">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto"></div>
          <p className="text-muted-foreground mt-4">Loading evaluation tasks...</p>
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
      ) : visibleEvaluations.length > 0 ? (
        <div className={selectedTasksForCompare.length > 0 ? "pb-48" : ""}>
          {viewMode === "matrix" && (
            <EvaluationsMatrix
              tasks={[
                ...visibleEvaluations.filter(t => !t.task_metadata?.is_multi_dataset),
                ...evaluationTasks.filter(t => t.task_metadata?.parent_task_id),
              ]}
              onCellOpen={(taskId) => setSelectedTaskId(taskId)}
              onCellEvaluate={() => setShowEvaluationModal(true)}
              onNewEvaluation={() => setShowEvaluationModal(true)}
            />
          )}
          {viewMode === "by-model" && (
            <EvaluationsByModel
              tasks={[
                ...visibleEvaluations.filter(t => !t.task_metadata?.is_multi_dataset),
                ...evaluationTasks.filter(t => t.task_metadata?.parent_task_id),
              ]}
              onOpenTask={(taskId) => setSelectedTaskId(taskId)}
              onNewEvaluation={() => setShowEvaluationModal(true)}
            />
          )}
          {viewMode === "list" && (
            <div className="space-y-3">
              {visibleEvaluations.map((task) => {
                const metadata = task.task_metadata || {};
                const isMultiDataset = !!metadata.is_multi_dataset;
                const childTaskIds = metadata.child_task_ids || [];
                const childTasks = isMultiDataset
                  ? evaluationTasks.filter(t => childTaskIds.includes(t.id))
                  : [];
                const isExpanded = expandedEvaluations.has(task.id);
                return (
                  <React.Fragment key={task.id}>
                    <EvaluationCard
                      task={task}
                      childTasks={childTasks}
                      isExpanded={isExpanded}
                      onToggleExpand={() => {
                        setExpandedEvaluations(prev => {
                          const next = new Set(prev);
                          if (next.has(task.id)) next.delete(task.id);
                          else next.add(task.id);
                          return next;
                        });
                      }}
                      onOpen={() => {
                        if (compareMode) {
                          toggleCompareSelect(task.id);
                        } else if (isMultiDataset) {
                          setExpandedEvaluations(prev => {
                            const next = new Set(prev);
                            if (next.has(task.id)) next.delete(task.id);
                            else next.add(task.id);
                            return next;
                          });
                        } else {
                          setSelectedTaskId(task.id);
                        }
                      }}
                      onRename={() => handleRename(task)}
                      onRerun={() => handleRerun(task)}
                      onDelete={() => handleDelete(task)}
                      onStop={() => handleStop(task)}
                      onDownloadCoco={
                        isMultiDataset
                          ? () => handleDownloadCoco(task, true)
                          : () => handleDownloadCoco(task, false)
                      }
                      compareMode={compareMode}
                      selected={selectedForCompare.has(task.id)}
                      onToggleSelect={() => toggleCompareSelect(task.id)}
                    />
                    {isMultiDataset && isExpanded && childTasks.map((childTask) => (
                      <EvaluationCard
                        key={childTask.id}
                        task={childTask}
                        variant="child"
                        onOpen={() => setSelectedTaskId(childTask.id)}
                        onDownloadCoco={() => handleDownloadCoco(childTask, false)}
                      />
                    ))}
                  </React.Fragment>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        <div className="text-center py-16">
          <Activity className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
          <h3 className="text-lg font-medium mb-2">No Evaluations Yet</h3>
          <p className="text-muted-foreground mb-6">
            Start evaluating your trained models to analyze their performance.
          </p>
          <Button onClick={() => setShowEvaluationModal(true)}>
            <Activity className="w-4 h-4 mr-2" />
            New Evaluation
          </Button>
        </div>
      )}
      
      {/* Compare panel */}
      {compareMode && selectedTasksForCompare.length > 0 && (
        <EvaluationComparePanel
          tasks={selectedTasksForCompare}
          onClose={() => { setCompareMode(false); setSelectedForCompare(new Set()); }}
          onClear={() => setSelectedForCompare(new Set())}
        />
      )}

      {/* Modals */}
      {/* Rename Task Modal */}
      <Dialog open={!!renamingTask} onOpenChange={() => setRenamingTask(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="w-5 h-5" />
              Rename Evaluation Task
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
                      fetchEvaluationTasks();
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

      {/* Evaluation Details Modal */}
      {selectedTaskId && (
        <EvaluationDetailsModal
          open={true}
          onOpenChange={(open) => !open && setSelectedTaskId(null)}
          taskId={selectedTaskId}
          onSaved={fetchEvaluationTasks}
        />
      )}

      {/* Evaluate Model Modal */}
      <EvaluateModelModal
        open={showEvaluationModal}
        onOpenChange={setShowEvaluationModal}
        trainingTasks={trainingTasks}
        resourcesLoading={modalResourcesLoading}
        projectId={id || ''}
        datasets={datasets}
        datasetGroups={datasetGroups}
        onEvaluate={async (params) => {
          try {
            const response = await fetch(buildApiUrl('/predictions/evaluate'), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                task_id: params.taskId,
                dataset_id: params.datasetId,
                collection_id: params.collectionId ? parseInt(params.collectionId, 10) : null,
                annotation_file_id: params.annotationFileId,
                image_size: params.imageSize,
                checkpoint: params.checkpoint,
                conf_threshold: params.confThreshold,
                iou_threshold: params.iouThreshold,
                nms_iou_threshold: params.nmsIouThreshold,
                evaluation_name: params.evaluationName || null,
                use_grid: params.useGrid,
                grid_size: params.gridSize,
                grid_overlap: params.gridOverlap,
                ignored_classes: params.ignoredClasses || []
              })
            });

            if (!response.ok) {
              let errorMessage = 'Evaluation failed';
              try {
                const errorData = await response.json();
                errorMessage = errorData.detail || errorData.message || errorMessage;
              } catch (e) {
                const errorText = await response.text();
                if (errorText) errorMessage = errorText;
              }
              throw new Error(errorMessage);
            }

            const data = await response.json();
            
            sonnerToast.success("Evaluation Started", {
              description: `Task "${data.task_name}" has been created.`,
              duration: 6000,
            });
            
            await fetchEvaluationTasks();
            setShowEvaluationModal(false);
          } catch (error) {
            console.error('Error evaluating model:', error);
            toast({
              title: "Evaluation Failed",
              description: error instanceof Error ? error.message : "An error occurred",
              variant: "destructive"
            });
            throw error;
          }
        }}
        onEvaluateMultiple={async (params) => {
          try {
            const requestBody = {
              task_id: params.taskId,
              datasets: params.datasets.map((d) => ({
                ...d,
                collectionId: d.collectionId ? parseInt(d.collectionId, 10) : null,
              })),
              checkpoint: params.checkpoint,
              image_size: params.imageSize,
              conf_threshold: params.confThreshold,
              iou_threshold: params.iouThreshold,
              nms_iou_threshold: params.nmsIouThreshold,
              evaluation_name: params.evaluationName || null,
              use_grid: params.useGrid,
              grid_size: params.gridSize,
              grid_overlap: params.gridOverlap,
              ignored_classes: params.ignoredClasses || []
            };
            
            const response = await fetch(buildApiUrl('/predictions/evaluate-multiple'), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
              let errorMessage = 'Multi-dataset evaluation failed';
              try {
                const errorData = await response.json();
                errorMessage = errorData.detail || errorData.message || errorMessage;
              } catch (e) {
                const errorText = await response.text();
                if (errorText) errorMessage = errorText;
              }
              throw new Error(errorMessage);
            }

            const data = await response.json();
            
            sonnerToast.success("Multi-Dataset Evaluation Started", {
              description: `Task "${data.task_name}" has been created with ${data.child_task_ids?.length || 0} dataset evaluations.`,
              duration: 6000,
            });
            
            await fetchEvaluationTasks();
            setShowEvaluationModal(false);
          } catch (error) {
            console.error('Error evaluating model on multiple datasets:', error);
            toast({
              title: "Evaluation Failed",
              description: error instanceof Error ? error.message : "An error occurred",
              variant: "destructive"
            });
            throw error;
          }
        }}
      />

      {/* Delete evaluation task confirm */}
      <ConfirmDeleteDialog
        open={!!pendingDeleteTask}
        onOpenChange={(o) => !o && setPendingDeleteTask(null)}
        entity="evaluation"
        itemName={pendingDeleteTask?.name}
        consequences={["All evaluation results and metrics for this task will be removed."]}
        confirmLabel="Delete evaluation"
        onConfirm={() => pendingDeleteTask && performDelete(pendingDeleteTask)}
      />

      {/* Delete all failed evaluations confirm */}
      <ConfirmDeleteDialog
        open={showDeleteFailedConfirm}
        onOpenChange={setShowDeleteFailedConfirm}
        title="Delete all failed evaluations?"
        description={
          <>
            This will permanently delete{" "}
            <span className="font-semibold text-foreground">{failedEvaluationsCount}</span> failed
            evaluation task{failedEvaluationsCount !== 1 ? "s" : ""}.
          </>
        }
        confirmLabel={`Delete ${failedEvaluationsCount} task${failedEvaluationsCount !== 1 ? 's' : ''}`}
        isLoading={deletingFailedTasks}
        onConfirm={async () => {
          const failed = evaluationTasks.filter(t => t.status === 'failed');
          if (failed.length === 0) return;
          setDeletingFailedTasks(true);
          try {
            for (const t of failed) {
              await fetch(buildApiUrl(`/tasks/${t.id}`), { method: 'DELETE' });
            }
            toast({ title: "Tasks Deleted", description: `${failed.length} failed evaluation task(s) have been deleted.` });
            fetchEvaluationTasks();
          } catch {
            toast({ title: "Error", description: "Failed to delete some tasks", variant: "destructive" });
          } finally {
            setDeletingFailedTasks(false);
            setShowDeleteFailedConfirm(false);
          }
        }}
      />

      {/* Delete all evaluations confirm */}
      <ConfirmDeleteDialog
        open={showDeleteAllConfirm}
        onOpenChange={setShowDeleteAllConfirm}
        title="Delete all evaluations?"
        description={
          <>
            This will permanently delete all{" "}
            <span className="font-semibold text-foreground">{evaluationTasks.length}</span>{" "}
            evaluation task{evaluationTasks.length !== 1 ? "s" : ""} in this project, including
            multi-dataset child tasks and their results.
            {runningEvaluationsCount > 0 && (
              <>
                {" "}
                <span className="font-semibold text-foreground">{runningEvaluationsCount}</span>{" "}
                running task{runningEvaluationsCount !== 1 ? "s" : ""} will be stopped first.
              </>
            )}
          </>
        }
        consequences={[
          "All evaluation metrics and result files will be removed.",
          "This action cannot be undone.",
        ]}
        confirmLabel={`Delete all ${evaluationTasks.length} evaluation${evaluationTasks.length !== 1 ? "s" : ""}`}
        isLoading={deletingAllTasks}
        onConfirm={handleDeleteAllEvaluations}
      />
    </div>
  );
}
