import { useState, type ReactNode } from 'react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { AnnotationClass } from '@/pages/image-annotation/types';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { formatArea } from '@/pages/image-annotation/utils';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Copy,
  Layers,
  ScanSearch,
  XCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';

export type Insid3ReferenceDiagnostics = {
  index: number;
  imageName?: string;
  width?: number;
  height?: number;
  polygonVertices?: number;
  polygonArea?: number;
  maskPixels?: number | null;
  warning?: string | null;
  rasterStrategy?: string;
};

export type Insid3SampleDiagnostics = {
  image: string;
  outcome: string;
  reason?: string;
  positivePixels?: number;
  skippedByMinArea?: number;
};

export type Insid3ProcessingDiagnostics = {
  pipeline?: string[];
  hints?: string[];
  selfTest?: {
    ok?: boolean;
    reason?: string;
  };
  settings?: {
    modelSize?: string;
    imageSize?: number;
    minArea?: number;
  };
  references?: Insid3ReferenceDiagnostics[];
  outcomes?: Record<string, number>;
  samples?: Insid3SampleDiagnostics[];
  outcome?: string;
  reason?: string;
  inference?: {
    positivePixels?: number;
    predMin?: number;
    predMax?: number;
  };
  postprocess?: {
    rawPositivePixels?: number;
    components?: number;
    polygonsExported?: number;
    skippedByMinArea?: number;
  };
};

export type Insid3ReferenceSummary = {
  index: number;
  imageName: string;
  className: string;
};

export type Insid3RegionSummary = {
  index: number;
  vertices: number;
  areaPx: number;
};

export type Insid3ResultsDialogData =
  | {
      mode: 'preview';
      outcome: 'found';
      imageName: string;
      className: string;
      referenceCount: number;
      references: Insid3ReferenceSummary[];
      minArea: number;
      imageSize?: { width: number; height: number };
      hasMask: boolean;
      regions: Insid3RegionSummary[];
      diagnostics?: Insid3ProcessingDiagnostics;
    }
  | {
      mode: 'preview';
      outcome: 'empty';
      imageName: string;
      className: string;
      referenceCount: number;
      references: Insid3ReferenceSummary[];
      minArea: number;
      imageSize?: { width: number; height: number };
      diagnostics?: Insid3ProcessingDiagnostics;
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
      outcome: 'complete' | 'empty' | 'error';
      className: string;
      referenceCount: number;
      references: Insid3ReferenceSummary[];
      totalImages: number;
      imagesWithMatches: number;
      annotationsAdded: number;
      /** Total polygon regions found (before user applies to annotations). */
      totalPolygons?: number;
      /** False until the user confirms “Add to annotations”. */
      applied?: boolean;
      defaultClassId?: string;
      failCount: number;
      minArea: number;
      layerImageCount?: number;
      excludedReferenceCount?: number;
      emptyReason?: string;
      message?: string;
      detail?: string;
      diagnostics?: Insid3ProcessingDiagnostics;
    };

type Insid3ResultsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: Insid3ResultsDialogData | null;
  classes?: AnnotationClass[];
  applyClassId?: string | null;
  onApplyClassIdChange?: (classId: string) => void;
  onApplyBatch?: () => void;
  isApplyingBatch?: boolean;
};

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 text-sm">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="text-right font-medium break-all">{value}</span>
    </div>
  );
}

