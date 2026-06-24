import type { ReactNode } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { formatArea } from '@/pages/image-annotation/utils';
import { AlertCircle, CheckCircle2, Layers, ScanSearch, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

export type Sam3RegionSummary = {
  index: number;
  vertices: number;
  areaPx: number;
};

export type Sam3ResultsDialogData =
  | {
      mode: 'preview';
      outcome: 'found';
      imageName: string;
      textPrompt: string | null;
      pointCount: number;
      minArea: number;
      filteredOutCount: number;
      hasMask: boolean;
      imageSize?: { width: number; height: number };
      regions: Sam3RegionSummary[];
    }
  | {
      mode: 'preview';
      outcome: 'empty';
      imageName: string;
      textPrompt: string | null;
      pointCount: number;
      minArea: number;
      filteredOutCount?: number;
    }
  | {
      mode: 'preview';
      outcome: 'error';
      imageName?: string;
      message: string;
      detail?: string;
    }
  | {
      mode: 'batch';
      outcome: 'complete' | 'empty' | 'cancelled';
      textPrompt: string;
      className: string;
      totalImages: number;
      imagesWithMatches: number;
      annotationsAdded: number;
      failCount: number;
    };

type Sam3ResultsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: Sam3ResultsDialogData | null;
};

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 text-sm">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="text-right font-medium break-all">{value}</span>
    </div>
  );
}

