import { useState, useEffect, useRef, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Download, Loader2, AlertCircle } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from '@/hooks/use-toast';
import { getApiBaseUrl } from "@/config/api";
import {
  downloadFileWithProgress,
  type DownloadProgressUpdate,
} from "@/utils/downloadFile";
import { formatFileSize } from "@/utils/utils";

interface DownloadModelModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taskId: number;
  taskName: string;
}

interface Checkpoint {
  name: string;
  path: string;
  epoch?: number;
  size?: number;
}

const INITIAL_PROGRESS: DownloadProgressUpdate = {
  phase: 'preparing',
  loaded: 0,
  total: null,
  percent: null,
};

function progressLabel(update: DownloadProgressUpdate, expectedBytes?: number): string {
  const total = update.total ?? (expectedBytes && expectedBytes > 0 ? expectedBytes : null);

  if (update.phase === 'preparing') {
    return 'Preparing download on server (packaging checkpoint)…';
  }
  if (update.phase === 'saving') {
    return 'Saving file to your computer…';
  }
  if (update.percent != null && total) {
    return `Downloading… ${formatFileSize(update.loaded)} of ${formatFileSize(total)} (${update.percent}%)`;
  }
  if (total) {
    const pct = Math.min(100, Math.round((update.loaded / total) * 100));
    return `Downloading… ${formatFileSize(update.loaded)} of ${formatFileSize(total)} (${pct}%)`;
  }
  return `Downloading… ${formatFileSize(update.loaded)} received`;
}

function progressValue(update: DownloadProgressUpdate, expectedBytes?: number): number | null {
  if (update.phase === 'preparing') return null;
  if (update.percent != null) return update.percent;
  const total = update.total ?? (expectedBytes && expectedBytes > 0 ? expectedBytes : null);
  if (total && total > 0) {
    return Math.min(100, Math.round((update.loaded / total) * 100));
  }
  return null;
}

export function DownloadModelModal({
  open,
  onOpenChange,
  taskId,
  taskName,
}: DownloadModelModalProps) {
  const { toast } = useToast();
  const abortRef = useRef<AbortController | null>(null);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [selectedCheckpoint, setSelectedCheckpoint] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [loadingCheckpoints, setLoadingCheckpoints] = useState(true);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgressUpdate>(INITIAL_PROGRESS);

  const resetDownloadState = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
    setDownloadProgress(INITIAL_PROGRESS);
  }, []);

  useEffect(() => {
    if (open && taskId) {
      fetchCheckpoints();
    } else if (!open) {
      resetDownloadState();
    }
  }, [open, taskId, resetDownloadState]);

  const fetchCheckpoints = async () => {
    setLoadingCheckpoints(true);
    try {
      const response = await fetch(`${getApiBaseUrl()}/training/${taskId}/checkpoints`);
      if (response.ok) {
        const data = await response.json();
        if (data.success) {
          setCheckpoints(data.checkpoints || []);
          if (data.checkpoints && data.checkpoints.length > 0) {
            setSelectedCheckpoint(data.checkpoints[0].name);
          }
        }
      }
    } catch (error) {
      console.error('Error fetching checkpoints:', error);
      toast({
        title: "Error",
        description: "Failed to load available checkpoints",
        variant: "destructive",
      });
    } finally {
      setLoadingCheckpoints(false);
    }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && loading) {
      resetDownloadState();
    }
    onOpenChange(nextOpen);
  };

  const handleDownload = async () => {
    if (!selectedCheckpoint) {
      toast({
        title: "No checkpoint selected",
        description: "Please select a checkpoint to download",
        variant: "destructive",
      });
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setDownloadProgress(INITIAL_PROGRESS);

    const selected = checkpoints.find((c) => c.name === selectedCheckpoint);
    const expectedBytes = selected?.size;

    try {
      await downloadFileWithProgress(
        `${getApiBaseUrl()}/training/${taskId}/download?checkpoint=${encodeURIComponent(selectedCheckpoint)}`,
        {
          filenameFallback: `${taskName}_${selectedCheckpoint}.zip`,
          signal: controller.signal,
          onProgress: setDownloadProgress,
        },
      );

      toast({
        title: "Download complete",
        description: `${selectedCheckpoint} saved to your downloads folder.`,
      });

      onOpenChange(false);
    } catch (error) {
      if (controller.signal.aborted) {
        toast({
          title: "Download cancelled",
          description: "The download was stopped.",
        });
        return;
      }
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to download model",
        variant: "destructive",
      });
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
      setLoading(false);
      setDownloadProgress(INITIAL_PROGRESS);
    }
  };

  const barValue = progressValue(downloadProgress, checkpoints.find((c) => c.name === selectedCheckpoint)?.size);
  const showIndeterminate = loading && barValue === null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Download className="h-5 w-5 text-primary" />
            Download Model
          </DialogTitle>
          <DialogDescription>
            Select a checkpoint to download from {taskName}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {loadingCheckpoints ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
              <span className="ml-2 text-sm text-muted-foreground">Loading checkpoints...</span>
            </div>
          ) : checkpoints.length === 0 ? (
            <div className="text-center py-8">
              <AlertCircle className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">No checkpoints available</p>
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="checkpoint-select">Checkpoint</Label>
                <Select
                  value={selectedCheckpoint}
                  onValueChange={setSelectedCheckpoint}
                  disabled={loading}
                >
                  <SelectTrigger id="checkpoint-select">
                    <SelectValue placeholder="Select a checkpoint" />
                  </SelectTrigger>
                  <SelectContent>
                    {checkpoints.map((checkpoint) => (
                      <SelectItem key={checkpoint.name} value={checkpoint.name}>
                        <div className="flex items-center justify-between w-full">
                          <span>{checkpoint.name}</span>
                          {checkpoint.epoch !== undefined && (
                            <span className="text-xs text-muted-foreground ml-2">
                              Epoch {checkpoint.epoch}
                            </span>
                          )}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {selectedCheckpoint && (
                <div className="bg-muted/50 rounded-lg p-3 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Selected:</span>
                    <span className="font-medium">{selectedCheckpoint}</span>
                  </div>
                  {checkpoints.find(c => c.name === selectedCheckpoint)?.size && (
                    <div className="flex justify-between mt-1">
                      <span className="text-muted-foreground">Approx. size:</span>
                      <span className="font-medium">
                        {formatFileSize(checkpoints.find(c => c.name === selectedCheckpoint)!.size!)}
                        <span className="text-muted-foreground font-normal"> (+ metadata in zip)</span>
                      </span>
                    </div>
                  )}
                </div>
              )}

              {loading && (
                <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
                  <p className="text-sm text-muted-foreground">
                    {progressLabel(
                      downloadProgress,
                      checkpoints.find((c) => c.name === selectedCheckpoint)?.size,
                    )}
                  </p>
                  {showIndeterminate ? (
                    <div className="relative h-4 w-full overflow-hidden rounded-full bg-secondary">
                      <div className="absolute inset-y-0 left-0 w-1/3 animate-pulse rounded-full bg-primary" />
                    </div>
                  ) : (
                    <Progress value={barValue ?? 0} className="h-4" />
                  )}
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={false}>
            {loading ? 'Cancel' : 'Close'}
          </Button>
          <Button
            onClick={handleDownload}
            disabled={!selectedCheckpoint || loading || checkpoints.length === 0}
          >
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Downloading…
              </>
            ) : (
              <>
                <Download className="h-4 w-4 mr-2" />
                Download
              </>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
