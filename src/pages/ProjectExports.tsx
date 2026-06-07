import React, { useState, useEffect } from 'react';
import { useParams, useOutletContext } from 'react-router-dom';
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useApi } from '@/hooks/use-api';
import { useToast } from '@/hooks/use-toast';
import { getApiBaseUrl } from '@/config/api';
import { ExportModelModal } from '@/components/ExportModelModal';
import { ExportDetailsModal } from '@/components/ExportDetailsModal';
import { TestInferenceModal } from '@/components/TestInferenceModal';
import { ExportCard } from '@/components/ExportCard';
import { AlertCircle, Download, Trash2, Search, SlidersHorizontal } from "lucide-react";
import { Project } from '@/types';
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
  DialogFooter,
} from "@/components/ui/dialog";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";

interface OutletContext {
  project: Project | null;
  loading: boolean;
}

export default function ProjectExports() {
  const { id } = useParams<{ id: string }>();
  const { project } = useOutletContext<OutletContext>();
  const { isConnected } = useApi();
  const { toast } = useToast();
  
  const [trainingTasks, setTrainingTasks] = useState<any[]>([]);
  const [exportTasks, setExportTasks] = useState<any[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(true);
  const [showExportModal, setShowExportModal] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortOrder, setSortOrder] = useState<"newest" | "oldest" | "name">("newest");
  const [statusFilter, setStatusFilter] = useState<"all" | "running" | "completed" | "failed">("all");
  const [deletingFailedTasks, setDeletingFailedTasks] = useState(false);
  const [pendingDeleteTask, setPendingDeleteTask] = useState<any | null>(null);
  const [showDeleteFailedConfirm, setShowDeleteFailedConfirm] = useState(false);
  const [renamingTask, setRenamingTask] = useState<{ id: number; name: string } | null>(null);
  const [newTaskName, setNewTaskName] = useState('');
  const [testInference, setTestInference] = useState<{ id: number; onnxFilePath: string } | null>(null);

  const fetchTasks = async () => {
    if (!id) return;
    const base = getApiBaseUrl();
    setLoadingTasks(true);
    try {
      // Two targeted requests instead of one "all tasks" dump
      const [trainingRes, exportRes] = await Promise.all([
        fetch(
          `${base}/tasks/?project_id=${id}&task_type=yolo_training,training,mmyolo_training&status=completed&metadata_mode=list&limit=200`,
          { credentials: 'omit' },
        ),
        fetch(
          `${base}/tasks/?project_id=${id}&task_type=model_export&metadata_mode=list&limit=500`,
          { credentials: 'omit' },
        ),
      ]);
      if (trainingRes.ok) {
        const data = await trainingRes.json();
        setTrainingTasks(Array.isArray(data) ? data : []);
      }
      if (exportRes.ok) {
        const data = await exportRes.json();
        setExportTasks(Array.isArray(data) ? data : []);
      }
    } catch (error) {
      console.error('Error fetching tasks:', error);
    } finally {
      setLoadingTasks(false);
    }
  };

  useEffect(() => {
    fetchTasks();
    
    // Polling for running tasks
    const interval = setInterval(() => {
      if (exportTasks.some(t => t.status === 'running' || t.status === 'pending')) {
        fetchTasks();
      }
    }, 5000);
    
    return () => clearInterval(interval);
  }, [id]);

  const handleRenameTask = async (taskId: number) => {
    if (!newTaskName.trim()) return;
    
    try {
      const response = await fetch(`${getApiBaseUrl()}/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'omit',
        body: JSON.stringify({ name: newTaskName.trim() })
      });
      
      if (response.ok) {
        toast({
          title: "Success",
          description: "Task renamed successfully",
        });
        setRenamingTask(null);
        setNewTaskName('');
        fetchTasks();
      } else {
        throw new Error('Failed to rename task');
      }
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to rename task",
        variant: "destructive",
      });
    }
  };

  const handleDeleteTask = async (taskId: number) => {
    try {
      const response = await fetch(`${getApiBaseUrl()}/tasks/${taskId}`, {
        method: 'DELETE',
        credentials: 'omit',
      });
      
      if (response.ok) {
        toast({
          title: "Success",
          description: "Export task deleted successfully",
        });
        fetchTasks();
      } else {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.detail || 'Failed to delete task');
      }
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to delete export task",
        variant: "destructive",
      });
    }
  };

  // Filter and sort export tasks
  const filteredAndSortedTasks = exportTasks
    .filter(task => {
      if (statusFilter !== "all") {
        if (statusFilter === "running") {
          if (task.status !== "running" && task.status !== "pending") return false;
        } else if (task.status !== statusFilter) return false;
      }
      if (!searchQuery) return true;
      const query = searchQuery.toLowerCase();
      return (
        task.name?.toLowerCase().includes(query) ||
        task.task_metadata?.export_format?.toLowerCase().includes(query) ||
        task.task_metadata?.original_task_name?.toLowerCase().includes(query)
      );
    })
    .sort((a, b) => {
      switch (sortOrder) {
        case "newest":
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        case "oldest":
          return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        case "name":
          return (a.name || '').localeCompare(b.name || '');
        default:
          return 0;
      }
    });

  const statusCounts = {
    all: exportTasks.length,
    running: exportTasks.filter(t => t.status === "running" || t.status === "pending").length,
    completed: exportTasks.filter(t => t.status === "completed").length,
    failed: exportTasks.filter(t => t.status === "failed").length,
  };

  const handleDeleteFailedTasks = async () => {
    const failed = exportTasks.filter(t => t.status === 'failed');
    if (failed.length === 0) return;
    setDeletingFailedTasks(true);
    try {
      for (const t of failed) {
        await fetch(`${getApiBaseUrl()}/tasks/${t.id}`, { method: 'DELETE', credentials: 'omit' });
      }
      toast({ title: "Tasks Deleted", description: `${failed.length} failed conversion task(s) have been deleted.` });
      fetchTasks();
    } catch {
      toast({ title: "Error", description: "Failed to delete some tasks", variant: "destructive" });
    } finally {
      setDeletingFailedTasks(false);
      setShowDeleteFailedConfirm(false);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'completed':
        return <Badge variant="default" className="bg-green-600">Completed</Badge>;
      case 'running':
        return <Badge variant="default" className="bg-blue-600">Running</Badge>;
      case 'pending':
        return <Badge variant="secondary">Pending</Badge>;
      case 'failed':
        return <Badge variant="destructive">Failed</Badge>;
      default:
        return <Badge variant="secondary">{status}</Badge>;
    }
  };

  const formatFileSize = (bytes: number) => {
    if (!bytes) return '-';
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(2)} MB`;
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-center gap-2">
        <Download className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold">Model Conversions</h1>
        <Badge variant="secondary" className="ml-2">
          {exportTasks.length} conversions
        </Badge>
      </div>

      {/* Search and Filter Controls (mirrors Models / Evaluations) */}
      <div className="flex flex-col sm:flex-row gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
          <Input
            placeholder="Search conversions by name or format..."
            className="pl-9"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        <div className="flex items-center gap-2">
          <SlidersHorizontal className="text-muted-foreground h-4 w-4" />
          <Select value={sortOrder} onValueChange={(value) => setSortOrder(value as any)}>
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
            onClick={() => setShowExportModal(true)}
          >
            <Download className="w-4 h-4 mr-2" />
            Convert Model
          </Button>

          {statusCounts.failed > 0 && (
            <Button
              variant="destructive"
              size="sm"
              className="whitespace-nowrap ml-2"
              disabled={deletingFailedTasks}
              onClick={() => setShowDeleteFailedConfirm(true)}
            >
              <Trash2 className="w-4 h-4 mr-2" />
              {deletingFailedTasks ? 'Deleting...' : `Delete Failed (${statusCounts.failed})`}
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
      {loadingTasks ? (
        <div className="text-center py-16">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto"></div>
          <p className="text-muted-foreground mt-4">Loading conversion tasks...</p>
        </div>
      ) : isConnected === false ? (
        <div className="text-center py-16">
          <AlertCircle className="w-12 h-12 mx-auto mb-4 text-destructive" />
          <h3 className="text-lg font-medium mb-2">API Connection Error</h3>
          <p className="text-muted-foreground mb-6">
            Unable to connect to the backend server. Please check your API settings.
          </p>
        </div>
      ) : filteredAndSortedTasks.length > 0 ? (
        <div className="space-y-3">
          {filteredAndSortedTasks.map((task) => {
            const exportedFile = task.task_metadata?.exported_file;
            return (
              <ExportCard
                key={task.id}
                task={task}
                onOpen={() => setSelectedTaskId(task.id)}
                onRename={() => {
                  setRenamingTask({ id: task.id, name: task.name });
                  setNewTaskName(task.name);
                }}
                onDelete={() => setPendingDeleteTask(task)}
                onDownload={
                  exportedFile
                    ? () => window.open(`${getApiBaseUrl()}/export/download/${task.id}`, '_blank')
                    : undefined
                }
                onTestInference={
                  exportedFile
                    ? () => setTestInference({ id: task.id, onnxFilePath: exportedFile })
                    : undefined
                }
              />
            );
          })}
        </div>
      ) : (
        <div className="text-center py-16">
          <Download className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
          <h3 className="text-lg font-medium mb-2">No conversions found</h3>
          <p className="text-muted-foreground mb-6">
            {searchQuery
              ? "No conversions match your search criteria"
              : "You haven't converted any models yet. Convert your first model to get started."
            }
          </p>
          {!searchQuery && (
            <Button onClick={() => setShowExportModal(true)}>
              <Download className="w-4 h-4 mr-2" />
              Convert Model
            </Button>
          )}
        </div>
      )}

      {/* Export Modal */}
      <ExportModelModal
        open={showExportModal}
        onOpenChange={setShowExportModal}
        trainingTasks={trainingTasks}
        projectId={id || ''}
        onExportComplete={() => {
          fetchTasks();
        }}
      />

      {/* Export Details Modal */}
      {selectedTaskId && (
        <ExportDetailsModal
          open={!!selectedTaskId}
          onOpenChange={(open) => {
            if (!open) setSelectedTaskId(null);
          }}
          taskId={selectedTaskId}
        />
      )}

      {/* Test Inference Modal */}
      {testInference && (
        <TestInferenceModal
          open={!!testInference}
          onOpenChange={(open) => {
            if (!open) setTestInference(null);
          }}
          onnxFilePath={testInference.onnxFilePath}
          taskId={testInference.id}
        />
      )}

      {/* Rename Dialog */}
      <Dialog open={!!renamingTask} onOpenChange={(open) => {
        if (!open) {
          setRenamingTask(null);
          setNewTaskName('');
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename Export Task</DialogTitle>
            <DialogDescription>
              Enter a new name for this export task.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Task Name</label>
              <Input
                value={newTaskName}
                onChange={(e) => setNewTaskName(e.target.value)}
                placeholder="Enter task name"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && renamingTask) {
                    handleRenameTask(renamingTask.id);
                  }
                }}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setRenamingTask(null);
                setNewTaskName('');
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={() => renamingTask && handleRenameTask(renamingTask.id)}
              disabled={!newTaskName.trim()}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete export task confirm */}
      <ConfirmDeleteDialog
        open={!!pendingDeleteTask}
        onOpenChange={(o) => !o && setPendingDeleteTask(null)}
        entity="conversion"
        itemName={pendingDeleteTask?.name || (pendingDeleteTask ? `Conversion #${pendingDeleteTask.id}` : null)}
        consequences={
          pendingDeleteTask && (pendingDeleteTask.status === 'running' || pendingDeleteTask.status === 'pending')
            ? ["The task is still running — it will be cancelled.", "The converted model file will be removed."]
            : ["The converted model file will be removed."]
        }
        confirmLabel="Delete conversion"
        onConfirm={async () => {
          const t = pendingDeleteTask;
          setPendingDeleteTask(null);
          if (t) await handleDeleteTask(t.id);
        }}
      />

      {/* Delete all failed conversions confirm */}
      <ConfirmDeleteDialog
        open={showDeleteFailedConfirm}
        onOpenChange={setShowDeleteFailedConfirm}
        title="Delete all failed conversions?"
        description={<>This will permanently delete <span className="font-semibold text-foreground">{statusCounts.failed}</span> failed conversion task{statusCounts.failed !== 1 ? 's' : ''}.</>}
        confirmLabel={`Delete ${statusCounts.failed} task${statusCounts.failed !== 1 ? 's' : ''}`}
        isLoading={deletingFailedTasks}
        onConfirm={handleDeleteFailedTasks}
      />
    </div>
  );
}
