import * as React from 'react';
import { Loader2, MousePointerClick, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { AnnotationClass } from '@/pages/image-annotation/types';
import type { Insid3Reference } from '@/components/annotation/insid3Types';
import { DINOV3_HF_MODEL_URL } from '@/components/annotation/foundationModelLinks';

export interface Insid3ReferencePanelProps {
  classes: AnnotationClass[];
  targetClassId: string | null;
  onTargetClassChange: (classId: string) => void;
  references: Insid3Reference[];
  onRemoveReference: (id: string) => void;
  onClearReferences: () => void;
  onFindSimilar: () => void;
  isPropagating: boolean;
  propagateProgress: { current: number; total: number } | null;
  excludeReferenceImages: boolean;
  onExcludeReferenceImagesChange: (value: boolean) => void;
  canRun: boolean;
  insid3Available: boolean;
  insid3WeightsMissing?: boolean;
  insid3UnavailableDetail?: string;
  pickableOnCurrentImage: number;
  referenceClassName?: string | null;
}

export function Insid3ReferencePanel({
  classes,
  targetClassId,
  onTargetClassChange,
  references,
  onRemoveReference,
  onClearReferences,
  onFindSimilar,
  isPropagating,
  propagateProgress,
  excludeReferenceImages,
  onExcludeReferenceImagesChange,
  canRun,
  insid3Available,
  insid3WeightsMissing = true,
  insid3UnavailableDetail,
  pickableOnCurrentImage,
  referenceClassName,
}: Insid3ReferencePanelProps) {
  if (!insid3Available) {
    if (!insid3WeightsMissing && insid3UnavailableDetail) {
      return (
        <div className="mt-2 rounded-md border border-border bg-muted/30 p-2 text-[11px] text-foreground">
          From example (INSID3) is not available. DINOv3 weights are present but INSID3 failed to
          load: {insid3UnavailableDetail}. Rebuild and restart{' '}
          <code className="text-[10px]">sam_service</code> with the GPU profile (
          <code className="text-[10px]">lai build</code> then{' '}
          <code className="text-[10px]">docker compose up -d sam_service --force-recreate</code>).
        </div>
      );
    }
    return (
      <div className="mt-2 rounded-md border border-border bg-muted/30 p-2 text-[11px] text-foreground">
        From example (INSID3) is not available. Request access and download DINOv3 weights from{' '}
        <a
          href={DINOV3_HF_MODEL_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="underline"
        >
          Hugging Face
        </a>{' '}
        (license approval required), place the <code className="text-[10px]">.pth</code> file in{' '}
        <code className="text-[10px]">DINOV3_WEIGHTS_HOST_PATH</code> (run{' '}
        <code className="text-[10px]">lai install</code>), then restart{' '}
        <code className="text-[10px]">sam_service</code> with the GPU profile.
      </div>
    );
  }

  return (
    <div className="mt-2 space-y-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-2">
      <div className="rounded border border-amber-500/20 bg-amber-500/10 px-2 py-1.5 text-[11px] text-foreground space-y-1">
        <p className="font-medium flex items-center gap-1.5">
          <MousePointerClick className="h-3.5 w-3.5 shrink-0" />
          How to use INSID3
        </p>
        <ol className="list-decimal list-inside space-y-0.5 text-muted-foreground">
          <li>Click any existing mask on the image to add it as an example</li>
          <li>Click again to remove · use Prev/Next for more images</li>
          <li>Find similar across the layer</li>
        </ol>
      </div>

      <div>
        <Label className="text-xs text-muted-foreground">Target class</Label>
        <Select value={targetClassId || ''} onValueChange={onTargetClassChange}>
          <SelectTrigger className="h-8 text-xs bg-muted border-border mt-1">
            <SelectValue placeholder="Select class" />
          </SelectTrigger>
          <SelectContent>
            {classes.map((c) => (
              <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {referenceClassName ? (
          <p className="text-[10px] text-muted-foreground mt-1">
            Finding class: <span className="text-foreground font-medium">{referenceClassName}</span>
            {pickableOnCurrentImage > 0
              ? ` · ${pickableOnCurrentImage} mask${pickableOnCurrentImage === 1 ? '' : 's'} on this image`
              : ' · no masks on this image — use Prev/Next'}
          </p>
        ) : (
          <p className="text-[10px] text-muted-foreground mt-1">
            {pickableOnCurrentImage > 0
              ? `${pickableOnCurrentImage} mask${pickableOnCurrentImage === 1 ? '' : 's'} on this image — click one to start.`
              : 'No masks on this image — draw annotations first or go to another image.'}
          </p>
        )}
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          References ({references.length})
        </span>
        {references.length > 0 && (
          <Button variant="ghost" size="sm" className="h-6 text-[10px] px-1" onClick={onClearReferences}>
            Clear all
          </Button>
        )}
      </div>

      <div className="max-h-28 overflow-y-auto space-y-1">
        {references.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            No references yet — click a mask on the canvas.
          </p>
        ) : (
          references.map((ref) => (
            <div
              key={ref.id}
              className="flex items-center gap-1 rounded border border-border bg-muted/40 px-2 py-1 text-[11px]"
            >
              <span className="flex-1 truncate" title={ref.imageName}>
                {ref.imageName} · {ref.className}
              </span>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => onRemoveReference(ref.id)}
                aria-label="Remove reference"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))
        )}
      </div>

      <label className="flex items-start gap-2 text-[11px] leading-snug text-muted-foreground cursor-pointer">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={!excludeReferenceImages}
          onChange={(e) => onExcludeReferenceImagesChange(!e.target.checked)}
          disabled={isPropagating}
        />
        <span>
          Include reference images when searching the layer (off by default — reference images are
          skipped so INSID3 only searches other images).
        </span>
      </label>

      <Button
        variant="default"
        size="sm"
        className="w-full h-8 text-xs"
        disabled={!canRun || isPropagating}
        onClick={onFindSimilar}
      >
        {isPropagating && propagateProgress ? (
          <>
            <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />
            Finding {propagateProgress.current}/{propagateProgress.total}
          </>
        ) : (
          <>
            <Search className="w-3 h-3 mr-1.5" />
            Find similar in layer
          </>
        )}
      </Button>
    </div>
  );
}
