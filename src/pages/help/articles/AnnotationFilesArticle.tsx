/**
 * Help article: Annotation Files
 *
 * Explains the 1:N relationship between a dataset and its annotation files,
 * how to read the metrics (Files / Instances / Classes / Formats) and what
 * the coverage matrix means with multiple image collections.
 */
import { Files, Layers, Tag, Lightbulb, AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ArticleSection, ArticleCallout } from "../components/ArticleParts";

export function AnnotationFilesArticle() {
  return (
    <article className="space-y-8 max-w-3xl">
      <header className="space-y-3">
        <Badge variant="secondary" className="gap-1.5">
          <Files className="h-3.5 w-3.5" /> Datasets
        </Badge>
        <h1 className="text-3xl font-bold tracking-tight">Annotation Files</h1>
        <p className="text-lg text-muted-foreground leading-relaxed">
          A dataset can hold many annotation files at once — different formats,
          different label sets, different modalities. This page explains what
          the numbers mean and how to read coverage when you have multiple image
          collections.
        </p>
      </header>

      <ArticleSection id="files-vs-instances" title="Files, Instances, Classes" icon={Lightbulb}>
        <ul className="list-disc pl-6 space-y-2 text-sm">
          <li>
            <strong>Files</strong> — how many annotation sets exist for this
            dataset (e.g. <em>coco_v1.json</em>, <em>yolo_seg/</em>,{" "}
            <em>masks_v2.json</em>). Each file is independent and can be
            exported, edited or merged on its own.
          </li>
          <li>
            <strong>Instances</strong> — total number of annotated objects
            across <em>all</em> files. One image with two cars contributes two
            instances. This is the "how much labeled data do I have?" number.
          </li>
          <li>
            <strong>Classes</strong> — unique labels across all files. Two files
            using the same class name share that class.
          </li>
        </ul>
      </ArticleSection>

      <ArticleSection id="formats" title="Formats and task types" icon={Tag}>
        <p className="text-sm leading-relaxed">
          Each file has a <strong>format</strong> (COCO, YOLO, Pascal VOC,
          Masks, …) and a <strong>task type</strong> (Classification,
          Segmentation, Detection). The badge next to the file name reflects
          the task type; the format is shown alongside it. A dataset with files
          of different formats is marked <em>Multi-format</em>.
        </p>
      </ArticleSection>

      <ArticleSection id="coverage" title="Coverage matrix" icon={Layers}>
        <p className="text-sm leading-relaxed">
          When a dataset has multiple <strong>image collections</strong> (e.g.
          RGB, NIR, Thermal), a single percentage like "74% complete" hides
          which collection is empty. The coverage matrix shows it directly:
        </p>
        <pre className="text-xs bg-muted/40 border border-border rounded-md p-3 overflow-x-auto leading-relaxed">
{`                    coco_v1   yolo_seg   masks_v2
RGB     (1,200)       1,200      980         0
NIR     (1,200)           0      980         0
Thermal (1,200)           0        0         0`}
        </pre>
        <p className="text-sm leading-relaxed">
          Each cell counts how many images in that collection are referenced by
          that annotation file. A dash (—) means the file does not annotate any
          image from that collection — usually expected when a file targets one
          modality.
        </p>
        <ArticleCallout tone="warn">
          We deliberately do not show a single "completion %" at the dataset
          level. Any single denominator (images? images × files? images ×
          collections?) lies for some users. Counts and the coverage matrix
          never lie.
        </ArticleCallout>
      </ArticleSection>

      <ArticleSection id="actions" title="Common actions" icon={Files}>
        <ul className="list-disc pl-6 space-y-1 text-sm">
          <li>Click the type badge to open the file in the matching editor.</li>
          <li>Use <strong>Merge</strong> to combine files of the same type into one COCO file.</li>
          <li>Use <strong>Import Annotations</strong> to add a new file — the format is auto-detected.</li>
          <li>Use the <strong>FiftyOne</strong> button to inspect any file as predictions.</li>
        </ul>
      </ArticleSection>
    </article>
  );
}
