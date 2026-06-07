import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { 
  MoreHorizontal, 
  FolderOpen, 
  FolderClosed, 
  Edit, 
  Trash2, 
  ChevronDown,
  ChevronRight,
  Database,
  Image as ImageIcon,
  Layers,
  ExternalLink
} from "lucide-react";
import { DatasetGroup } from "@/types";
import { cn } from "@/lib/utils";
import { resolveBackendMediaUrl } from "@/config/api";

interface DatasetGroupCardProps {
  group: DatasetGroup;
  expanded?: boolean;
  onToggleExpanded?: () => void;
  onEdit?: (group: DatasetGroup) => void;
  onDelete?: (group: DatasetGroup) => void;
  className?: string;
}

export function DatasetGroupCard({ 
  group, 
  expanded = false,
  onToggleExpanded,
  onEdit,
  onDelete,
  className,
  ...props 
}: DatasetGroupCardProps) {
  /** One preview per group keeps network use similar to ungrouped dataset cards (not 4× images). */
  const headerPreviewRaw = group.datasets.find(d => d.thumbnailUrl)?.thumbnailUrl ?? null;
  const headerPreviewUrl = resolveBackendMediaUrl(headerPreviewRaw) ?? null;
  const totalImages = group.datasets.reduce((sum, dataset) => sum + (dataset.image_count || 0), 0);
  const totalAnnotations = group.datasets.reduce((sum, dataset) => sum + (dataset.annotation_count || 0), 0);

  return (
    <Card className={cn("overflow-hidden hover-card", className)} {...props}>
      <CardHeader className="p-0">
        <div className="relative h-40 w-full overflow-hidden">
          {headerPreviewUrl ? (
            <img
              src={headerPreviewUrl}
              alt={group.name}
              loading="lazy"
              decoding="async"
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-muted/50">
              <FolderClosed className="h-16 w-16 text-muted-foreground/30" />
            </div>
          )}
          
          <div className="absolute inset-0 bg-gradient-to-t from-background/80 to-transparent" />
          
          {/* Group indicator */}
          <div className="absolute top-3 left-3">
            <Badge variant="secondary" className="flex items-center gap-1 bg-primary/20 text-primary border-primary/30">
              <Database className="h-3 w-3" />
              Group
            </Badge>
          </div>

          {/* Expand/Collapse button */}
          <div className="absolute top-3 right-3">
            <Button
              variant="secondary"
              size="icon"
              className="h-7 w-7"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onToggleExpanded?.();
              }}
            >
              {expanded ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
            </Button>
          </div>

          {/* Stats overlay */}
          <div className="absolute bottom-3 left-4 right-4 flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <div className="rounded-md bg-secondary px-1.5 py-0.5 text-xs font-medium text-secondary-foreground">
                {new Date(group.created_at).toLocaleDateString()}
              </div>
              <Badge variant="outline" className="text-xs">
                {group.dataset_count} datasets
              </Badge>
            </div>
            
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button 
                  variant="secondary" 
                  size="icon" 
                  className="h-7 w-7"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {onEdit && (
                  <DropdownMenuItem onClick={() => onEdit(group)}>
                    <Edit className="mr-2 h-4 w-4" />
                    Edit Group
                  </DropdownMenuItem>
                )}
                {onDelete && (
                  <DropdownMenuItem 
                    onClick={() => onDelete(group)}
                    className="text-destructive"
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Delete Group
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </CardHeader>
      
      <CardContent className="p-4">
        <div className="space-y-1">
          <h3 className="font-medium line-clamp-1 flex items-center gap-2">
            {expanded ? (
              <FolderOpen className="h-4 w-4 text-primary" />
            ) : (
              <FolderClosed className="h-4 w-4 text-primary" />
            )}
            {group.name}
          </h3>
          <p className="text-sm text-muted-foreground line-clamp-2">
            {group.description || "No description provided"}
          </p>
          
          {/* URL display */}
          {group.url && (
            <div className="flex items-center gap-1 text-xs">
              <ExternalLink className="h-3 w-3 text-muted-foreground" />
              <a 
                href={group.url} 
                target="_blank" 
                rel="noopener noreferrer"
                className="text-primary hover:underline truncate"
                onClick={(e) => e.stopPropagation()}
              >
                {group.url}
              </a>
            </div>
          )}
          
          {/* Dataset stats */}
          <div className="flex items-center gap-4 pt-2 text-xs text-muted-foreground">
            <div className="flex items-center gap-1">
              <ImageIcon className="h-3 w-3" />
              {totalImages} images
            </div>
            <div className="flex items-center gap-1">
              <Layers className="h-3 w-3" />
              {totalAnnotations} annotations
            </div>
          </div>
        </div>
      </CardContent>

      {/* Expanded dataset list */}
      {expanded && group.datasets.length > 0 && (
        <div className="border-t bg-muted/20">
          <div className="p-4 space-y-2">
            <h4 className="text-sm font-medium text-muted-foreground mb-2">
              Datasets in this group:
            </h4>
            {group.datasets.map((dataset) => {
              const rowThumb = resolveBackendMediaUrl(dataset.thumbnailUrl);
              return (
              <Link
                key={dataset.id}
                to={`/projects/${group.project_id}/datasets/${dataset.id}`}
                className="flex items-center gap-3 p-2 rounded-md hover:bg-muted/50 transition-colors"
              >
                {rowThumb ? (
                  <img
                    src={rowThumb}
                    alt={dataset.name}
                    loading="lazy"
                    decoding="async"
                    className="w-8 h-8 rounded object-cover"
                  />
                ) : (
                  <div className="w-8 h-8 rounded bg-muted flex items-center justify-center">
                    <Database className="h-4 w-4 text-muted-foreground" />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{dataset.name}</p>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{dataset.image_count || 0} images</span>
                    <span>•</span>
                    <span>{dataset.annotation_count || 0} annotations</span>
                  </div>
                </div>
              </Link>
              );
            })}
          </div>
        </div>
      )}
    </Card>
  );
}
