import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, Pencil, Trash2, Copy, MoreHorizontal, Bot } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LayoutControls, LayoutType } from "@/components/LayoutControls";
import { Dataset, ImageCollection } from "@/types";
import { DatasetInfoBar } from "@/components/DatasetInfoBar";
import { AutoAnnotateModal } from "@/components/AutoAnnotateModal";
import { HelpHint } from "@/components/ui/help-hint";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { DatasetUiMode } from "@/hooks/useDatasetSettings";

interface DatasetHeaderProps {
  isLoading: boolean;
  name: string | undefined;
  currentLayout?: LayoutType;
  onLayoutChange?: (layout: LayoutType) => void;
  dataset?: Dataset;
  onEditDataset?: () => void;
  onDeleteDataset?: () => void;
  onDuplicateDataset?: () => void;
  projectId?: string | null;
  imageCount?: number;
  /** When set (tabbed/multi-collection datasets), Auto-Annotate can target one collection */
  imageCollections?: ImageCollection[];
  /** When true, dataset uses collections UI (Mode apply) */
  useTabbedImages?: boolean;
  datasetUiMode?: DatasetUiMode;
  onDatasetUiModeChange?: (mode: DatasetUiMode) => void;
}

export function DatasetHeader({
  isLoading,
  name,
  currentLayout,
  onLayoutChange,
  dataset,
  onEditDataset,
  onDeleteDataset,
  onDuplicateDataset,
  projectId,
  imageCount = 0,
  imageCollections = [],
  useTabbedImages = false,
  datasetUiMode = "default",
  onDatasetUiModeChange,
}: DatasetHeaderProps) {
  const [isAutoAnnotateOpen, setIsAutoAnnotateOpen] = useState(false);
  const navigate = useNavigate();

  return (
    <div className="space-y-3">
      {/* Top row: back + title + actions */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button 
            variant="ghost" 
            size="icon" 
            asChild
            className="h-9 w-9"
          >
            <Link to={projectId ? `/projects/${projectId}/datasets` : "/datasets"}>
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <h1 className="text-2xl font-bold">
            {isLoading ? 'Loading...' : name}
          </h1>
          {!isLoading && (
            <HelpHint ariaLabel="What is the Dataset View?" popover>
              <div className="space-y-2 text-sm">
                <p className="font-semibold text-foreground">Dataset View</p>
                <p>
                  Browse images, group them into collections, run
                  Auto-Annotate, and launch annotation sessions. Use the
                  Actions menu to edit, duplicate or delete the dataset.
                </p>
                <Link
                  to="/help/dataset-view"
                  className="inline-flex items-center gap-1 text-primary hover:underline font-medium"
                >
                  Read the full guide →
                </Link>
              </div>
            </HelpHint>
          )}
        </div>
        
        <div className="flex items-center gap-2">
          {/* Auto-Annotate button */}
          {dataset && !isLoading && (
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-1.5"
              onClick={() => setIsAutoAnnotateOpen(true)}
            >
              <Bot className="h-4 w-4 text-primary" />
              Auto-Annotate
            </Button>
          )}

          {/* Dataset actions dropdown */}
          {dataset && (onEditDataset || onDuplicateDataset || onDeleteDataset) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-9">
                  <MoreHorizontal className="h-4 w-4 mr-1" />
                  Actions
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {onEditDataset && (
                  <DropdownMenuItem onClick={onEditDataset}>
                    <Pencil className="h-4 w-4 mr-2" />
                    Edit Dataset
                  </DropdownMenuItem>
                )}
                {onDuplicateDataset && (
                  <DropdownMenuItem onClick={onDuplicateDataset}>
                    <Copy className="h-4 w-4 mr-2" />
                    Duplicate Dataset
                  </DropdownMenuItem>
                )}
                {onDeleteDataset && (
                  <DropdownMenuItem onClick={onDeleteDataset} className="text-destructive focus:text-destructive">
                    <Trash2 className="h-4 w-4 mr-2" />
                    Delete Dataset
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}


          {currentLayout && onLayoutChange && (
            <div className="flex-shrink-0">
              <LayoutControls 
                currentLayout={currentLayout}
                onLayoutChange={onLayoutChange}
                compact={true}
              />
            </div>
          )}
        </div>
      </div>

      {/* Info bar row */}
      {dataset && !isLoading && (
        <DatasetInfoBar
          dataset={dataset}
          imageCount={imageCount}
        />
      )}

      {/* Auto-Annotate Modal */}
      {dataset && (
        <AutoAnnotateModal
          open={isAutoAnnotateOpen}
          onOpenChange={setIsAutoAnnotateOpen}
          datasetId={dataset.id}
          datasetName={dataset.name}
          imageCollections={imageCollections}
        />
      )}
    </div>
  );
}
