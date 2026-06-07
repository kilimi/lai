import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
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
import { attachmentFilenameFromContentDisposition } from "@/lib/evaluationTableDisplay";

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

export function DownloadModelModal({
  open,
  onOpenChange,
  taskId,
  taskName,
}: DownloadModelModalProps) {
  const { toast } = useToast();
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [selectedCheckpoint, setSelectedCheckpoint] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [loadingCheckpoints, setLoadingCheckpoints] = useState(true);

  useEffect(() => {
    if (open && taskId) {
      fetchCheckpoints();
    }
  }, [open, taskId]);

  const fetchCheckpoints = async () => {
    setLoadingCheckpoints(true);
    try {
      const response = await fetch(`${getApiBaseUrl()}/training/${taskId}/checkpoints`);
      if (response.ok) {
        const data = await response.json();
        if (data.success) {
          setCheckpoints(data.checkpoints || []);
          // Auto-select first checkpoint if available
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

  const handleDownload = async () => {
    if (!selectedCheckpoint) {
      toast({
        title: "No checkpoint selected",
        description: "Please select a checkpoint to download",
        variant: "destructive",
      });
      return;
    }

    setLoading(true);
    try {
      const response = await fetch(
        `${getApiBaseUrl()}/training/${taskId}/download?checkpoint=${encodeURIComponent(selectedCheckpoint)}`,
        { method: 'GET' }
      );

      if (!response.ok) {
        throw new Error('Download failed');
      }

      // Get filename from Content-Disposition header or use default
      const contentDisposition = response.headers.get('Content-Disposition');
      let filename = `${taskName}_${selectedCheckpoint}.zip`;
      const headerFilename = attachmentFilenameFromContentDisposition(contentDisposition);
      if (headerFilename) filename = headerFilename;

      // Create blob and download
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);

      toast({
        title: "Download started",
        description: `Downloading ${selectedCheckpoint}...`,
      });

      onOpenChange(false);
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to download model",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
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
                <Select value={selectedCheckpoint} onValueChange={setSelectedCheckpoint}>
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
                      <span className="text-muted-foreground">Size:</span>
                      <span className="font-medium">
                        {(checkpoints.find(c => c.name === selectedCheckpoint)!.size! / (1024 * 1024)).toFixed(2)} MB
                      </span>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          <Button
            onClick={handleDownload}
            disabled={!selectedCheckpoint || loading || checkpoints.length === 0}
          >
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Downloading...
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
