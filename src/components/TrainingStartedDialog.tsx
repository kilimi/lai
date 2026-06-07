import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { 
  Rocket, 
  CheckCircle2, 
  Cpu, 
  Database, 
  Timer, 
  Activity,
  Copy,
  Check,
  Download
} from "lucide-react";
import { cn } from "@/lib/utils";

interface TrainingStartedDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taskId: string;
  modelName: string;
  datasetsCount: number;
  epochs: number;
  /** Shown when base weights are not in the local cache and will be fetched when training runs */
  weightsDownloadNotice?: string;
}

export function TrainingStartedDialog({
  open,
  onOpenChange,
  taskId,
  modelName,
  datasetsCount,
  epochs,
  weightsDownloadNotice,
}: TrainingStartedDialogProps) {
  const [showSuccess, setShowSuccess] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (open) {
      setShowSuccess(false);
      const timer = setTimeout(() => setShowSuccess(true), 500);
      return () => clearTimeout(timer);
    }
  }, [open]);

  const handleCopyTaskId = () => {
    navigator.clipboard.writeText(taskId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="text-center pb-2">
          <div className="mx-auto mb-4 relative">
            {/* Animated background rings */}
            <div className={cn(
              "absolute inset-0 rounded-full bg-primary/20 animate-ping",
              showSuccess ? "opacity-0" : "opacity-100"
            )} style={{ animationDuration: "1.5s" }} />
            <div className={cn(
              "absolute inset-[-8px] rounded-full border-2 border-primary/30",
              showSuccess ? "scale-110 opacity-0" : "scale-100 opacity-100",
              "transition-all duration-500"
            )} />
            
            {/* Main icon container */}
            <div className={cn(
              "relative w-20 h-20 rounded-full flex items-center justify-center transition-all duration-500",
              showSuccess 
                ? "bg-gradient-to-br from-green-500/20 to-emerald-500/20" 
                : "bg-gradient-to-br from-primary/20 to-accent/20"
            )}>
              {showSuccess ? (
                <CheckCircle2 className="w-10 h-10 text-green-500 animate-scale-in" />
              ) : (
                <Rocket className="w-10 h-10 text-primary animate-pulse" />
              )}
            </div>
          </div>
          
          <DialogTitle className="text-xl font-bold text-center">
            {showSuccess ? "Training Started!" : "Launching Training..."}
          </DialogTitle>
          
          <p className="text-sm text-muted-foreground mt-2">
            {showSuccess 
              ? "Your model is now training on the GPU service" 
              : "Preparing your training job..."}
          </p>
        </DialogHeader>

        <div className={cn(
          "space-y-4 transition-all duration-500",
          showSuccess ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
        )}>
          {/* Task ID */}
          <div className="bg-muted/50 rounded-lg p-3 border border-border/50">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground uppercase tracking-wider">Task ID</span>
              <Button 
                variant="ghost" 
                size="sm" 
                className="h-6 px-2 text-xs"
                onClick={handleCopyTaskId}
              >
                {copied ? (
                  <Check className="w-3 h-3 mr-1 text-green-500" />
                ) : (
                  <Copy className="w-3 h-3 mr-1" />
                )}
                {copied ? "Copied!" : "Copy"}
              </Button>
            </div>
            <code className="text-sm font-mono text-foreground block mt-1 truncate">
              {taskId}
            </code>
          </div>

          {weightsDownloadNotice ? (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-left">
              <div className="flex items-start gap-2">
                <Download className="w-4 h-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
                <p className="text-xs text-amber-950/90 dark:text-amber-100/90 leading-relaxed">
                  {weightsDownloadNotice}
                </p>
              </div>
            </div>
          ) : null}

          {/* Training Details Grid */}
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-muted/30 rounded-lg p-3 text-center border border-border/30">
              <Cpu className="w-5 h-5 mx-auto text-primary mb-1" />
              <p className="text-xs text-muted-foreground">Model</p>
              <p className="text-sm font-medium truncate" title={modelName}>
                {modelName.replace('.pt', '')}
              </p>
            </div>
            
            <div className="bg-muted/30 rounded-lg p-3 text-center border border-border/30">
              <Database className="w-5 h-5 mx-auto text-accent mb-1" />
              <p className="text-xs text-muted-foreground">Datasets</p>
              <p className="text-sm font-medium">{datasetsCount}</p>
            </div>
            
            <div className="bg-muted/30 rounded-lg p-3 text-center border border-border/30">
              <Timer className="w-5 h-5 mx-auto text-secondary mb-1" />
              <p className="text-xs text-muted-foreground">Epochs</p>
              <p className="text-sm font-medium">{epochs}</p>
            </div>
          </div>

          {/* Tips */}
          <div className="bg-primary/5 rounded-lg p-3 border border-primary/20">
            <div className="flex items-start gap-2">
              <Activity className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" />
              <div className="text-xs text-muted-foreground space-y-1">
                <p className="font-medium text-foreground">Monitor Progress</p>
                <ul className="space-y-0.5 list-disc list-inside">
                  <li>Check the Tasks panel for live updates</li>
                  <li>Progress updates every epoch</li>
                  <li>Training runs on GPU service (port 9998)</li>
                </ul>
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-2 pt-2">
            <Button 
              variant="outline" 
              className="flex-1"
              onClick={() => onOpenChange(false)}
            >
              Close
            </Button>
            <Button 
              className="flex-1 gap-2"
              onClick={() => onOpenChange(false)}
            >
              <Activity className="w-4 h-4" />
              View Tasks
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