function ReferenceList({ references }: { references: Insid3ReferenceSummary[] }) {
  if (references.length === 0) return null;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">References</span>
        <Badge variant="secondary">{references.length}</Badge>
      </div>
      <ScrollArea className="h-[min(140px,24vh)] rounded-md border">
        <div className="divide-y">
          {references.map((ref) => (
            <div
              key={ref.index}
              className="flex items-start justify-between gap-3 px-3 py-2 text-sm"
            >
              <span className="font-medium shrink-0">#{ref.index}</span>
              <span className="text-muted-foreground text-right">
                {ref.imageName}
                <span className="mx-1.5">·</span>
                {ref.className}
              </span>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

const OUTCOME_LABELS: Record<string, string> = {
  match: 'Match exported',
  empty_model_mask: 'No similar region (empty mask)',
  empty_reference_mask: 'Empty reference mask',
  filtered_by_min_area: 'Filtered by min. area',
  no_polygons: 'Mask but no polygons',
  error: 'Inference error',
  no_match: 'No match',
};

function outcomeLabel(key: string): string {
  return OUTCOME_LABELS[key] ?? key.replace(/_/g, ' ');
}

function Insid3ProcessingDetails({ diagnostics }: { diagnostics: Insid3ProcessingDiagnostics }) {
  const [open, setOpen] = useState(false);
  const settings = diagnostics.settings;
  const references = diagnostics.references ?? [];
  const outcomes = diagnostics.outcomes ?? {};
  const outcomeEntries = Object.entries(outcomes).sort((a, b) => b[1] - a[1]);
  const hasBatchOutcomes = outcomeEntries.length > 0;
  const hints = diagnostics.hints ?? [];
  const pipeline = diagnostics.pipeline ?? [
    'Load reference image(s) and rasterize annotation polygon(s) to masks.',
    'Encode references with DINOv3 (INSID3) and compare to each target image.',
    'Run in-context segmentation to produce a similarity mask on the target.',
    'Extract connected components as polygons; discard regions below min_area.',
  ];

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border">
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="flex w-full items-center justify-between gap-2 px-3 py-2 h-auto font-medium text-sm hover:bg-muted/50"
        >
          <span>More — processing details</span>
          <ChevronDown
            className={cn('h-4 w-4 shrink-0 transition-transform', open && 'rotate-180')}
          />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-3 border-t px-3 py-3 text-sm">
          <div className="space-y-1.5">
            <p className="font-medium">Pipeline</p>
            <ol className="list-decimal space-y-1 pl-4 text-muted-foreground">
              {pipeline.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </div>

          {diagnostics.selfTest ? (
            <div className="space-y-1.5">
              <p className="font-medium">Reference self-test</p>
              <div
                className={cn(
                  'rounded-md p-2 text-sm',
                  diagnostics.selfTest.ok
                    ? 'bg-green-500/10 text-green-700 dark:text-green-400'
                    : 'bg-destructive/10 text-destructive',
                )}
              >
                {diagnostics.selfTest.ok ? 'Passed' : 'Failed'} — {diagnostics.selfTest.reason}
              </div>
            </div>
          ) : null}

          {settings ? (
            <div className="space-y-1.5">
              <p className="font-medium">Settings</p>
              <div className="rounded-md bg-muted/40 p-2 space-y-1 text-muted-foreground">
                <p>Model: DINOv3 ViT-{settings.modelSize === 'small' ? 'S' : settings.modelSize === 'large' ? 'L' : 'B'} ({settings.modelSize})</p>
                <p>Inference resize: {settings.imageSize ?? 768} px</p>
                {settings.minArea != null && settings.minArea > 0 ? (
                  <p>Min. area filter: {formatArea(settings.minArea)}</p>
                ) : (
                  <p>Min. area filter: off</p>
                )}
              </div>
            </div>
          ) : null}

          {references.length > 0 ? (
            <div className="space-y-1.5">
              <p className="font-medium">Reference masks (rasterized)</p>
              <div className="rounded-md border divide-y text-xs">
                {references.map((ref) => (
                  <div key={ref.index} className="flex flex-col gap-0.5 px-2 py-1.5">
                    <span className="font-medium">
                      #{ref.index + 1} {ref.imageName ?? 'reference'}
                    </span>
                    <span className="text-muted-foreground">
                      {ref.width && ref.height ? `${ref.width}×${ref.height} px` : 'size unknown'}
                      {ref.polygonVertices != null ? ` · ${ref.polygonVertices} vertices` : ''}
                      {ref.polygonArea != null ? ` · poly area ${Math.round(ref.polygonArea)} px²` : ''}
                      {ref.maskPixels != null ? ` · mask ${ref.maskPixels.toLocaleString()} px` : ' · mask (not checked)'}
                    </span>
                    {ref.rasterStrategy ? (
                      <span className="text-muted-foreground">
                        Raster strategy: {ref.rasterStrategy}
                      </span>
                    ) : null}
                    {ref.warning === 'empty_reference_mask' ? (
                      <span className="text-amber-600 dark:text-amber-400">
                        Empty mask — polygon may be misaligned with image dimensions.
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {diagnostics.inference ? (
            <div className="space-y-1.5">
              <p className="font-medium">Last target inference</p>
              <div className="rounded-md bg-muted/40 p-2 text-muted-foreground space-y-1">
                <p>Positive mask pixels: {diagnostics.inference.positivePixels ?? 0}</p>
                {diagnostics.postprocess ? (
                  <>
                    <p>
                      Connected components: {diagnostics.postprocess.components ?? 0} · exported{' '}
                      {diagnostics.postprocess.polygonsExported ?? 0} polygon(s)
                    </p>
                    {(diagnostics.postprocess.skippedByMinArea ?? 0) > 0 ? (
                      <p>Skipped by min. area: {diagnostics.postprocess.skippedByMinArea}</p>
                    ) : null}
                  </>
                ) : null}
                {diagnostics.reason ? (
                  <p className="text-foreground pt-1">{diagnostics.reason}</p>
                ) : null}
              </div>
            </div>
          ) : null}

          {hasBatchOutcomes ? (
            <div className="space-y-1.5">
              <p className="font-medium">Outcome breakdown (searched images)</p>
              <div className="rounded-md border divide-y text-xs">
                {outcomeEntries.map(([key, count]) => (
                  <div key={key} className="flex justify-between gap-3 px-2 py-1.5">
                    <span>{outcomeLabel(key)}</span>
                    <span className="font-medium tabular-nums">{count}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {(diagnostics.samples?.length ?? 0) > 0 ? (
            <div className="space-y-1.5">
              <p className="font-medium">Sample images (no match)</p>
              <ScrollArea className="h-[min(160px,22vh)] rounded-md border">
                <div className="divide-y text-xs">
                  {diagnostics.samples!.map((sample) => (
                    <div key={sample.image} className="space-y-0.5 px-2 py-1.5">
                      <p className="font-medium break-all">{sample.image}</p>
                      <p className="text-muted-foreground">{outcomeLabel(sample.outcome)}</p>
                      {sample.reason ? <p>{sample.reason}</p> : null}
                      {sample.positivePixels != null ? (
                        <p className="text-muted-foreground">
                          Mask pixels: {sample.positivePixels}
                          {sample.skippedByMinArea != null && sample.skippedByMinArea > 0
                            ? ` · ${sample.skippedByMinArea} skipped by min. area`
                            : ''}
                        </p>
                      ) : null}
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </div>
          ) : null}

          {hints.length > 0 ? (
            <div className="space-y-1.5">
              <p className="font-medium">What to try</p>
              <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
                {hints.map((hint) => (
                  <li key={hint}>{hint}</li>
                ))}
              </ul>
            </div>
          ) : diagnostics.outcome && diagnostics.outcome !== 'match' ? (
            <div className="space-y-1.5">
              <p className="font-medium">What to try</p>
              <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
                {diagnostics.outcome === 'empty_model_mask' ? (
                  <>
                    <li>Pick references that look like objects in the layer (same class, similar appearance).</li>
                    <li>Try more than one reference from different images.</li>
                    <li>Lower min. area only helps if a mask was detected but filtered out.</li>
                  </>
                ) : null}
                {diagnostics.outcome === 'filtered_by_min_area' ? (
                  <li>Lower the minimum area filter in the INSID3 panel.</li>
                ) : null}
                {diagnostics.outcome === 'empty_reference_mask' ? (
                  <li>Re-pick references on the image so the polygon aligns with the object.</li>
                ) : null}
              </ul>
            </div>
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function Insid3ResultsDialog({
  open,
  onOpenChange,
  data,
  classes = [],
  applyClassId,
  onApplyClassIdChange,
  onApplyBatch,
  isApplyingBatch = false,
}: Insid3ResultsDialogProps) {
  if (!data) return null;

  const batchAwaitingApply =
    data.mode === 'batch' &&
    data.outcome === 'complete' &&
    !data.applied &&
    (data.totalPolygons ?? 0) > 0;

  const isSuccess =
    (data.mode === 'preview' && data.outcome === 'found') ||
    (data.mode === 'batch' && data.outcome === 'complete' && data.applied && data.annotationsAdded > 0);
  const isWarning =
    (data.mode === 'preview' && data.outcome === 'empty') ||
    (data.mode === 'batch' && data.outcome === 'empty') ||
    batchAwaitingApply ||
    (data.mode === 'batch' && data.outcome === 'complete' && data.failCount > 0);
  const isError =
    (data.mode === 'preview' && data.outcome === 'error') ||
    (data.mode === 'batch' && data.outcome === 'error');

  const title = (() => {
    if (data.mode === 'preview') {
      if (data.outcome === 'found') {
        const n = data.regions.length;
        return `INSID3 found ${n} region${n === 1 ? '' : 's'}`;
      }
      if (data.outcome === 'empty') return 'INSID3 — no matches';
      return 'INSID3 preview failed';
    }
    if (data.outcome === 'error') return 'INSID3 find similar failed';
    if (data.outcome === 'empty') return 'INSID3 — no matches in layer';
    if (batchAwaitingApply) {
      const n = data.imagesWithMatches;
      return `INSID3 found matches on ${n} image${n === 1 ? '' : 's'}`;
    }
    if (data.failCount > 0) return 'INSID3 batch finished with errors';
    return 'INSID3 find similar complete';
  })();

  const description = (() => {
    if (data.mode === 'preview' && data.outcome === 'found') {
      return 'Review the highlighted preview on the canvas, then click Apply to save as annotations.';
    }
    if (data.mode === 'preview' && data.outcome === 'empty') {
      return 'Try different reference masks, re-pick references on the same image, or lower the minimum area filter.';
    }
    if (batchAwaitingApply) {
      return 'Choose a class and add the detected regions as annotations. They will be saved to the database so each image loads them when you open it.';
    }
    if (data.mode === 'batch' && data.outcome === 'complete' && data.applied && data.annotationsAdded > 0) {
      return 'Similar regions were added as annotations on matching images in the current layer.';
    }
    if (data.mode === 'batch' && data.outcome === 'empty') {
      if (data.emptyReason === 'all_reference_images_excluded') {
        return (
          'Every image in this layer is used as a reference and is skipped by default. ' +
          'Enable “Include reference images” or pick references from only some images in the layer.'
        );
      }
      if (data.emptyReason === 'no_images_in_layer') {
        return 'No images were found for this layer in the dataset.';
      }
      if (data.emptyReason === 'reference_self_test_failed') {
        return (
          'INSID3 failed a self-test on your reference image(s): the model could not segment the reference mask on its own source image. ' +
          'Open “More — processing details” for mask pixel counts and alignment hints, then re-pick references on the canvas.'
        );
      }
      return 'No similar regions were detected on any searchable image in this layer.';
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
                <DetailRow label="Target image" value={data.imageName} />
                {data.imageSize ? (
                  <DetailRow
                    label="Size"
                    value={`${data.imageSize.width} × ${data.imageSize.height} px`}
                  />
                ) : null}
                <DetailRow label="Target class" value={data.className} />
                <DetailRow label="References used" value={String(data.referenceCount)} />
                {data.minArea > 0 ? (
                  <DetailRow label="Min. area filter" value={formatArea(data.minArea)} />
                ) : null}
                <DetailRow label="Mask overlay" value={data.hasMask ? 'Yes' : 'No'} />
              </div>
              <ReferenceList references={data.references} />
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
            <>
              <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
                <DetailRow label="Target image" value={data.imageName} />
                {data.imageSize ? (
                  <DetailRow
                    label="Size"
                    value={`${data.imageSize.width} × ${data.imageSize.height} px`}
                  />
                ) : null}
                <DetailRow label="Target class" value={data.className} />
                <DetailRow label="References used" value={String(data.referenceCount)} />
                {data.minArea > 0 ? (
                  <DetailRow label="Min. area filter" value={formatArea(data.minArea)} />
                ) : null}
              </div>
              <ReferenceList references={data.references} />
              {data.diagnostics ? <Insid3ProcessingDetails diagnostics={data.diagnostics} /> : null}
            </>
          )}

          {data.mode === 'preview' && data.outcome === 'error' && (
            <div className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
              {data.imageName ? <DetailRow label="Target image" value={data.imageName} /> : null}
              <DetailRow label="Error" value={data.message} />
              {data.detail ? <DetailRow label="Detail" value={data.detail} /> : null}
            </div>
          )}

          {data.mode === 'batch' && (
            <>
              <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
                <DetailRow label="Target class" value={data.className} />
                <DetailRow
                  label="References"
                  value={
                    <span className="inline-flex items-center gap-1.5">
                      <Copy className="h-3.5 w-3.5" />
                      {data.referenceCount}
                    </span>
                  }
                />
                {data.minArea > 0 ? (
                  <DetailRow label="Min. area filter" value={formatArea(data.minArea)} />
                ) : null}
                {data.layerImageCount != null ? (
                  <DetailRow label="Images in layer" value={String(data.layerImageCount)} />
                ) : null}
                {(data.excludedReferenceCount ?? 0) > 0 ? (
                  <DetailRow
                    label="Skipped as references"
                    value={String(data.excludedReferenceCount)}
                  />
                ) : null}
                <Separator className="my-2" />
                <DetailRow label="Images searched" value={String(data.totalImages)} />
                <DetailRow
                  label="Images with matches"
                  value={`${data.imagesWithMatches} of ${data.totalImages}`}
                />
                {(data.totalPolygons ?? 0) > 0 ? (
                  <DetailRow
                    label="Regions found"
                    value={
                      <span className="inline-flex items-center gap-1.5">
                        <Layers className="h-3.5 w-3.5" />
                        {data.totalPolygons}
                        {data.imagesWithMatches > 0
                          ? ` on ${data.imagesWithMatches} image${data.imagesWithMatches === 1 ? '' : 's'}`
                          : ''}
                      </span>
                    }
                  />
                ) : null}
                <DetailRow
                  label="Annotations added"
                  value={
                    <span className="inline-flex items-center gap-1.5">
                      <Layers className="h-3.5 w-3.5" />
                      {data.applied ? data.annotationsAdded : '—'}
                    </span>
                  }
                />
                {data.failCount > 0 ? (
                  <DetailRow
                    label="Failed images"
                    value={<span className="text-destructive">{data.failCount}</span>}
                  />
                ) : null}
                {data.message ? <DetailRow label="Error" value={data.message} /> : null}
                {data.detail ? <DetailRow label="Detail" value={data.detail} /> : null}
              </div>
              <ReferenceList references={data.references} />
              {data.diagnostics ? <Insid3ProcessingDetails diagnostics={data.diagnostics} /> : null}
            </>
          )}
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-col sm:space-x-0">
          {batchAwaitingApply && classes.length > 0 ? (
            <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center">
              <Select
                value={applyClassId ?? data.defaultClassId ?? classes[0]?.id ?? ''}
                onValueChange={onApplyClassIdChange}
              >
                <SelectTrigger className="h-9 flex-1">
                  <SelectValue placeholder="Select class" />
                </SelectTrigger>
                <SelectContent>
                  {classes.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      <span className="inline-flex items-center gap-2">
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: c.color }}
                        />
                        {c.name}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                className="shrink-0"
                disabled={
                  isApplyingBatch ||
                  (!applyClassId && !data.defaultClassId && !classes[0]?.id)
                }
                onClick={onApplyBatch}
              >
                {isApplyingBatch ? 'Adding…' : 'Add to annotations'}
              </Button>
            </div>
          ) : null}
          <Button type="button" variant={batchAwaitingApply ? 'outline' : 'default'} onClick={() => onOpenChange(false)}>
            {batchAwaitingApply ? 'Close without adding' : 'OK'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
