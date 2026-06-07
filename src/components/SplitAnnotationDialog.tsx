/**
 * SplitAnnotationDialog
 * ---------------------
 * Splits a single annotation file into multiple subset files.
 *
 * Modes:
 *   - ratio   : train/val/test by image (random, seeded)
 *   - class   : one file per class
 *   - tag     : currently informative-only (per-image tags not modelled here)
 *
 * Each produced subset is a complete COCO file, uploaded back via
 * api.importAnnotations so it appears as a new entry in the file list.
 */
import { useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useToast } from "@/hooks/use-toast";
import type { AnnotationFile, AnnotationSample } from "@/utils/annotations";

type Mode = "ratio" | "class";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  file: AnnotationFile | null;
  /** Build a COCO-shaped object for a subset of samples (re-uses existing toCOCOFormat helper). */
  buildCOCO: (file: AnnotationFile, sampleSubset: AnnotationSample[], imageIdSubset?: Set<string>) => any;
  /** Upload a generated COCO file under a given name. */
  uploadFile: (name: string, coco: any) => Promise<void>;
  /** Refresh the list after upload. */
  onDone: () => void;
}

function seededShuffle<T>(arr: T[], seed: number): T[] {
  const a = arr.slice();
  let s = seed || 1;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 9301 + 49297) % 233280;
    const j = Math.floor((s / 233280) * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function SplitAnnotationDialog({ open, onOpenChange, file, buildCOCO, uploadFile, onDone }: Props) {
  const { toast } = useToast();
  const [mode, setMode] = useState<Mode>("ratio");
  const [train, setTrain] = useState(70);
  const [val, setVal] = useState(20);
  const [test, setTest] = useState(10);
  const [seed, setSeed] = useState(42);
  const [busy, setBusy] = useState(false);

  const samples = file?.samples || [];
  const imageIds = useMemo(
    () => Array.from(new Set(samples.map((s) => s.imageId))),
    [samples]
  );
  const classes = useMemo(
    () => Array.from(new Set(samples.map((s) => s.className))),
    [samples]
  );

  const ratioSum = train + val + test;
  const ratiosOk = ratioSum === 100 && train >= 0 && val >= 0 && test >= 0;

  const baseName = (file?.name || "annotations").replace(/\.[^/.]+$/, "");

  const preview = useMemo(() => {
    if (!file) return [];
    if (mode === "ratio") {
      const total = imageIds.length;
      return [
        { name: `${baseName}_train.json`, count: Math.round((train / 100) * total), label: "train images" },
        { name: `${baseName}_val.json`, count: Math.round((val / 100) * total), label: "val images" },
        { name: `${baseName}_test.json`, count: total - Math.round((train / 100) * total) - Math.round((val / 100) * total), label: "test images" },
      ].filter((p) => p.count > 0);
    }
    return classes.map((c) => ({
      name: `${baseName}_${c.replace(/[^a-z0-9_-]+/gi, "_")}.json`,
      count: samples.filter((s) => s.className === c).length,
      label: `instances of "${c}"`,
    }));
  }, [mode, train, val, classes, samples, imageIds.length, baseName, file]);

  const handleSplit = async () => {
    if (!file) return;
    if (mode === "ratio" && !ratiosOk) {
      toast({ title: "Ratios must sum to 100%", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      if (mode === "ratio") {
        const shuffled = seededShuffle(imageIds, seed);
        const nTrain = Math.round((train / 100) * shuffled.length);
        const nVal = Math.round((val / 100) * shuffled.length);
        const subsets: { suffix: string; ids: Set<string> }[] = [
          { suffix: "train", ids: new Set(shuffled.slice(0, nTrain)) },
          { suffix: "val", ids: new Set(shuffled.slice(nTrain, nTrain + nVal)) },
          { suffix: "test", ids: new Set(shuffled.slice(nTrain + nVal)) },
        ];
        for (const { suffix, ids } of subsets) {
          if (ids.size === 0) continue;
          const sub = samples.filter((s) => ids.has(s.imageId));
          const coco = buildCOCO(file, sub, ids);
          await uploadFile(`${baseName}_${suffix}.json`, coco);
        }
      } else {
        for (const cls of classes) {
          const sub = samples.filter((s) => s.className === cls);
          if (sub.length === 0) continue;
          const ids = new Set(sub.map((s) => s.imageId));
          const coco = buildCOCO(file, sub, ids);
          const safe = cls.replace(/[^a-z0-9_-]+/gi, "_");
          await uploadFile(`${baseName}_${safe}.json`, coco);
        }
      }
      toast({
        title: "Split complete",
        description: `Created ${preview.length} new annotation file${preview.length === 1 ? "" : "s"}.`,
      });
      onOpenChange(false);
      onDone();
    } catch (e) {
      toast({
        title: "Split failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Split annotation file</DialogTitle>
        </DialogHeader>
        {file && (
          <div className="space-y-4 py-2">
            <div className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{file.name}</span> ·{" "}
              {imageIds.length} images · {samples.length} instances · {classes.length} classes
            </div>

            <RadioGroup value={mode} onValueChange={(v) => setMode(v as Mode)} className="space-y-2">
              <div className="flex items-start gap-2 rounded-md border border-border/60 p-3">
                <RadioGroupItem value="ratio" id="m-ratio" className="mt-0.5" />
                <div className="flex-1">
                  <Label htmlFor="m-ratio" className="font-medium">Train / Val / Test by image</Label>
                  <p className="text-xs text-muted-foreground">Random, seeded split. Each image goes to exactly one subset.</p>
                  {mode === "ratio" && (
                    <div className="mt-3 grid grid-cols-4 gap-2">
                      <div>
                        <Label className="text-xs">Train %</Label>
                        <Input type="number" min={0} max={100} value={train} onChange={(e) => setTrain(+e.target.value || 0)} />
                      </div>
                      <div>
                        <Label className="text-xs">Val %</Label>
                        <Input type="number" min={0} max={100} value={val} onChange={(e) => setVal(+e.target.value || 0)} />
                      </div>
                      <div>
                        <Label className="text-xs">Test %</Label>
                        <Input type="number" min={0} max={100} value={test} onChange={(e) => setTest(+e.target.value || 0)} />
                      </div>
                      <div>
                        <Label className="text-xs">Seed</Label>
                        <Input type="number" value={seed} onChange={(e) => setSeed(+e.target.value || 0)} />
                      </div>
                    </div>
                  )}
                  {mode === "ratio" && !ratiosOk && (
                    <p className="text-xs text-destructive mt-2">Sum must equal 100% (currently {ratioSum}%).</p>
                  )}
                </div>
              </div>

              <div className="flex items-start gap-2 rounded-md border border-border/60 p-3">
                <RadioGroupItem value="class" id="m-class" className="mt-0.5" />
                <div className="flex-1">
                  <Label htmlFor="m-class" className="font-medium">One file per class</Label>
                  <p className="text-xs text-muted-foreground">
                    Produces {classes.length} new file{classes.length === 1 ? "" : "s"} — useful for per-class training or review.
                  </p>
                </div>
              </div>
            </RadioGroup>

            <div className="rounded-md bg-muted/40 p-3">
              <div className="text-xs font-medium mb-1">Preview</div>
              <div className="space-y-1">
                {preview.map((p) => (
                  <div key={p.name} className="text-xs flex items-center justify-between">
                    <span className="font-mono truncate">{p.name}</span>
                    <span className="text-muted-foreground tabular-nums">
                      {p.count.toLocaleString()} {p.label}
                    </span>
                  </div>
                ))}
                {preview.length === 0 && (
                  <div className="text-xs text-muted-foreground">Nothing to split.</div>
                )}
              </div>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={handleSplit} disabled={busy || !file || preview.length === 0}>
            {busy ? "Splitting…" : `Create ${preview.length} file${preview.length === 1 ? "" : "s"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
