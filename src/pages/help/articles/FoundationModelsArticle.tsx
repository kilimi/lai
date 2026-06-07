/**
 * Help article: Foundation Models
 *
 * Explains how the on-disk model volume works, how to pre-download weights,
 * and how to drop in custom .pt files.
 */
import { HardDrive, Download, Lightbulb, FolderOpen } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ArticleSection, ArticleStep, ArticleCallout } from "../components/ArticleParts";

export function FoundationModelsArticle() {
  return (
    <article className="space-y-8 max-w-3xl">
      <header className="space-y-3">
        <Badge variant="secondary" className="gap-1.5">
          <HardDrive className="h-3.5 w-3.5" /> System
        </Badge>
        <h1 className="text-3xl font-bold tracking-tight">Foundation Models</h1>
        <p className="text-lg text-muted-foreground leading-relaxed">
          LAI ships a slim Docker image — pretrained weights live on a host
          volume so you can pick exactly which ones to install, swap them
          between machines, and bring your own custom checkpoints.
        </p>
      </header>

      <ArticleSection id="layout" title="Where models live" icon={FolderOpen}>
        <p>
          Two host directories are mounted into the backend container:
        </p>
        <ul className="list-disc pl-6 space-y-1 text-sm">
          <li>
            <code className="font-mono text-xs">$LAI_DATA_DIR/models</code> →{" "}
            <code className="font-mono text-xs">/app/models</code> — YOLO/RT-DETR <code>.pt</code> files.
          </li>
          <li>
            <code className="font-mono text-xs">$LAI_DATA_DIR/ai_models</code> →{" "}
            <code className="font-mono text-xs">/app/ai_models</code> — Depth-Anything ONNX files.
          </li>
        </ul>
        <p>
          The <strong>System → Foundation Models</strong> page lists every
          known weight and tells you whether it's present on disk.
        </p>
      </ArticleSection>

      <ArticleSection id="download" title="Pre-download weights" icon={Download}>
        <ArticleStep n={1} title="Start the stack">
          Run <code className="font-mono text-xs">lai up</code> once so the backend container is alive.
        </ArticleStep>
        <ArticleStep n={2} title="Fetch the minimal set">
          <code className="font-mono text-xs">lai download-models</code> pulls
          the nano + small heads (≈1 GB). Override with{" "}
          <code className="font-mono text-xs">--yolo all --depth all</code> to grab everything.
        </ArticleStep>
        <ArticleStep n={3} title="Fetch a single weight">
          Pass the exact filename:{" "}
          <code className="font-mono text-xs">
            lai download-models --yolo yolo11n-seg.pt
          </code>
        </ArticleStep>

        <ArticleCallout tone="tip">
          You don't <em>have</em> to pre-download. Ultralytics will fetch the
          weights automatically the first time a training or auto-annotate job
          requests them — internet required.
        </ArticleCallout>
      </ArticleSection>

      <ArticleSection id="custom" title="Bring your own weights" icon={Lightbulb}>
        <p>
          Drop any <code className="font-mono text-xs">.pt</code> file into the host{" "}
          <code className="font-mono text-xs">models/</code> directory and it
          becomes available to Auto-Annotate and Train. The container picks
          them up immediately — no restart needed.
        </p>
      </ArticleSection>
    </article>
  );
}
