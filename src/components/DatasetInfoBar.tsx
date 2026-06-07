import { Dataset } from "@/types";
import { FileImage, Tag, Files } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

interface DatasetInfoBarProps {
  dataset: Dataset;
  imageCount: number;
  annotationFileCount?: number;
  totalAnnotationCount?: number;
  uniqueClassCount?: number;
}

function StatItem({ icon, label, value, tooltip }: { icon: React.ReactNode; label: string; value: string | number; tooltip?: string }) {
  const content = (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-muted/50 border border-border/50">
      <span className="text-muted-foreground">{icon}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm font-semibold">{value}</span>
    </div>
  );

  if (tooltip) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{content}</TooltipTrigger>
          <TooltipContent><p>{tooltip}</p></TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }
  return content;
}

export function DatasetInfoBar({ dataset, imageCount, annotationFileCount, totalAnnotationCount, uniqueClassCount }: DatasetInfoBarProps) {
  const fileCount = annotationFileCount ?? dataset.annotation_file_count ?? 0;

  return (
    <div className="flex flex-wrap items-center gap-3">
      <StatItem
        icon={<FileImage className="h-3.5 w-3.5" />}
        label="Images"
        value={imageCount.toLocaleString()}
      />
      <StatItem
        icon={<Files className="h-3.5 w-3.5" />}
        label="Annotation Files"
        value={fileCount}
        tooltip={`${fileCount} annotation file(s) in this dataset`}
      />
      {uniqueClassCount !== undefined && uniqueClassCount > 0 && (
        <StatItem
          icon={<Tag className="h-3.5 w-3.5" />}
          label="Classes"
          value={uniqueClassCount}
          tooltip="Unique classes across all annotation files"
        />
      )}
      {dataset.tags && dataset.tags.length > 0 && (
        <div className="flex items-center gap-1.5 ml-2">
          {dataset.tags.map(tag => (
            <Badge key={tag} variant="secondary" className="text-xs px-2 py-0.5">
              {tag}
            </Badge>
          ))}
        </div>
      )}
      {dataset.description && (
        <span className="text-xs text-muted-foreground ml-2 italic truncate max-w-[300px]" title={dataset.description}>
          {dataset.description}
        </span>
      )}
    </div>
  );
}
