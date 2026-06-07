import React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Download,
  MoreHorizontal,
  Pencil,
  TestTube,
  Trash2,
} from "lucide-react";

const STATUS_BORDER: Record<string, string> = {
  completed: "border-l-green-500",
  running: "border-l-blue-500",
  pending: "border-l-gray-500",
  failed: "border-l-red-500",
};

const STATUS_PILL: Record<string, string> = {
  completed: "bg-green-500/15 text-green-400 border border-green-500/30",
  running: "bg-blue-500/15 text-blue-400 border border-blue-500/30",
  pending: "bg-gray-500/15 text-muted-foreground border border-border",
  failed: "bg-red-500/15 text-red-400 border border-red-500/30",
};

const STATUS_LABEL: Record<string, string> = {
  completed: "Completed",
  running: "Running",
  pending: "Pending",
  failed: "Failed",
};

function timeAgo(iso?: string): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = (Date.now() - then) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function formatFileSize(bytes?: number): string {
  if (!bytes) return "—";
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

interface ExportCardProps {
  task: any;
  onOpen?: () => void;
  onRename?: () => void;
  onDelete?: () => void;
  onDownload?: () => void;
  onTestInference?: () => void;
}

export function ExportCard({
  task,
  onOpen,
  onRename,
  onDelete,
  onDownload,
  onTestInference,
}: ExportCardProps) {
  const metadata = task.task_metadata || {};
  const status = task.status as string;
  const isRunning = status === "running";
  const isPending = status === "pending";
  const isCompleted = status === "completed";
  const showProgress = isRunning || isPending;
  const exportedFile = metadata.exported_file;
  const fileSize = metadata.file_size;
  const format = (metadata.export_format || "ONNX").toUpperCase();
  const sourceModel =
    metadata.original_task_name || (metadata.training_task_id ? `Task ${metadata.training_task_id}` : "—");

  return (
    <div
      onClick={onOpen}
      className={`group relative rounded-lg border border-border bg-card text-card-foreground border-l-4 ${
        STATUS_BORDER[status] ?? "border-l-gray-500"
      } cursor-pointer hover:border-primary/40 transition-colors`}
    >
      <div className="p-5">
        <div className="flex items-start gap-4">
          {/* Left: identity */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-base font-semibold truncate" title={task.name}>
                {task.name || `Conversion #${task.id}`}
              </h3>
              <span
                className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                  STATUS_PILL[status] ?? STATUS_PILL.pending
                }`}
              >
                {STATUS_LABEL[status] ?? status}
              </span>
              <Badge variant="outline" className="text-xs">
                {format}
              </Badge>
            </div>
            <div className="mt-1 text-sm text-muted-foreground flex items-center gap-3 flex-wrap">
              <span className="font-medium text-foreground/80 truncate" title={sourceModel}>
                {sourceModel}
              </span>
              <span>·</span>
              <span>#{task.id}</span>
              <span>·</span>
              <span title={task.created_at}>{timeAgo(task.created_at)}</span>
              {metadata.checkpoint && (
                <>
                  <span>·</span>
                  <span className="capitalize">{metadata.checkpoint}</span>
                </>
              )}
            </div>

            {showProgress && (
              <div className="mt-3 flex items-center gap-3">
                <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full bg-blue-500 transition-all"
                    style={{ width: `${task.progress || 0}%` }}
                  />
                </div>
                <span className="text-xs text-muted-foreground tabular-nums w-10 text-right">
                  {task.progress || 0}%
                </span>
              </div>
            )}
          </div>

          {/* Middle: file size */}
          <div className="hidden md:flex flex-col items-end justify-center px-2 min-w-[110px]">
            <span className="text-xs text-muted-foreground uppercase tracking-wide">File size</span>
            <span className="text-sm font-medium tabular-nums">{formatFileSize(fileSize)}</span>
          </div>

          {/* Right: actions */}
          <div
            className="flex items-center gap-2 shrink-0"
            onClick={(e) => e.stopPropagation()}
          >
            {isCompleted && exportedFile && onTestInference && (
              <Button variant="outline" size="sm" onClick={onTestInference} className="h-8" title="Test inference">
                <TestTube className="w-3.5 h-3.5 mr-1.5" />
                Test
              </Button>
            )}
            {isCompleted && exportedFile && onDownload && (
              <Button variant="outline" size="sm" onClick={onDownload} className="h-8" title="Download converted model">
                <Download className="w-3.5 h-3.5 mr-1.5" />
                Download
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8">
                  <MoreHorizontal className="w-4 h-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                {onRename && (
                  <DropdownMenuItem onClick={onRename}>
                    <Pencil className="w-4 h-4 mr-2" />
                    Rename
                  </DropdownMenuItem>
                )}
                {onDelete && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={onDelete}
                      className="text-destructive focus:text-destructive"
                    >
                      <Trash2 className="w-4 h-4 mr-2" />
                      Delete
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>
    </div>
  );
}