export function Sam3ResultsDialog({ open, onOpenChange, data }: Sam3ResultsDialogProps) {
  if (!data) return null;

  const isSuccess =
    (data.mode === 'preview' && data.outcome === 'found') ||
    (data.mode === 'batch' && data.outcome === 'complete' && data.annotationsAdded > 0);
  const isWarning =
    (data.mode === 'preview' && data.outcome === 'empty') ||
    (data.mode === 'batch' && (data.outcome === 'empty' || data.outcome === 'cancelled')) ||
    (data.mode === 'batch' && data.outcome === 'complete' && data.failCount > 0);
  const isError = data.mode === 'preview' && data.outcome === 'error';

  const title = (() => {
    if (data.mode === 'preview') {
      if (data.outcome === 'found') {
        const n = data.regions.length;
        return `SAM 3 found ${n} region${n === 1 ? '' : 's'}`;
      }
      if (data.outcome === 'empty') return 'SAM 3 — no matches';
      return 'SAM 3 failed';
    }
    if (data.outcome === 'cancelled') return 'SAM 3 batch cancelled';
    if (data.outcome === 'empty') return 'SAM 3 batch — no matches';
    if (data.failCount > 0) return 'SAM 3 batch finished with errors';
    return 'SAM 3 batch complete';
  })();

  const description = (() => {
    if (data.mode === 'preview' && data.outcome === 'found') {
      return 'Review the highlighted preview on the canvas, then click Apply to save as annotations.';
    }
    if (data.mode === 'preview' && data.outcome === 'empty') {
      return 'Try a different text prompt, add click points on the object, or lower the minimum area filter.';
    }
    if (data.mode === 'batch' && data.outcome === 'complete' && data.annotationsAdded > 0) {
      return 'Annotations were added directly to each image in the current layer.';
    }
    if (data.mode === 'batch' && data.outcome === 'empty') {
      return 'No objects matching your prompt were detected in this layer.';
    }
    if (data.mode === 'batch' && data.outcome === 'cancelled') {
      return data.annotationsAdded > 0
        ? 'Processing stopped early; partial results were saved.'
        : 'Processing was stopped before any annotations were added.';
    }
    return undefined;
  })();

  const Icon = isError ? XCircle : isSuccess ? CheckCircle2 : isWarning ? AlertCircle : ScanSearch;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] flex flex-col">
        <DialogHeader>
          <div className="flex items-start gap-3">
            <div
              className={cn(
                'mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full',
                isError && 'bg-destructive/15 text-destructive',
                isSuccess && 'bg-green-500/15 text-green-600 dark:text-green-400',
                !isError && !isSuccess && 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
              )}
            >
              <Icon className="h-5 w-5" />
            </div>
            <div className="min-w-0 space-y-1">
              <DialogTitle>{title}</DialogTitle>
              {description ? <DialogDescription>{description}</DialogDescription> : null}
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4 py-1 overflow-hidden min-h-0">
          {data.mode === 'preview' && data.outcome === 'found' && (
            <>
              <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
                <DetailRow label="Image" value={data.imageName} />
                {data.imageSize ? (
                  <DetailRow
                    label="Size"
                    value={`${data.imageSize.width} × ${data.imageSize.height} px`}
                  />
                ) : null}
                {data.textPrompt ? (
                  <DetailRow label="Text prompt" value={`"${data.textPrompt}"`} />
                ) : (
                  <DetailRow label="Mode" value="Point prompts" />
                )}
                {data.pointCount > 0 ? (
                  <DetailRow
                    label="Click points"
                    value={`${data.pointCount} point${data.pointCount === 1 ? '' : 's'}`}
                  />
                ) : null}
                {data.minArea > 0 ? (
                  <DetailRow label="Min. area filter" value={formatArea(data.minArea)} />
                ) : null}
                {data.filteredOutCount > 0 ? (
                  <DetailRow
                    label="Filtered out"
                    value={`${data.filteredOutCount} region${data.filteredOutCount === 1 ? '' : 's'} below min. area`}
                  />
                ) : null}
                <DetailRow label="Mask overlay" value={data.hasMask ? 'Yes' : 'No'} />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Regions</span>
                  <Badge variant="secondary">{data.regions.length}</Badge>
                </div>
                <ScrollArea className="h-[min(220px,40vh)] rounded-md border">
                  <div className="divide-y">
                    {data.regions.map((region) => (
                      <div
                        key={region.index}
                        className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                      >
                        <span className="font-medium">Region {region.index}</span>
                        <span className="text-muted-foreground text-right">
                          {formatArea(region.areaPx)}
                          <span className="mx-1.5">·</span>
                          {region.vertices} vertices
                        </span>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </div>
            </>
          )}

          {data.mode === 'preview' && data.outcome === 'empty' && (
            <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
              <DetailRow label="Image" value={data.imageName} />
              {data.textPrompt ? (
                <DetailRow label="Text prompt" value={`"${data.textPrompt}"`} />
              ) : (
                <DetailRow label="Mode" value="Point prompts only" />
              )}
              {data.pointCount > 0 ? (
                <DetailRow label="Click points" value={String(data.pointCount)} />
              ) : null}
              {data.minArea > 0 ? (
                <DetailRow label="Min. area filter" value={formatArea(data.minArea)} />
              ) : null}
              {(data.filteredOutCount ?? 0) > 0 ? (
                <DetailRow
                  label="Note"
                  value={`${data.filteredOutCount} region(s) removed by min. area filter`}
                />
              ) : null}
            </div>
          )}

          {data.mode === 'preview' && data.outcome === 'error' && (
            <div className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
              {data.imageName ? <DetailRow label="Image" value={data.imageName} /> : null}
              <DetailRow label="Error" value={data.message} />
              {data.detail ? <DetailRow label="Detail" value={data.detail} /> : null}
            </div>
          )}

          {data.mode === 'batch' && (
            <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
              <DetailRow label="Text prompt" value={`"${data.textPrompt}"`} />
              <DetailRow label="Class" value={data.className} />
              <Separator className="my-2" />
              <DetailRow label="Images in layer" value={String(data.totalImages)} />
              <DetailRow
                label="Images with matches"
                value={`${data.imagesWithMatches} of ${data.totalImages}`}
              />
              <DetailRow
                label="Annotations added"
                value={
                  <span className="inline-flex items-center gap-1.5">
                    <Layers className="h-3.5 w-3.5" />
                    {data.annotationsAdded}
                  </span>
                }
              />
              {data.failCount > 0 ? (
                <DetailRow
                  label="Failed images"
                  value={<span className="text-destructive">{data.failCount}</span>}
                />
              ) : null}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>OK</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
