import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AlertCircle, CheckCircle2, XCircle, Clock, Info } from "lucide-react";
import { useEffect, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { getApiBaseUrl } from "@/config/api";

interface ExportDetailsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taskId: number;
}

interface TaskDetails {
  id: number;
  name: string;
  status: string;
  progress: number;
  created_at: string;
  started_at?: string;
  completed_at?: string;
  error_message?: string;
  task_metadata?: {
    training_task_id?: number;
    model_path?: string;
    checkpoint?: string;
    export_format?: string;
    original_task_name?: string;
    stage?: string;
    exported_file?: string;
    exported_file_url?: string;
    file_size?: number;
    error?: string;
    error_details?: {
      type?: string;
      message?: string;
    };
    celery_task_id?: string;
  };
}

export function ExportDetailsModal({ open, onOpenChange, taskId }: ExportDetailsModalProps) {
  const { api } = useApi();
  const [task, setTask] = useState<TaskDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editableName, setEditableName] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);

  useEffect(() => {
    if (open && taskId) {
      fetchTaskDetails();
    }
  }, [open, taskId, api]);

  useEffect(() => {
    if (!open || !taskId) return;
    
    // Poll for updates if task is running
    const interval = setInterval(() => {
      if (task?.status === 'running' || task?.status === 'pending') {
        fetchTaskDetails();
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [open, taskId, task?.status]);

  const fetchTaskDetails = async () => {
    if (!api) {
      setLoading(false);
      setError('API not available');
      return;
    }
    
    try {
      setLoading(true);
      setError(null);
      const response = await fetch(`${getApiBaseUrl()}/tasks/${taskId}`);
      
      if (!response.ok) {
        throw new Error(`Failed to fetch task details: ${response.status}`);
      }
      
      const data = await response.json();
      setTask(data);
      setEditableName(data.name || '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch task details');
      console.error('Error fetching export task details:', err);
    } finally {
      setLoading(false);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'completed':
        return (
          <Badge variant="default" className="bg-green-600">
            <CheckCircle2 className="h-3 w-3 mr-1" />
            Completed
          </Badge>
        );
      case 'running':
        return (
          <Badge variant="default" className="bg-blue-600">
            <Clock className="h-3 w-3 mr-1" />
            Running
          </Badge>
        );
      case 'failed':
        return (
          <Badge variant="destructive">
            <XCircle className="h-3 w-3 mr-1" />
            Failed
          </Badge>
        );
      case 'pending':
        return (
          <Badge variant="secondary">
            <Clock className="h-3 w-3 mr-1" />
            Pending
          </Badge>
        );
      default:
        return <Badge variant="secondary">{status}</Badge>;
    }
  };

  const formatFileSize = (bytes: number) => {
    if (!bytes) return '-';
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(2)} MB`;
  };

  const formatDate = (dateString?: string) => {
    if (!dateString) return '-';
    return new Date(dateString).toLocaleString('en-GB', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  };

  const handleSaveName = async () => {
    if (!editableName.trim() || !task || editableName.trim() === task.name) return;

    try {
      setSavingName(true);
      setNameError(null);
      const response = await fetch(`${getApiBaseUrl()}/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editableName.trim() }),
      });

      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.detail || 'Failed to rename task');
      }

      const result = await response.json();
      setTask((current) => current ? { ...current, name: result.task?.name || editableName.trim() } : current);
    } catch (err) {
      setNameError(err instanceof Error ? err.message : 'Failed to rename task');
    } finally {
      setSavingName(false);
    }
  };

  if (!open) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Info className="h-5 w-5 text-primary" />
            Conversion Task Details
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          </div>
        ) : error ? (
          <div className="text-center py-8">
            <AlertCircle className="h-12 w-12 mx-auto mb-4 text-destructive" />
            <p className="text-destructive">{error}</p>
          </div>
        ) : task ? (
          <div className="space-y-6">
            {/* Task Overview */}
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold">{task.name}</h3>
                {getStatusBadge(task.status)}
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Conversion Task Name</label>
                <div className="flex gap-2">
                  <Input
                    value={editableName}
                    onChange={(e) => setEditableName(e.target.value)}
                    placeholder="Enter task name"
                  />
                  <Button
                    onClick={handleSaveName}
                    disabled={savingName || !editableName.trim() || editableName.trim() === task.name}
                  >
                    {savingName ? 'Saving...' : 'Save'}
                  </Button>
                </div>
                {nameError && <p className="text-sm text-destructive">{nameError}</p>}
              </div>

              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-muted-foreground">Task ID:</span>
                  <div className="font-medium">#{task.id}</div>
                </div>
                <div>
                  <span className="text-muted-foreground">Progress:</span>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 bg-gray-800 rounded-full h-2">
                      <div
                        className={`h-2 rounded-full transition-all ${
                          task.status === 'failed' ? 'bg-red-500' : 
                          task.status === 'completed' ? 'bg-green-500' : 
                          'bg-blue-500'
                        }`}
                        style={{ width: `${task.progress}%` }}
                      />
                    </div>
                    <span className="text-xs text-muted-foreground">{task.progress}%</span>
                  </div>
                </div>
                <div>
                  <span className="text-muted-foreground">Created:</span>
                  <div className="font-medium">{formatDate(task.created_at)}</div>
                </div>
                {task.started_at && (
                  <div>
                    <span className="text-muted-foreground">Started:</span>
                    <div className="font-medium">{formatDate(task.started_at)}</div>
                  </div>
                )}
                {task.completed_at && (
                  <div>
                    <span className="text-muted-foreground">Completed:</span>
                    <div className="font-medium">{formatDate(task.completed_at)}</div>
                  </div>
                )}
              </div>
            </div>

            {/* Export Configuration */}
            {task.task_metadata && (
              <div className="space-y-4">
                <h4 className="font-semibold text-base">Conversion Configuration</h4>
                <div className="bg-muted/50 rounded-lg p-4 space-y-3">
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <span className="text-muted-foreground">Source Model:</span>
                      <div className="font-medium">{task.task_metadata.original_task_name || `Task ${task.task_metadata.training_task_id}`}</div>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Checkpoint:</span>
                      <div className="font-medium capitalize">{task.task_metadata.checkpoint || '-'}</div>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Target Format:</span>
                      <div className="font-medium uppercase">{task.task_metadata.export_format || 'ONNX'}</div>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Stage:</span>
                      <div className="font-medium capitalize">{task.task_metadata.stage || '-'}</div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Conversion Results */}
            {task.status === 'completed' && task.task_metadata?.exported_file && (
              <div className="space-y-4">
                <h4 className="font-semibold text-base">Conversion Results</h4>
                <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-4 space-y-3">
                  <div className="flex items-center gap-2 text-green-400">
                    <CheckCircle2 className="h-5 w-5" />
                    <span className="font-medium">Conversion completed successfully</span>
                  </div>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <span className="text-muted-foreground">File Size:</span>
                      <div className="font-medium">{formatFileSize(task.task_metadata.file_size)}</div>
                    </div>
                    <div>
                      <span className="text-muted-foreground">File Path:</span>
                      <div className="font-medium text-xs break-all">{task.task_metadata.exported_file}</div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Error Details */}
            {task.status === 'failed' && (
              <div className="space-y-4">
                <h4 className="font-semibold text-base">Error Details</h4>
                <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 space-y-3">
                  <div className="flex items-center gap-2 text-red-400">
                    <XCircle className="h-5 w-5" />
                    <span className="font-medium">Conversion failed</span>
                  </div>
                  {task.error_message && (
                    <div className="space-y-2">
                      <div>
                        <span className="text-sm font-medium text-muted-foreground">Error Message:</span>
                        <div className="mt-1 p-3 bg-background rounded border border-red-500/20">
                          <code className="text-sm text-red-400 break-all">{task.error_message}</code>
                        </div>
                      </div>
                    </div>
                  )}
                  {task.task_metadata?.error && (
                    <div className="space-y-2">
                      <div>
                        <span className="text-sm font-medium text-muted-foreground">Additional Error Info:</span>
                        <div className="mt-1 p-3 bg-background rounded border border-red-500/20">
                          <code className="text-sm text-red-400 break-all">{task.task_metadata.error}</code>
                        </div>
                      </div>
                    </div>
                  )}
                  {task.task_metadata?.error_details && (
                    <div className="space-y-2">
                      <div>
                        <span className="text-sm font-medium text-muted-foreground">Error Type:</span>
                        <div className="mt-1 text-sm">{task.task_metadata.error_details.type || 'Unknown'}</div>
                      </div>
                      {task.task_metadata.error_details.message && (
                        <div>
                          <span className="text-sm font-medium text-muted-foreground">Details:</span>
                          <div className="mt-1 p-3 bg-background rounded border border-red-500/20">
                            <code className="text-sm text-red-400 break-all">{task.task_metadata.error_details.message}</code>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Task Metadata (Debug) */}
            {process.env.NODE_ENV === 'development' && task.task_metadata && (
              <div className="space-y-4">
                <h4 className="font-semibold text-base">Debug Information</h4>
                <div className="bg-muted/50 rounded-lg p-4">
                  <pre className="text-xs overflow-auto">
                    {JSON.stringify(task.task_metadata, null, 2)}
                  </pre>
                </div>
              </div>
            )}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
