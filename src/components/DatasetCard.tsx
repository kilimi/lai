import * as React from "react";
import { Link, useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";
import { Dataset } from "@/types";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Database, FileImage, Layers, MoreHorizontal, Tag, Edit, ExternalLink, Copy, Pencil, CheckCircle2, CircleDashed, Loader2, ChevronDown, Plus, FolderOpen, Sparkles } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { EditDatasetDialog } from "@/components/EditDatasetDialog";
import { useApi } from "@/hooks/use-api";
import { resolveBackendMediaUrl } from "@/config/api";
import { useToast } from "@/hooks/use-toast";
import { detectFormat } from "@/utils/detectFormat";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ToastAction } from "@/components/ui/toast";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface DatasetCardProps extends React.HTMLAttributes<HTMLDivElement> {
  dataset: Dataset;
  className?: string;
  onDelete?: (dataset: Dataset) => Promise<void>;
  onDatasetUpdated?: (dataset: Dataset) => void;
  onDatasetMoved?: (datasetId: number, targetProjectId: number) => void;
}

export function DatasetCard({ dataset, className, onDelete, onDatasetUpdated, onDatasetMoved, ...props }: DatasetCardProps) {
  const thumbnailSrc = resolveBackendMediaUrl(dataset.thumbnailUrl);
  // CSS-only fade: track load state directly on the <img> element via onLoad
  // instead of creating a hidden Image() object in a useEffect.
  const [imageLoaded, setImageLoaded] = React.useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = React.useState(false);
  const [isMoveDialogOpen, setIsMoveDialogOpen] = React.useState(false);
  const [projects, setProjects] = React.useState<Array<{ id: number; name: string }>>([]);
  const [selectedTargetProject, setSelectedTargetProject] = React.useState<string>("");
  const [loadingProjects, setLoadingProjects] = React.useState(false);
  const [isMoving, setIsMoving] = React.useState(false);
  
  const { api } = useApi();
  const { toast } = useToast();
  const navigate = useNavigate();
  
  // Refs for cleanup
  const pollIntervalRef = React.useRef<NodeJS.Timeout | null>(null);
  const maxTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);
  const navTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);
  const isMountedRef = React.useRef(true);

  // Cleanup on unmount
  React.useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
      if (maxTimeoutRef.current) clearTimeout(maxTimeoutRef.current);
      if (navTimeoutRef.current) clearTimeout(navTimeoutRef.current);
    };
  }, []);

  const handleDatasetUpdated = (updatedDataset: Dataset) => {
    if (onDatasetUpdated) {
      onDatasetUpdated(updatedDataset);
    }
  };

  const handleDuplicate = async () => {
    if (!api) {
      toast({
        title: "Error",
        description: "API not available",
        variant: "destructive",
      });
      return;
    }

    try {
      const response = await api.duplicateDataset(dataset.id);
      
      if (!response.success || !response.data) {
        throw new Error(response.error || 'Failed to duplicate dataset');
      }

      const responseData = response.data;
      
      if (responseData.task_id) {
        toast({
          title: "✨ Duplication Started",
          description: `Dataset duplication is running in background. Check the tasks panel for progress.`,
          duration: 5000,
        });
        
        // Clear any existing polling intervals
        if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
        if (maxTimeoutRef.current) clearTimeout(maxTimeoutRef.current);
        
        // Poll task status to navigate when complete
        pollIntervalRef.current = setInterval(async () => {
          if (!isMountedRef.current) {
            if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
            return;
          }
          
          try {
            const taskResponse = await api.getTask(responseData.task_id);
            if (taskResponse.success && taskResponse.data) {
              const taskData = taskResponse.data as any;
              
              if (taskData.status === 'completed') {
                if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
                if (maxTimeoutRef.current) clearTimeout(maxTimeoutRef.current);
                
                if (!isMountedRef.current) return;
                
                toast({
                  title: "✅ Dataset Duplicated",
                  description: `Successfully created a copy of the dataset!`,
                  duration: 4000,
                });
                
                // Navigate to the project datasets page with cleanup
                if (dataset.project_id && isMountedRef.current) {
                  navTimeoutRef.current = setTimeout(() => {
                    if (isMountedRef.current) {
                      navigate(`/projects/${dataset.project_id}/datasets`);
                    }
                  }, 500);
                }
              } else if (taskData.status === 'failed') {
                if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
                if (maxTimeoutRef.current) clearTimeout(maxTimeoutRef.current);
                
                if (!isMountedRef.current) return;
                
                toast({
                  title: "❌ Duplication Failed",
                  description: taskData.error_message || "Dataset duplication failed",
                  variant: "destructive",
                });
              }
            }
          } catch (error) {
            console.error('Error polling task status:', error);
          }
        }, 2000);
        
        // Set maximum polling duration (5 minutes)
        maxTimeoutRef.current = setTimeout(() => {
          if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
          console.warn('Dataset duplication polling stopped after 5 minutes');
        }, 300000);
      } else {
        const duplicatedDataset = responseData;
        toast({
          title: "✅ Dataset Duplicated",
          description: `Dataset has been duplicated successfully.`,
        });
        
        // Navigate to the project datasets page
        if (dataset.project_id) {
          navigate(`/projects/${dataset.project_id}/datasets`);
        }
      }
    } catch (error) {
      console.error('Error duplicating dataset:', error);
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to duplicate dataset",
        variant: "destructive",
      });
    }
  };

  const openMoveDialog = async () => {
    if (!api) return;
    setIsMoveDialogOpen(true);
    setLoadingProjects(true);
    try {
      const response = await api.getProjects();
      if (!response.success || !response.data) {
        throw new Error(response.error || "Failed to load projects");
      }
      const available = response.data
        .map((p: any) => ({ id: Number(p.id), name: p.name as string }))
        .filter((p) => Number.isFinite(p.id) && p.id !== Number(dataset.project_id))
        .sort((a, b) => a.name.localeCompare(b.name));
      setProjects(available);
      setSelectedTargetProject(available[0] ? String(available[0].id) : "");
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to load projects",
        variant: "destructive",
      });
    } finally {
      setLoadingProjects(false);
    }
  };

  const handleMoveDataset = async () => {
    if (!api || !selectedTargetProject) return;
    const targetProjectId = Number(selectedTargetProject);
    if (!Number.isFinite(targetProjectId)) return;

    // Validate dataset.id before calling callback
    const datasetId = Number(dataset.id);
    if (!Number.isFinite(datasetId)) {
      toast({
        title: "Error",
        description: "Invalid dataset ID",
        variant: "destructive",
      });
      return;
    }

    setIsMoving(true);
    try {
      const response = await api.moveDataset(dataset.id, targetProjectId);
      if (!response.success) {
        throw new Error(response.error || "Failed to move dataset");
      }
      const targetProjectName =
        projects.find((p) => p.id === targetProjectId)?.name || `Project ${targetProjectId}`;
      onDatasetMoved?.(datasetId, targetProjectId);
      setIsMoveDialogOpen(false);
      toast({
        title: "Dataset moved",
        description: `"${dataset.name}" moved to "${targetProjectName}".`,
        action: (
          <ToastAction
            altText="Open target project datasets"
            onClick={() => navigate(`/projects/${targetProjectId}/datasets`)}
          >
            Open
          </ToastAction>
        ),
      });
    } catch (error) {
      toast({
        title: "Move failed",
        description: error instanceof Error ? error.message : "Failed to move dataset",
        variant: "destructive",
      });
    } finally {
      setIsMoving(false);
    }
  };
  
  // Derived metrics
  const imgCount = dataset.image_count || 0;
  const fileCount = dataset.annotation_file_count || 0;
  const annFiles = dataset.annotation_files || [];

  // Detect formats from filenames using utility function
  const formats = Array.from(new Set(annFiles.map((f) => detectFormat(f.file_name || f.name))));
  const isMultiFormat = formats.length > 1;

  // Status pill: only Empty / Unannotated. With ≥1 set we surface set info instead.
  const status: { label: string; cls: string; Icon: typeof CheckCircle2 } | null =
    imgCount === 0
      ? { label: "Empty", cls: "bg-muted text-muted-foreground border-border", Icon: CircleDashed }
      : fileCount === 0
        ? { label: "Unannotated", cls: "bg-amber-500/15 text-amber-500 border-amber-500/30", Icon: CircleDashed }
        : null;

  const datasetHref = dataset.project_id
    ? `/projects/${dataset.project_id}/datasets/${dataset.id}`
    : `/datasets/${dataset.id}`;
  const annotateHref = `${datasetHref}/annotate`;

  return (
    <Card
      className={cn(
        "group overflow-hidden hover-card flex flex-col h-full transition-all duration-300 hover:-translate-y-0.5 hover:border-primary/40 cursor-pointer",
        className,
      )}
      onClick={() => {
        // Dialog content is rendered in a portal but events still bubble through
        // the React tree; avoid card navigation while a dialog is open.
        if (isEditDialogOpen || isMoveDialogOpen) return;
        navigate(datasetHref);
      }}
    >
      <CardHeader className="p-0">
        <div className="relative h-40 w-full overflow-hidden bg-muted/30">
          {thumbnailSrc ? (
            <>
              {!imageLoaded && (
                <div className="absolute inset-0 bg-muted animate-pulse" />
              )}
              <img
                key={thumbnailSrc}
                src={thumbnailSrc}
                alt={dataset.name}
                loading="lazy"
                decoding="async"
                onLoad={() => setImageLoaded(true)}
                className={cn(
                  "h-full w-full object-cover transition-all duration-500",
                  !imageLoaded && "opacity-0",
                  imageLoaded && "opacity-100",
                )}
              />
            </>
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-muted/50">
              <Database className="h-16 w-16 text-muted-foreground/30" />
            </div>
          )}

          {/* Status pill, top-left (only shown for Empty / Unannotated) */}
          {status && (
            <div className="absolute top-2 left-2">
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium backdrop-blur",
                  status.cls,
                )}
              >
                <status.Icon className="h-3 w-3" />
                {status.label}
              </span>
            </div>
          )}

          {/* Multi-format badge, bottom-left */}
          {isMultiFormat && (
            <div className="absolute bottom-2 left-2">
              <span className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/15 text-primary px-2 py-0.5 text-[10px] font-medium backdrop-blur">
                <Sparkles className="h-3 w-3" />
                Multi-format
              </span>
            </div>
          )}

          {/* Actions menu, top-right */}
          <div className="absolute top-2 right-2" onClick={(e) => e.stopPropagation()}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="secondary"
                  size="icon"
                  aria-label="Dataset actions"
                  className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity backdrop-blur"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setIsEditDialogOpen(true)}>
                  <Edit className="h-4 w-4 mr-2" />
                  Edit Dataset
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleDuplicate}>
                  <Copy className="h-4 w-4 mr-2" />
                  Duplicate
                </DropdownMenuItem>
                <DropdownMenuItem onClick={openMoveDialog}>
                  <ExternalLink className="h-4 w-4 mr-2" />
                  Move
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-destructive"
                  onClick={() => onDelete && onDelete(dataset)}
                >
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-4 flex-1 flex flex-col">
        <div className="space-y-1 flex-1">
          <h3 className="font-medium line-clamp-1 hover:text-primary transition-colors">
            {dataset.name}
          </h3>
          <p className="text-sm text-muted-foreground line-clamp-2 min-h-[2.5rem]">
            {dataset.description || "No description provided"}
          </p>

          {/* Annotation sets summary (1:N) */}
          {fileCount > 0 && (
            <div className="pt-2 space-y-1.5">
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Layers className="h-3 w-3" />
                  {fileCount} annotation set{fileCount > 1 ? "s" : ""}
                </span>
                {formats.length > 0 && (
                  <span className="tabular-nums">{formats.join(" · ")}</span>
                )}
              </div>
              {annFiles.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {annFiles.slice(0, 3).map((f) => (
                    <span
                      key={f.id}
                      title={`${f.name || f.file_name} · ${f.annotation_count.toLocaleString()} annotations`}
                      className="inline-flex items-center gap-1 max-w-[140px] truncate rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] text-foreground/80"
                    >
                      <span className="truncate">{f.name || f.file_name}</span>
                      <span className="text-muted-foreground tabular-nums">{f.annotation_count}</span>
                    </span>
                  ))}
                  {annFiles.length > 3 && (
                    <span className="inline-flex items-center rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      +{annFiles.length - 3} more
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Tags */}
          {dataset.tags && dataset.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-2">
              {dataset.tags.slice(0, 4).map((tag) => (
                <Badge
                  key={tag}
                  variant="secondary"
                  className="flex items-center gap-1 text-xs"
                >
                  <Tag className="h-3 w-3" />
                  {tag}
                </Badge>
              ))}
            </div>
          )}
        </div>
      </CardContent>

      <CardFooter className="p-4 pt-0 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <FileImage className="h-3.5 w-3.5" />
            {imgCount.toLocaleString()}
          </span>
          <span className="flex items-center gap-1">
            <Layers className="h-3.5 w-3.5" />
            {fileCount}
          </span>
          <span title={new Date(dataset.updated_at || dataset.created_at).toLocaleString()}>
            · {formatRelative(dataset.updated_at || dataset.created_at)}
          </span>
        </div>
        {imgCount > 0 && (
          fileCount === 0 ? (
            <Button
              asChild
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-primary hover:text-primary"
              onClick={(e) => e.stopPropagation()}
            >
              <Link to={annotateHref}>
                <Pencil className="h-3.5 w-3.5 mr-1" />
                Annotate
              </Link>
            </Button>
          ) : (
            <div className="flex items-center" onClick={(e) => e.stopPropagation()}>
              <Button
                asChild
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-primary hover:text-primary rounded-r-none"
              >
                <Link to={annotateHref}>
                  <Pencil className="h-3.5 w-3.5 mr-1" />
                  Annotate
                </Link>
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 w-6 px-0 text-primary hover:text-primary rounded-l-none border-l border-border/50"
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem asChild>
                    <Link to={annotateHref}>
                      <Pencil className="h-4 w-4 mr-2" />
                      Continue annotating
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link to={annotateHref}>
                      <Plus className="h-4 w-4 mr-2" />
                      New annotation set
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link to={datasetHref}>
                      <FolderOpen className="h-4 w-4 mr-2" />
                      Browse {fileCount} set{fileCount > 1 ? "s" : ""}
                    </Link>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )
        )}
      </CardFooter>

      <EditDatasetDialog
        dataset={dataset}
        open={isEditDialogOpen}
        onOpenChange={setIsEditDialogOpen}
        onDatasetUpdated={handleDatasetUpdated}
      />

      <Dialog open={isMoveDialogOpen} onOpenChange={setIsMoveDialogOpen}>
        <DialogContent onClick={(e) => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>Move Dataset</DialogTitle>
            <DialogDescription>
              Select a target project for "{dataset.name}".
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Select value={selectedTargetProject} onValueChange={setSelectedTargetProject}>
              <SelectTrigger>
                <SelectValue placeholder={loadingProjects ? "Loading projects..." : "Select project"} />
              </SelectTrigger>
              <SelectContent>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={String(project.id)}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsMoveDialogOpen(false)} disabled={isMoving}>
              Cancel
            </Button>
            <Button onClick={handleMoveDataset} disabled={!selectedTargetProject || isMoving || loadingProjects}>
              {isMoving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              Move
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function formatRelative(dateStr: string): string {
  const d = new Date(dateStr).getTime();
  const diff = Date.now() - d;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

export function DatasetCardSkeleton() {
  return (
    <Card className="overflow-hidden">
      <div className="h-40 w-full">
        <Skeleton className="h-full w-full" />
      </div>
      <CardContent className="p-4">
        <div className="space-y-2">
          <Skeleton className="h-5 w-4/5" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      </CardContent>
      <CardFooter className="p-4 pt-0 flex justify-between">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-4 w-24" />
      </CardFooter>
    </Card>
  );
}
