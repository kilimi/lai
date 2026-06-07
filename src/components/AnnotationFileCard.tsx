/**
 * AnnotationFileCard
 * ------------------
 * Compact "mini-card" row for an annotation file. Replaces the dense inline
 * row that lived in AnnotationsContent. Keeps the list scannable like a table
 * but visually consistent with TrainingCard/ProjectCard.
 *
 * Visibility: single eye toggle for masks; bbox toggle is hidden inside the ⋯
 * menu (see SuggestionsContext).
 */
import { Loader, Eye, EyeOff, MoreHorizontal, Tag, Brush, Edit, Hash, Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { AnnotationFile } from "@/utils/annotations";

export type AnnotationDisplayType =
  | "Classification"
  | "Segmentation (mask+bbox)"
  | "Segmentation (mask)"
  | "Segmentation (bbox)"
  | "Other";

const SHORT_TYPE: Record<AnnotationDisplayType, string> = {
  Classification: "Class",
  "Segmentation (mask+bbox)": "Masks + Boxes",
  "Segmentation (mask)": "Masks",
  "Segmentation (bbox)": "Boxes",
  Other: "Other",
};

/** Stable accent per tag so multiple tags are easy to tell apart. */
const TAG_ACCENT_CLASSES = [
  "bg-sky-500/15 text-sky-800 dark:text-sky-200 border-sky-500/40",
  "bg-violet-500/15 text-violet-800 dark:text-violet-200 border-violet-500/40",
  "bg-amber-500/15 text-amber-900 dark:text-amber-100 border-amber-500/45",
  "bg-emerald-500/15 text-emerald-800 dark:text-emerald-200 border-emerald-500/40",
  "bg-rose-500/15 text-rose-800 dark:text-rose-200 border-rose-500/40",
] as const;

function tagAccentClass(tag: string): string {
  let hash = 0;
  for (let i = 0; i < tag.length; i += 1) {
    hash = (hash + tag.charCodeAt(i)) % TAG_ACCENT_CLASSES.length;
  }
  return TAG_ACCENT_CLASSES[hash];
}

interface Props {
  file: AnnotationFile;
  index: number;
  density: "comfortable" | "compact";
  selectedAnnotation: string | null;
  visible: boolean;
  showBboxes: boolean;
  loading: boolean;
  type: AnnotationDisplayType;
  isUnsupported: boolean;
  unsupportedReason?: string;
  importing: boolean;
  processing: boolean;
  // selection
  mergeMode: boolean;
  selectedForMerge: boolean;
  mergeSelectDisabled?: boolean;
  mergeSelectDisabledReason?: string;
  onToggleSelect: () => void;
  // primary
  onOpen: () => void;
  onToggleVisibility: (e: React.MouseEvent) => void;
  // menu
  onToggleBboxes: (e: React.MouseEvent) => void;
  onEditName: (e: React.MouseEvent) => void;
  onEditAnnotations: (e: React.MouseEvent) => void;
  onTags: (e: React.MouseEvent) => void;
  onDuplicate: (e: React.MouseEvent) => void;
  onDownload: (e: React.MouseEvent) => void;
  onDownloadImages: (e: React.MouseEvent) => void;
  onDelete: (e: React.MouseEvent) => void;
  // children = optional expanded body
  children?: React.ReactNode;
}

export function AnnotationFileCard(props: Props) {
  const {
    file, index, density, selectedAnnotation, visible, showBboxes, loading, type,
    isUnsupported, unsupportedReason, importing, processing, mergeMode, selectedForMerge,
    mergeSelectDisabled, mergeSelectDisabledReason,
    onToggleSelect, onOpen, onToggleVisibility, onToggleBboxes, onEditName, onEditAnnotations,
    onTags, onDuplicate, onDownload, onDownloadImages, onDelete, children,
  } = props;

  const isOpen = selectedAnnotation === file.id;
  const isCompact = density === "compact";
  const padding = isCompact ? "px-3 py-2" : "p-4";

  const classChips = (file.classStats || []).slice(0, 6);
  const moreClasses = (file.classStats?.length || 0) - classChips.length;

  return (
    <div
      className={cn(
        "group/card border rounded-lg overflow-hidden transition-colors",
        isOpen ? "border-primary/40 bg-card" : "border-border/60 bg-card/40 hover:bg-accent/30",
        isUnsupported && "border-yellow-500/40 bg-yellow-500/5",
        mergeMode && mergeSelectDisabled && !selectedForMerge && "opacity-50",
      )}
    >
      <div className={cn("cursor-pointer", padding)} onClick={onOpen}>
        <div className="flex items-start gap-3">
          {/* Selection: hover-reveal unless mergeMode is on */}
          <div
            className={cn(
              "pt-0.5 transition-opacity",
              mergeMode ? "opacity-100" : "opacity-0 group-hover/card:opacity-100 focus-within:opacity-100"
            )}
            onClick={(e) => e.stopPropagation()}
          >
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <Checkbox
                      checked={selectedForMerge}
                      disabled={mergeSelectDisabled}
                      onCheckedChange={onToggleSelect}
                      aria-label={`Select ${file.name}`}
                    />
                  </span>
                </TooltipTrigger>
                {mergeSelectDisabled && mergeSelectDisabledReason && (
                  <TooltipContent side="right" className="max-w-xs text-xs">
                    {mergeSelectDisabledReason}
                  </TooltipContent>
                )}
              </Tooltip>
            </TooltipProvider>
          </div>

          {/* Number + status dot */}
          {!isCompact && (
            <div className="flex flex-col items-center pt-0.5 min-w-[28px]">
              <span className="text-[10px] text-muted-foreground font-mono tabular-nums">
                #{index + 1}
              </span>
            </div>
          )}

          {/* Main column */}
          <div className="flex-1 min-w-0">
            {/* Title row */}
            <div className="flex items-center gap-2 min-w-0">
              <h3 className="font-medium truncate" title={file.name}>{file.name}</h3>
              <Badge
                variant="outline"
                className={cn(
                  "text-[10px] px-1.5 py-0 h-4 font-medium uppercase tracking-wide",
                  isUnsupported
                    ? "border-yellow-500/50 text-yellow-700 dark:text-yellow-300 bg-yellow-500/10"
                    : "border-border bg-muted/50 text-muted-foreground"
                )}
              >
                {SHORT_TYPE[type] || type}
              </Badge>
              {importing && (
                <Badge variant="secondary" className="text-[10px] h-4 px-1.5 gap-1 bg-primary/15 text-primary border-primary/30">
                  <Loader className="h-2.5 w-2.5 animate-spin" /> Importing
                </Badge>
              )}
              {processing && (
                <Badge variant="secondary" className="text-[10px] h-4 px-1.5 gap-1 bg-yellow-500/15 text-yellow-700 dark:text-yellow-300 border-yellow-500/30">
                  <Loader className="h-2.5 w-2.5 animate-spin" /> Processing
                </Badge>
              )}
              {file.processing_status === "failed" && (
                <Badge variant="secondary" className="text-[10px] h-4 px-1.5 bg-destructive/15 text-destructive border-destructive/30" title={file.error_message || "Processing failed"}>
                  Failed
                </Badge>
              )}
            </div>

            {/* Subtitle: format · date */}
            <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-2 flex-wrap">
              <span className="uppercase tracking-wide">{file.format || "COCO"}</span>
              <span aria-hidden>·</span>
              <span>{new Date(file.date).toLocaleDateString()}</span>
              {unsupportedReason && (
                <>
                  <span aria-hidden>·</span>
                  <span className="text-yellow-700 dark:text-yellow-400">{unsupportedReason}</span>
                </>
              )}
            </div>

            {/* Tags — own row so they stand out from metadata */}
            {file.tags && file.tags.length > 0 && (
              <div className="mt-1.5 flex flex-wrap items-center gap-1">
                {file.tags.slice(0, isCompact ? 2 : 4).map((tag) => (
                  <Badge
                    key={tag}
                    variant="outline"
                    className={cn(
                      "text-[10px] h-5 px-1.5 font-medium shrink-0 shadow-sm",
                      tagAccentClass(tag),
                    )}
                  >
                    <Tag className="h-2.5 w-2.5 mr-1 shrink-0 opacity-80" />
                    {tag}
                  </Badge>
                ))}
                {file.tags.length > (isCompact ? 2 : 4) && (
                  <Badge
                    variant="outline"
                    className="text-[10px] h-5 px-1.5 font-medium bg-muted/80 text-foreground border-border"
                    title={file.tags.slice(isCompact ? 2 : 4).join(", ")}
                  >
                    +{file.tags.length - (isCompact ? 2 : 4)}
                  </Badge>
                )}
              </div>
            )}

            {/* Stats row */}
            {!isCompact && (
              <div className="mt-2 flex items-center gap-4 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <Hash className="h-3 w-3" />
                  <span className="tabular-nums text-foreground font-medium">
                    {(file.totalSampleCount || 0).toLocaleString()}
                  </span>
                  instances
                </span>
                <TooltipProvider delayDuration={150}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex items-center gap-1.5 cursor-default">
                        <Layers className="h-3 w-3" />
                        <span className="tabular-nums text-foreground font-medium">{file.classCount}</span>
                        classes
                        {classChips.length > 0 && (
                          <span className="inline-flex items-center gap-0.5 ml-1">
                            {classChips.map((c) => (
                              <span
                                key={c.className}
                                className="inline-block h-2 w-2 rounded-full ring-1 ring-background"
                                style={{ backgroundColor: c.color }}
                              />
                            ))}
                            {moreClasses > 0 && (
                              <span className="text-[10px] ml-1">+{moreClasses}</span>
                            )}
                          </span>
                        )}
                      </span>
                    </TooltipTrigger>
                    {classChips.length > 0 && (
                      <TooltipContent side="top" className="max-w-xs">
                        <div className="flex flex-wrap gap-1">
                          {(file.classStats || []).map((c) => (
                            <span
                              key={c.className}
                              className="inline-flex items-center gap-1.5 text-xs px-1.5 py-0.5 rounded"
                              style={{ backgroundColor: `${c.color}33`, color: "inherit" }}
                            >
                              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: c.color }} />
                              {c.className}
                              <span className="tabular-nums opacity-70">{c.count}</span>
                            </span>
                          ))}
                        </div>
                      </TooltipContent>
                    )}
                  </Tooltip>
                </TooltipProvider>
                {file.imageCount > 0 && (
                  <span
                    className="inline-flex items-center gap-1.5"
                    title="Images in this dataset that have at least one annotation"
                  >
                    <span className="tabular-nums text-foreground font-medium">{file.imageCount}</span>
                    annotated images
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Right-side controls */}
          <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
            {/* Visibility toggle (single eye) */}
            <Button
              variant="ghost"
              size="icon"
              className={cn("h-8 w-8", visible ? "text-primary" : "text-muted-foreground")}
              onClick={onToggleVisibility}
              disabled={loading}
              title={visible ? "Hide annotations" : "Show annotations"}
            >
              {loading ? (
                <Loader className="h-4 w-4 animate-spin" />
              ) : visible ? (
                <Eye className="h-4 w-4" />
              ) : (
                <EyeOff className="h-4 w-4" />
              )}
            </Button>

            {/* Primary action */}
            {!isUnsupported && (
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                onClick={type === "Classification" ? onEditAnnotations : onEditAnnotations}
              >
                {type === "Classification" ? (
                  <Edit className="h-3.5 w-3.5 mr-1.5" />
                ) : (
                  <Brush className="h-3.5 w-3.5 mr-1.5" />
                )}
                {type === "Classification" ? "Edit" : "Annotate"}
              </Button>
            )}

            {/* ⋯ menu */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8" title="More actions">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem onClick={onToggleBboxes}>
                  {showBboxes ? "Hide bounding boxes" : "Show bounding boxes"}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onTags}>
                  <Tag className="h-4 w-4 mr-2" /> Manage tags
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onEditName}>
                  <Edit className="h-4 w-4 mr-2" /> Rename file
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onDuplicate}>Duplicate</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onDownload}>Download annotations</DropdownMenuItem>
                <DropdownMenuItem onClick={onDownloadImages}>Download images by class</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onDelete} className="text-destructive focus:text-destructive">
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      {/* Expanded body (statistics) */}
      {isOpen && children && (
        <div className="border-t border-border bg-muted/20">{children}</div>
      )}
    </div>
  );
}

export function AnnotationFileSkeleton({ density }: { density: "comfortable" | "compact" }) {
  const padding = density === "compact" ? "px-3 py-2" : "p-4";
  return (
    <div className={cn("border border-border/60 rounded-lg bg-card/40 animate-pulse", padding)}>
      <div className="flex items-center gap-3">
        <div className="h-4 w-4 rounded bg-muted" />
        <div className="flex-1 space-y-2">
          <div className="h-3 bg-muted rounded w-1/3" />
          <div className="h-2 bg-muted rounded w-1/2" />
        </div>
        <div className="h-7 w-20 rounded bg-muted" />
      </div>
    </div>
  );
}
