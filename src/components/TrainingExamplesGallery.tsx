import { useCallback, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { getApiBaseUrl } from "@/config/api";

const MAX_SAMPLES = 3;
const SPLITS = ["train", "val", "test", "val_predictions"] as const;

type ExampleSplit = (typeof SPLITS)[number];

const SPLIT_LABELS: Record<ExampleSplit, string> = {
  train: "Train",
  val: "Val",
  test: "Test",
  val_predictions: "Val predictions (MMYOLO)",
};

interface TrainingExamplesGalleryProps {
  taskId: number;
  exampleImages?: Record<string, string>;
  imageCounts?: { train?: number; val?: number; test?: number };
}

function sampleUrl(taskId: number, split: ExampleSplit, index: number): string {
  const base = getApiBaseUrl().replace(/\/$/, "");
  if (split === "val_predictions") {
    return `${base}/tasks/${taskId}/examples/val_predictions`;
  }
  return `${base}/tasks/${taskId}/examples/${split}/sample/${index}`;
}

function ExampleThumbnail({
  src,
  alt,
  onOpen,
}: {
  src: string;
  alt: string;
  onOpen: () => void;
}) {
  const [visible, setVisible] = useState(true);

  if (!visible) return null;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group relative flex-1 min-w-0 max-w-[33%] aspect-[4/3] rounded-md overflow-hidden border border-border bg-muted/30 hover:ring-2 hover:ring-primary/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      title="Click to enlarge"
    >
      <img
        src={src}
        alt={alt}
        className="w-full h-full object-contain bg-muted/50"
        loading="lazy"
        onError={() => setVisible(false)}
      />
      <span className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors pointer-events-none" />
    </button>
  );
}

export function TrainingExamplesGallery({
  taskId,
  exampleImages,
  imageCounts,
}: TrainingExamplesGalleryProps) {
  const [preview, setPreview] = useState<{ src: string; alt: string } | null>(null);

  const openPreview = useCallback((src: string, alt: string) => {
    setPreview({ src, alt });
  }, []);

  if (!exampleImages || Object.keys(exampleImages).length === 0) {
    return null;
  }

  return (
    <>
      <div className="space-y-4">
        {SPLITS.map((split) => {
          if (!exampleImages[split]) return null;

          const label = SPLIT_LABELS[split];
          const count =
            split === "val_predictions"
              ? undefined
              : imageCounts?.[split as keyof typeof imageCounts];

          const indices =
            split === "val_predictions"
              ? [1]
              : Array.from({ length: MAX_SAMPLES }, (_, i) => i + 1);

          return (
            <div key={split}>
              <div className="text-sm font-medium text-foreground mb-2 flex items-center gap-2">
                {label}
                {count !== undefined && (
                  <span className="text-xs font-normal text-muted-foreground">
                    ({count} images in split)
                  </span>
                )}
              </div>
              <div className="flex gap-2">
                {indices.map((index) => {
                  const src = sampleUrl(taskId, split, index);
                  const alt = `${label} example ${index}`;
                  return (
                    <ExampleThumbnail
                      key={`${split}-${index}`}
                      src={src}
                      alt={alt}
                      onOpen={() => openPreview(src, alt)}
                    />
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground mt-1.5">
                Up to {MAX_SAMPLES} samples · click to inspect annotations
              </p>
            </div>
          );
        })}
      </div>

      <Dialog open={!!preview} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="max-w-[min(96vw,1400px)] w-auto p-2 sm:p-3 bg-background border-border">
          <DialogTitle className="sr-only">
            {preview ? `Training example: ${preview.alt}` : "Training example preview"}
          </DialogTitle>
          {preview && (
            <img
              src={preview.src}
              alt={preview.alt}
              className="max-w-[min(92vw,1360px)] max-h-[min(88vh,900px)] w-auto h-auto object-contain mx-auto rounded-sm"
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
