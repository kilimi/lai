/**
 * CompareAnnotationsDialog
 * ------------------------
 * Side-by-side diff between two annotation files.
 * Computes:
 *   - shared / only-in-A / only-in-B image sets
 *   - shared / only-in-A / only-in-B class sets with per-class instance deltas
 *   - per-image instance count diff (top movers)
 *
 * Pure client-side comparison using the in-memory `samples` of each file.
 * If samples aren't loaded, shows a hint to open the file first.
 */
import { useMemo } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ArrowRight } from "lucide-react";
import type { AnnotationFile } from "@/utils/annotations";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fileA: AnnotationFile | null;
  fileB: AnnotationFile | null;
}

function setOps<T>(a: Set<T>, b: Set<T>) {
  const shared = new Set<T>();
  const onlyA = new Set<T>();
  const onlyB = new Set<T>();
  a.forEach((x) => (b.has(x) ? shared.add(x) : onlyA.add(x)));
  b.forEach((x) => { if (!a.has(x)) onlyB.add(x); });
  return { shared, onlyA, onlyB };
}

export function CompareAnnotationsDialog({ open, onOpenChange, fileA, fileB }: Props) {
  const data = useMemo(() => {
    if (!fileA || !fileB) return null;
    const sA = fileA.samples || [];
    const sB = fileB.samples || [];

    const imgA = new Set(sA.map((s) => s.imageId));
    const imgB = new Set(sB.map((s) => s.imageId));
    const imgs = setOps(imgA, imgB);

    const classMapA = new Map<string, number>();
    const classMapB = new Map<string, number>();
    sA.forEach((s) => classMapA.set(s.className, (classMapA.get(s.className) || 0) + 1));
    sB.forEach((s) => classMapB.set(s.className, (classMapB.get(s.className) || 0) + 1));
    const classes = setOps(new Set(classMapA.keys()), new Set(classMapB.keys()));
    const allClasses = Array.from(new Set([...classMapA.keys(), ...classMapB.keys()])).sort();
    const classRows = allClasses.map((c) => {
      const a = classMapA.get(c) || 0;
      const b = classMapB.get(c) || 0;
      return { className: c, a, b, delta: b - a };
    });

    // Per-image instance counts
    const perImgA = new Map<string, number>();
    const perImgB = new Map<string, number>();
    sA.forEach((s) => perImgA.set(s.imageId, (perImgA.get(s.imageId) || 0) + 1));
    sB.forEach((s) => perImgB.set(s.imageId, (perImgB.get(s.imageId) || 0) + 1));
    const sharedImgs = Array.from(imgs.shared);
    const movers = sharedImgs
      .map((id) => ({ id, a: perImgA.get(id) || 0, b: perImgB.get(id) || 0 }))
      .map((r) => ({ ...r, delta: r.b - r.a }))
      .filter((r) => r.delta !== 0)
      .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))
      .slice(0, 10);

    return { imgs, classes, classRows, movers, sA: sA.length, sB: sB.length };
  }, [fileA, fileB]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <span className="truncate max-w-[40%]">{fileA?.name || "—"}</span>
            <ArrowRight className="h-4 w-4 text-muted-foreground" />
            <span className="truncate max-w-[40%]">{fileB?.name || "—"}</span>
          </DialogTitle>
        </DialogHeader>

        {!fileA || !fileB ? (
          <p className="text-sm text-muted-foreground py-6">Pick two annotation files to compare.</p>
        ) : !data ? null : (fileA.samples?.length || 0) + (fileB.samples?.length || 0) === 0 ? (
          <p className="text-sm text-muted-foreground py-6">
            Annotation contents aren't loaded for these files. Open each file once (eye icon) and try again.
          </p>
        ) : (
          <ScrollArea className="max-h-[65vh] pr-3">
            <div className="space-y-5 py-2">
              {/* Summary */}
              <section className="grid grid-cols-3 gap-3">
                <SummaryCard label="Instances" a={data.sA} b={data.sB} />
                <SummaryCard label="Images" a={fileA.samples ? new Set(fileA.samples.map(s=>s.imageId)).size : 0} b={fileB.samples ? new Set(fileB.samples.map(s=>s.imageId)).size : 0} />
                <SummaryCard label="Classes" a={fileA.classCount} b={fileB.classCount} />
              </section>

              {/* Images */}
              <section>
                <h4 className="text-sm font-medium mb-2">Image overlap</h4>
                <div className="flex flex-wrap gap-2 text-xs">
                  <Badge variant="secondary">Shared: {data.imgs.shared.size}</Badge>
                  <Badge variant="outline" className="border-blue-500/40 text-blue-700 dark:text-blue-300">Only in A: {data.imgs.onlyA.size}</Badge>
                  <Badge variant="outline" className="border-purple-500/40 text-purple-700 dark:text-purple-300">Only in B: {data.imgs.onlyB.size}</Badge>
                </div>
              </section>

              {/* Classes */}
              <section>
                <h4 className="text-sm font-medium mb-2">Class diff</h4>
                <div className="flex flex-wrap gap-2 mb-2 text-xs">
                  <Badge variant="secondary">Shared: {data.classes.shared.size}</Badge>
                  <Badge variant="outline" className="border-blue-500/40 text-blue-700 dark:text-blue-300">Only in A: {data.classes.onlyA.size}</Badge>
                  <Badge variant="outline" className="border-purple-500/40 text-purple-700 dark:text-purple-300">Only in B: {data.classes.onlyB.size}</Badge>
                </div>
                <div className="border border-border/60 rounded-md overflow-hidden">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/40">
                      <tr>
                        <th className="text-left px-2 py-1.5 font-medium">Class</th>
                        <th className="text-right px-2 py-1.5 font-medium w-24">A</th>
                        <th className="text-right px-2 py-1.5 font-medium w-24">B</th>
                        <th className="text-right px-2 py-1.5 font-medium w-24">Δ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.classRows.map((r) => (
                        <tr key={r.className} className="border-t border-border/40">
                          <td className="px-2 py-1 font-mono truncate">{r.className}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{r.a}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{r.b}</td>
                          <td className={"px-2 py-1 text-right tabular-nums font-medium " + (r.delta > 0 ? "text-emerald-600 dark:text-emerald-400" : r.delta < 0 ? "text-destructive" : "text-muted-foreground")}>
                            {r.delta > 0 ? "+" : ""}{r.delta}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              {/* Movers */}
              {data.movers.length > 0 && (
                <section>
                  <h4 className="text-sm font-medium mb-2">Top images by instance change</h4>
                  <div className="border border-border/60 rounded-md overflow-hidden">
                    <table className="w-full text-xs">
                      <thead className="bg-muted/40">
                        <tr>
                          <th className="text-left px-2 py-1.5 font-medium">Image ID</th>
                          <th className="text-right px-2 py-1.5 font-medium w-24">A</th>
                          <th className="text-right px-2 py-1.5 font-medium w-24">B</th>
                          <th className="text-right px-2 py-1.5 font-medium w-24">Δ</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.movers.map((m) => (
                          <tr key={m.id} className="border-t border-border/40">
                            <td className="px-2 py-1 font-mono truncate">{m.id}</td>
                            <td className="px-2 py-1 text-right tabular-nums">{m.a}</td>
                            <td className="px-2 py-1 text-right tabular-nums">{m.b}</td>
                            <td className={"px-2 py-1 text-right tabular-nums font-medium " + (m.delta > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-destructive")}>
                              {m.delta > 0 ? "+" : ""}{m.delta}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}
            </div>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SummaryCard({ label, a, b }: { label: string; a: number; b: number }) {
  const delta = b - a;
  return (
    <div className="rounded-md border border-border/60 p-3">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="flex items-baseline gap-2 mt-1">
        <span className="text-sm tabular-nums">{a.toLocaleString()}</span>
        <ArrowRight className="h-3 w-3 text-muted-foreground" />
        <span className="text-sm tabular-nums">{b.toLocaleString()}</span>
        <span className={"ml-auto text-xs tabular-nums " + (delta > 0 ? "text-emerald-600 dark:text-emerald-400" : delta < 0 ? "text-destructive" : "text-muted-foreground")}>
          {delta > 0 ? "+" : ""}{delta}
        </span>
      </div>
    </div>
  );
}
